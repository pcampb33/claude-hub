// Live-session core: efficient transcript-tail reading and per-session
// status derivation. Electron-free — same discipline as floor-core.ts, so
// electron/live.ts composes it and node --test exercises it directly.
// Transcript facts this leans on (spot-checked against real files):
// every line has a `timestamp`; assistant lines carry `message.model`, a
// `message.usage` block and tool_use content blocks; `ai-title` lines hold
// a human session title; `turn_duration` / `stop_hook_summary` system
// lines mark end-of-turn; the trailing line may be partially written.
import fs from 'node:fs'
import path from 'node:path'
import { listProjects } from './registry.ts'
import { findSessionDirs } from './status.ts'
import { pruneActivityCache, readSessionActivity } from './session-activity-core.ts'
import { claudeSessionsDir, pidAlive, readClaudeProcesses, type ClaudeProcess, type ClaudeProcessRead } from './desktop-outside.ts'
import type {
  LiveProjectStatus,
  LiveSessionState,
  LiveStatusSnapshot,
  RecentTurn,
  SessionActivity,
} from '../shared/ipc-types.ts'

// 256K, not 64K: the tail is also where recentTurns come from, and a heavy
// tool-result turn can be tens of KB — 64K starved the hero's context
// sparkline down to a handful of points (sometimes one) on busy sessions.
// Cost check: ~14 projects × 256K per 5s poll is still trivial to read+parse.
export const TAIL_BYTES = 256 * 1024
export const HEAD_BYTES = 64 * 1024
// How many recent assistant turns feed the turns-of-room estimate.
export const RECENT_TURNS = 24
// A session counts as live if its last user/assistant line is this recent.
// NOT the file's mtime: Claude Code appends timestamp-free bookkeeping
// (`cost-state`, `last-prompt`, `bridge-session`, `artifact-*-ledger`) when a
// terminal closes or a watcher ticks, days after the last real turn. Nine of
// ten Rational transcripts had an mtime hours-to-days past their last turn,
// and one graded `active` the morning its two-day-idle terminal was closed.
export const ACTIVE_WINDOW_MS = 5 * 60 * 1000

// Read the last `maxBytes` of a .jsonl without ever loading the whole
// multi-MB file: seek from the end, split lines, drop the first line when
// the read started mid-file (it's almost certainly partial).
export function readJsonlTail(filePath: string, maxBytes = TAIL_BYTES): string[] {
  const fd = fs.openSync(filePath, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf-8').split('\n')
    if (start > 0) lines.shift()
    return lines.filter((line) => line.trim().length > 0)
  } finally {
    fs.closeSync(fd)
  }
}

// The tail that every state derivation needs: one that reaches back to at least
// one user/assistant line. Claude Code (2.1.2xx+) logs each API request as an
// `api-request-blob` line carrying the whole system prompt — ~400KB on a fresh
// session — between the prompt and the reply, so mid-turn a fixed 256KB tail
// can hold nothing but blobs and read as "nobody was here". Widen until an
// activity line is in view, up to a cap; past the cap the caller sees what's
// there and derives as before.
const ACTIVITY_WINDOWS = [TAIL_BYTES, 2 * 1024 * 1024, 8 * 1024 * 1024]
const ACTIVITY_LINE = /"type":"(user|assistant)"/

export function readActivityTail(filePath: string): string[] {
  let lines: string[] = []
  for (const bytes of ACTIVITY_WINDOWS) {
    lines = readJsonlTail(filePath, bytes)
    if (lines.some((line) => ACTIVITY_LINE.test(line))) return lines
    if (fs.statSync(filePath).size <= bytes) return lines // the whole file was read
  }
  return lines
}

// Read the first `maxBytes` of a .jsonl — mirror of readJsonlTail from the
// other end. The opening `mode` / `file-history-snapshot` lines carry no
// timestamp, so sessionStart needs a few lines of head, not just line 0.
// Drop the trailing line when the file is bigger than the read (it's cut
// mid-line); the first line always starts at byte 0 so it's never partial.
export function readJsonlHead(filePath: string, maxBytes = HEAD_BYTES): string[] {
  const fd = fs.openSync(filePath, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, maxBytes)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, 0)
    const lines = buf.toString('utf-8').split('\n')
    if (size > maxBytes) lines.pop()
    return lines.filter((line) => line.trim().length > 0)
  } finally {
    fs.closeSync(fd)
  }
}

// Session start = the first transcript line that carries a timestamp. The
// opening metadata lines (`mode`, `file-history-snapshot`) have none, so
// scan past them to the first real event.
export function firstTimestamp(lines: string[]): string | undefined {
  for (const line of parseLines(lines)) {
    if (typeof line.timestamp === 'string') return line.timestamp
  }
  return undefined
}

// Approximate model → context-window map, matched by substring of the
// model id. Deliberately tiny and coarse — it only scales the UI's
// context-pressure gauge, never any decision logic.
const APPROX_CONTEXT_LIMITS: { match: string; limit: number }[] = [
  { match: 'haiku', limit: 200_000 }, // Haiku is the 200K exception
  { match: 'fable', limit: 1_000_000 }, // Fable/Mythos/Opus 4.6+/Sonnet 5+ all ship a 1M window
  { match: 'mythos', limit: 1_000_000 },
  { match: 'opus', limit: 1_000_000 },
  { match: 'sonnet', limit: 1_000_000 },
]
export const DEFAULT_CONTEXT_LIMIT = 200_000

export function contextLimitFor(model: string | undefined): number {
  if (!model) return DEFAULT_CONTEXT_LIMIT
  const lower = model.toLowerCase()
  return APPROX_CONTEXT_LIMITS.find((e) => lower.includes(e.match))?.limit ?? DEFAULT_CONTEXT_LIMIT
}

export interface LiveSessionStatus {
  state: LiveSessionState
  lastToolName?: string
  waitingFor?: string
  lastTimestamp?: string
  // Timestamp of the newest user/assistant line — the only thing that means
  // "someone was here"; system/bookkeeping lines never advance it.
  lastActivityAt?: string
  sessionStart?: string
  model?: string
  aiTitle?: string
  contextPct?: number
  contextTokens?: number
  contextLimit?: number
  recentTurns?: RecentTurn[]
  // Timestamp of the newest stop_hook_summary whose hookErrors is
  // non-empty — live.ts compares it across recomputes to fire the
  // "hook failed" notification exactly once per failure.
  latestHookErrorAt?: string
  activity?: SessionActivity
  activityError?: string
}

// Loose view of a transcript line — only the fields this module reads.
interface RawLine {
  type?: string
  subtype?: string
  timestamp?: string
  aiTitle?: string
  hookErrors?: unknown[]
  isMeta?: boolean
  isCompactSummary?: boolean
  message?: {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
    content?: unknown
  }
}

// Same defensive per-line parse idiom as floor-core's parseLedgerLines —
// sessions are append-only and the last line may be mid-write, so a
// malformed line is skipped, never allowed to poison the rest.
function parseLines(lines: string[]): RawLine[] {
  const parsed: RawLine[] = []
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as RawLine)
    } catch {
      continue
    }
  }
  return parsed
}

// User lines nobody typed to the model: the /clear caveat (isMeta), a
// compaction summary, and a local command with its output. None is a turn,
// so none closes with turn_duration. Counted as activity, each held an idle
// session 'active' for 5 minutes (39 times, 2026-09-01..11-02).
function isActivity(line: RawLine): boolean {
  if (line.type === 'assistant') return true
  if (line.type !== 'user' || line.isMeta || line.isCompactSummary) return false
  const content = line.message?.content
  return !(typeof content === 'string' && /^<(command-name|local-command-)/.test(content))
}

// What Claude Code's own per-process record (~/.claude/sessions/<pid>.json)
// says about the process holding a session. 'none' = no live process holds
// it; 'unreadable' = the records couldn't all be read, so absence proves
// nothing and the transcript has to stand in.
export type SessionProcess =
  | { kind: 'running'; status: ClaudeProcess['status']; waitingFor: string | null }
  | { kind: 'none' }
  | { kind: 'unreadable' }

export function sessionProcessLookup(read: ClaudeProcessRead): (sessionId: string) => SessionProcess {
  if (!read.ok || read.error) return () => ({ kind: 'unreadable' })
  const bySession = new Map(read.processes.map((p) => [p.sessionId, p]))
  return (sessionId) => {
    const p = bySession.get(sessionId)
    return p ? { kind: 'running', status: p.status, waitingFor: p.waitingFor } : { kind: 'none' }
  }
}

export const readSessionProcesses = () => sessionProcessLookup(readClaudeProcesses(claudeSessionsDir(), pidAlive))

// Transcript-only fallback, used only when the process records can't be read.
// Measured over 109 real sessions (2026-09-01..11-02): every open turn that
// went quiet past 5 minutes sat on an unanswered tool call, either
// AskUserQuestion (18), a shell command still inside its own timeout (~22), or
// one past it, i.e. a permission prompt (~5). Never on the model thinking.
// A dead process looks the same as a waiting one here, hence the cap.
export const FALLBACK_WAIT_CAP_MS = 24 * 60 * 60 * 1000
const SHELL_DEFAULT_TIMEOUT_MS = 120_000

function toolTimeoutMs(block: { name?: string; input?: { timeout?: unknown } }): number {
  if (block.name !== 'Bash' && block.name !== 'PowerShell') return 0
  const t = block.input?.timeout
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : SHELL_DEFAULT_TIMEOUT_MS
}

export function deriveLiveSessionStatus(
  tailLines: string[],
  nowMs: number,
  sessionStart?: string,
  proc: SessionProcess = { kind: 'unreadable' },
): LiveSessionStatus {
  const parsed = parseLines(tailLines)
  const status: LiveSessionStatus = { state: 'ended', sessionStart }

  let lastActivityIndex = -1
  let lastTurnCloseIndex = -1
  const turns: RecentTurn[] = []
  let lastTurnId: string | undefined
  // Tool calls of the open turn with no tool_result yet, by tool_use id.
  const pending = new Map<string, { name: string; timeoutMs: number }>()

  parsed.forEach((line, i) => {
    if (typeof line.timestamp === 'string') status.lastTimestamp = line.timestamp
    if (isActivity(line)) {
      lastActivityIndex = i
      if (typeof line.timestamp === 'string') status.lastActivityAt = line.timestamp
    }
    const content = line.message?.content
    if (line.type === 'user' && Array.isArray(content)) {
      for (const block of content as { type?: string; tool_use_id?: string }[]) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') pending.delete(block.tool_use_id)
      }
    }
    if (line.type === 'assistant' && Array.isArray(content)) {
      for (const block of content as { type?: string; id?: string; name?: string; input?: { timeout?: unknown } }[]) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          pending.set(block.id, { name: block.name ?? 'a tool', timeoutMs: toolTimeoutMs(block) })
        }
      }
    }
    if (line.type === 'system' && (line.subtype === 'turn_duration' || line.subtype === 'stop_hook_summary')) {
      lastTurnCloseIndex = i
      pending.clear()
      if (line.subtype === 'stop_hook_summary' && Array.isArray(line.hookErrors) && line.hookErrors.length > 0) {
        status.latestHookErrorAt = typeof line.timestamp === 'string' ? line.timestamp : ''
      }
    }
    if (line.type === 'ai-title' && typeof line.aiTitle === 'string') status.aiTitle = line.aiTitle
    if (line.type === 'assistant' && line.message) {
      const { id, model, usage, content } = line.message
      // Claude Code stamps "<synthetic>" on assistant turns it wrote itself
      // (an API error, an interrupt). That is the absence of a model, not the
      // name of one, so it must not reach the UI — a session whose only turns
      // are synthetic keeps `model` undefined and renders like one that never
      // named a model, which is the truth.
      if (typeof model === 'string' && model !== '<synthetic>') status.model = model
      let usedTool = false
      if (Array.isArray(content)) {
        for (const block of content as { type?: string; name?: string }[]) {
          if (block.type === 'tool_use') {
            usedTool = true
            if (typeof block.name === 'string') status.lastToolName = block.name
          }
        }
      }
      if (usage) {
        const tokens =
          (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        // Carry the raw count and the model's own limit, not just the pct —
        // the same token count is a different % on a [1m] vs a 200k model.
        status.contextTokens = tokens
        status.contextLimit = contextLimitFor(model)
        status.contextPct = Math.min(100, Math.round((tokens / status.contextLimit) * 100))
        // One waveform bar per assistant RESPONSE: Claude Code writes several
        // transcript lines per response (shared message.id, identical
        // output_tokens/usage), so collapse consecutive lines of the same id
        // into one bar — tool=true if any line in the response called a tool.
        // input = the response's real per-turn input cost (the same `tokens`
        // sum that feeds contextTokens); same-id lines carry identical usage,
        // so overwriting keeps the collapsed bar honest, never double-counted.
        const last = turns[turns.length - 1]
        if (id && id === lastTurnId && last) {
          if (usedTool) last.tool = true
          last.output = usage.output_tokens ?? last.output
          last.input = tokens
        } else {
          turns.push({ output: usage.output_tokens ?? 0, input: tokens, tool: usedTool })
          lastTurnId = id
        }
      }
    }
  })

  if (turns.length > 0) status.recentTurns = turns.slice(-RECENT_TURNS)

  // No timestamped activity in the tail is "nobody was here", not "unknown":
  // a real turn always writes a timestamped user/assistant line.
  const activityMs = status.lastActivityAt ? Date.parse(status.lastActivityAt) : NaN
  const recent = Number.isFinite(activityMs) && nowMs - activityMs < ACTIVE_WINDOW_MS
  const turnClosed = lastTurnCloseIndex > lastActivityIndex
  status.state = !recent ? 'ended' : turnClosed ? 'idle' : 'active'
  if (turnClosed || lastActivityIndex < 0) return status

  // The turn is open. Claude Code's own record outranks five minutes of
  // transcript silence: 'waiting' while a dialog blocks the turn, 'busy'
  // through a 40-minute build. Its other statuses (idle after an Esc, say)
  // leave the transcript's answer standing. No live process: never waiting.
  if (proc.kind === 'running') {
    if (proc.status === 'waiting') {
      status.state = 'waiting'
      status.waitingFor = proc.waitingFor ?? 'a prompt'
    } else if (proc.status === 'busy') {
      status.state = 'active'
    }
  } else if (proc.kind === 'unreadable' && pending.size > 0) {
    const quietMs = nowMs - activityMs
    if (quietMs < FALLBACK_WAIT_CAP_MS) {
      const tools = [...pending.values()]
      const question = tools.find((t) => t.name === 'AskUserQuestion')
      const deadline = Math.max(...tools.map((t) => t.timeoutMs)) + ACTIVE_WINDOW_MS
      if (question || quietMs > deadline) {
        status.state = 'waiting'
        // Inferred, and it says so: the same transcript fits a process that died.
        status.waitingFor = `${question ? 'an answer' : `approval for ${tools[0].name}?`} (from the transcript; the session records couldn't be read)`
      } else {
        status.state = 'active'
      }
    }
  }
  return status
}

// The hub's own automation writes transcripts into the very project dirs this
// module scans: the curate hook at SessionEnd, and the recall hook's detached
// worker DURING a session. Each is a headless `claude -p` run whose transcript
// has no assistant lines at all, so deriving live status from one renders a
// running session with no model, no context and a flat sparkline until the real
// session writes again — an intermittent, self-healing blank that looks like the
// live data broke. Every other enumerator over these files already skips them
// (session-search, latest-sessions, session-list-core); this one didn't.
// Same rule as isHeadlessSession(), just sync, because the live poll is sync.
const ENTRYPOINT_PROBE_BYTES = 1024 * 1024

// The live sweep re-probes every hook transcript newer than a project's newest
// real session, each up to 1MB, every second or two while sessions write. A
// transcript is append-only, so a found marker never changes; only found
// markers are cached, keyed with the size they were read at (a smaller file
// is a different file). No marker yet is not cached: it means "not yet".
const headlessVerdicts = new Map<string, { size: number; headless: boolean }>()

export function isHeadlessTranscript(file: string): boolean {
  const size = fs.statSync(file).size
  const known = headlessVerdicts.get(file)
  if (known && size >= known.size) return known.headless
  // The marker sits on the first user-role line. A hook transcript opens with
  // one enormous prompt line, which the default 64K head can slice in half —
  // so an inconclusive first probe is retried wider before giving up.
  for (const bytes of [HEAD_BYTES, ENTRYPOINT_PROBE_BYTES]) {
    for (const line of readJsonlHead(file, bytes)) {
      try {
        const parsed = JSON.parse(line) as { entrypoint?: string }
        if (typeof parsed.entrypoint === 'string') {
          const headless = parsed.entrypoint === 'sdk-cli'
          headlessVerdicts.set(file, { size, headless })
          return headless
        }
      } catch {
        // Partial or non-JSON line — keep looking.
      }
    }
  }
  return false // no marker found: treat as a real session rather than hide it
}

function newestSessionFile(projectPath: string): { file: string; mtimeMs: number } | null {
  const candidates: Array<{ file: string; mtimeMs: number }> = []
  for (const dir of findSessionDirs(projectPath)) {
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const file = path.join(dir, entry)
      let stat: fs.Stats
      try {
        stat = fs.statSync(file)
      } catch {
        continue // deleted between readdir and stat
      }
      if (!stat.isFile()) continue
      candidates.push({ file, mtimeMs: stat.mtimeMs })
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  // Newest first, skipping the hub's own headless runs. Only the files ahead of
  // the first real session are probed, which is normally none.
  for (const candidate of candidates) {
    if (!isHeadlessTranscript(candidate.file)) return candidate
  }
  return null
}

// The session id travels alongside the status because only this function
// knows which file the status came from — it is the transcript's basename.
type ProjectLiveStatus = { entry: { id: string; name: string }; status: LiveSessionStatus; sessionId?: string }

export function computeStatuses(): Map<string, ProjectLiveStatus> {
  const now = Date.now()
  const result = new Map<string, ProjectLiveStatus>()
  const activityFiles = new Set<string>()
  const processFor = readSessionProcesses()
  for (const entry of listProjects()) {
    const newest = newestSessionFile(entry.path)
    let status: LiveSessionStatus = { state: 'ended' }
    if (newest) {
      try {
        const sessionStart = firstTimestamp(readJsonlHead(newest.file))
        status = deriveLiveSessionStatus(readActivityTail(newest.file), now, sessionStart, processFor(path.basename(newest.file, '.jsonl')))
      } catch {
        // File vanished mid-read (session cleanup) — treat as ended.
      }
      // The whole-transcript timeline, for live sessions only: incremental
      // and cached by size+mtime, so an unchanged file costs one stat.
      if (status.state !== 'ended') {
        activityFiles.add(newest.file)
        try {
          status.activity = readSessionActivity(newest.file)
        } catch (err) {
          status.activityError = err instanceof Error ? err.message : String(err)
        }
      }
    }
    result.set(entry.id, {
      entry: { id: entry.id, name: entry.name },
      status,
      sessionId: newest ? path.basename(newest.file, '.jsonl') : undefined,
    })
  }
  pruneActivityCache(activityFiles)
  return result
}

export interface LiveNotification {
  title: string
  body: string
}

// Which native notifications a sweep should fire, as a pure function of the
// previous statuses and the new ones. Extracted from live.ts so it sits under
// tests — live.ts imports `electron` for Tray/Notification and cannot be
// loaded outside it, which left these two rules unchecked.
//
// Three rules, and they differ on purpose. A turn ending, or a turn coming to
// wait on you, is worth a ping only when the window is not already in front of
// you; a session the Desktop runs is skipped for the second, since the Desktop
// sends its own "needs you". A hook failure ALWAYS pings: it is otherwise
// entirely silent, which is the failure mode the curate hook's own logfile
// exists to make visible.
const inUse = (state: LiveSessionState | undefined) => state === 'active' || state === 'waiting'

export function notificationsFor(
  // null before the first sweep. Startup state must never fire notifications —
  // every session would announce itself the moment the app opened.
  prev: Map<string, LiveSessionStatus> | null,
  statuses: ReturnType<typeof computeStatuses>,
  windowFocused: boolean,
  desktopSessionIds: ReadonlySet<string> = new Set(),
): LiveNotification[] {
  if (!prev) return []
  const out: LiveNotification[] = []
  for (const [id, { entry, status, sessionId }] of statuses) {
    const before = prev.get(id)
    if (inUse(before?.state) && !inUse(status.state) && !windowFocused) {
      out.push({
        title: `Session ended — ${entry.name}`,
        body: status.aiTitle ?? status.lastToolName ?? 'Turn complete',
      })
    }
    const desktopOwned = sessionId !== undefined && desktopSessionIds.has(sessionId)
    if (status.state === 'waiting' && before?.state !== 'waiting' && !windowFocused && !desktopOwned) {
      out.push({ title: `${entry.name} needs you`, body: status.waitingFor ?? status.aiTitle ?? 'Waiting on you' })
    }
    if (status.latestHookErrorAt && status.latestHookErrorAt !== before?.latestHookErrorAt) {
      out.push({ title: `Hook failed in ${entry.name}`, body: status.aiTitle ?? 'A Stop hook reported errors' })
    }
  }
  return out
}

export function toSnapshot(statuses: ReturnType<typeof computeStatuses>): LiveStatusSnapshot {
  const projects: LiveProjectStatus[] = []
  for (const { entry, status, sessionId } of statuses.values()) {
    projects.push({
      registryId: entry.id,
      name: entry.name,
      sessionId,
      state: status.state,
      lastToolName: status.lastToolName,
      waitingFor: status.waitingFor,
      lastTimestamp: status.lastTimestamp,
      sessionStart: status.sessionStart,
      model: status.model,
      aiTitle: status.aiTitle,
      contextPct: status.contextPct,
      contextTokens: status.contextTokens,
      contextLimit: status.contextLimit,
      recentTurns: status.recentTurns,
      activity: status.activity,
      activityError: status.activityError,
    })
  }
  return { projects, updatedAt: new Date().toISOString() }
}

// Pull handler (live:get) — fresh compute, no notification side effects.
export function getLiveSnapshot(): LiveStatusSnapshot {
  return toSnapshot(computeStatuses())
}
