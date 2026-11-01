// Where a session's wall-clock time went, from its WHOLE transcript — not the
// tail live-core reads. Electron-free: live-core.ts calls it, node --test
// exercises it directly.
//
// Every gap between two consecutive main-chain lines (user / assistant /
// system) gets exactly one kind, so the segments plus the compressed breaks
// sum to the wall span with nothing lost or double-counted:
//   - a tool_use awaiting its tool_result → that tool's category ('waiting'
//     when the result records that YOU made the permission call)
//   - from the last assistant line of a turn to the next real prompt → 'waiting'
//   - from the last assistant line of a turn to an agent/task notification
//     that arrived before you did → 'background'
//   - anything else (prompt or tool result → next line) → 'thinking'
// A real prompt is a user line that is not a tool result, not isMeta, not
// local-command output or an interrupt marker; a slash command counts when
// the model answered it. Subagents write their own subagents/*.jsonl, so the
// main file has no sidechain lines; isSidechain is skipped anyway.
//
// Reading is incremental per file: the parsed events and the byte offset are
// kept, a grown file is read from where the last read stopped, and a file
// that shrank is re-read from the start. api-request-blob lines (~400KB of
// system prompt each) are dropped by a prefix check before any JSON.parse.
import fs from 'node:fs'
import type {
  ActivityBreak,
  ActivityKind,
  ActivityNow,
  ActivitySegment,
  SessionActivity,
  ToolCategory,
} from '../shared/ipc-types.ts'

export const BREAK_MS = 2 * 3600_000 // a longer gap is drawn as a break, not to scale
export const WINDOW_MS = 6 * 3600_000 // the returned timeline covers this much wall time
export const MAX_SEGMENTS = 200
const CHUNK_BYTES = 4 * 1024 * 1024

export function toolCategory(name: string): ToolCategory {
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'edit'
  if (['Bash', 'PowerShell', 'BashOutput', 'KillShell'].includes(name)) return 'shell'
  if (['Read', 'Grep', 'Glob', 'NotebookRead', 'LS'].includes(name)) return 'read'
  if (['Agent', 'Task'].includes(name)) return 'agent'
  if (['WebFetch', 'WebSearch'].includes(name) || /browser|playwright/i.test(name)) return 'web'
  return 'other'
}

interface Tool {
  id: string
  name: string
  cat: ToolCategory
  target: string
  file?: string // normalized, lowercased path for an edit
}

type EventKind =
  | 'assistant'
  | 'tool_result'
  | 'prompt'
  | 'cmd' // slash command: a prompt only if the model answers it (resolved at classify time)
  | 'trigger' // agent hand-back or task notification
  | 'other_user'
  | 'system'
  | 'compact'
  | 'turn_close'

interface Ev {
  ts: number
  kind: EventKind
  meta?: boolean
  interrupt?: boolean
  tools?: Tool[]
  results?: string[]
  perm?: boolean // this tool_result's permission was decided by the user
}

export interface ParseState {
  events: Ev[]
  maxTs: number
  cwd?: string
  seenTools: Set<string>
}

export const newParseState = (): ParseState => ({ events: [], maxTs: -Infinity, seenTools: new Set() })

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

// A file inside the project reads relative to it; one outside keeps only its
// last two segments, since the tail is the part that says which file.
function fileTarget(raw: string, cwd: string | undefined): string {
  const n = norm(raw)
  const root = cwd ? norm(cwd) : undefined
  if (root && n.toLowerCase().startsWith(root.toLowerCase() + '/')) return n.slice(root.length + 1)
  const parts = n.split('/')
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : n
}

function targetOf(input: Record<string, unknown>, cwd: string | undefined): string {
  const file = input.file_path ?? input.notebook_path
  if (typeof file === 'string') return fileTarget(file, cwd)
  const pick = input.command ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.skill
  return (typeof pick === 'string' ? pick : '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: { text?: unknown }) => (typeof b?.text === 'string' ? b.text : '')).join('') : ''

interface RawLine {
  type?: string
  subtype?: string
  timestamp?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  isVisibleInTranscriptOnly?: boolean
  cwd?: string
  origin?: { kind?: string }
  permissionDecision?: { source?: string }
  message?: { content?: unknown }
}

function userKind(o: RawLine): { kind: EventKind; interrupt?: boolean } {
  const c = o.message?.content
  if (o.origin?.kind && o.origin.kind !== 'human') return { kind: 'trigger' }
  const t = textOf(c).trimStart()
  if (t.startsWith('<task-notification')) return { kind: 'trigger' }
  if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return { kind: 'other_user' }
  if (t.startsWith('[Request interrupted')) return { kind: 'other_user', interrupt: true }
  if (t.startsWith('<command-')) return { kind: 'cmd' }
  // `!` bash mode runs a command in the user's shell; the model never sees a turn.
  if (/^<(local-command-|bash-input|bash-stdout|bash-stderr)/.test(t)) return { kind: 'other_user' }
  return { kind: 'prompt' }
}

const MAIN_TYPE = /"type":"(user|assistant|system)"/

// One transcript line into the parse state. Lines that can't matter are
// rejected before JSON.parse: the request blobs by prefix, and anything that
// doesn't mention a main-chain type at all (bookkeeping, attachments).
export function ingestLine(st: ParseState, line: string): void {
  if (line.startsWith('{"type":"api-request-blob"')) return
  if (!MAIN_TYPE.test(line)) return
  let o: RawLine
  try {
    o = JSON.parse(line) as RawLine
  } catch {
    return // partial or malformed: skipped, never allowed to poison the rest
  }
  if (o.type !== 'user' && o.type !== 'assistant' && o.type !== 'system') return
  if (o.isSidechain) return
  if (st.cwd === undefined && typeof o.cwd === 'string') st.cwd = o.cwd
  const raw = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
  if (!Number.isFinite(raw)) return
  // Clamp to monotonic: a line stamped earlier than one before it would
  // otherwise make a negative gap and break the exact-sum accounting.
  st.maxTs = Math.max(st.maxTs, raw)
  const ev: Ev = { ts: st.maxTs, kind: 'system' }
  if (o.isMeta) ev.meta = true
  const content = o.message?.content
  if (o.type === 'assistant') {
    ev.kind = 'assistant'
    if (Array.isArray(content)) {
      for (const b of content as { type?: string; id?: string; name?: string; input?: Record<string, unknown> }[]) {
        if (b?.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue
        if (st.seenTools.has(b.id)) continue
        st.seenTools.add(b.id)
        const input = b.input ?? {}
        const cat = toolCategory(b.name)
        const tool: Tool = { id: b.id, name: b.name, cat, target: targetOf(input, st.cwd) }
        const fp = input.file_path ?? input.notebook_path
        if (cat === 'edit' && typeof fp === 'string') tool.file = norm(fp).toLowerCase()
        ev.tools ??= []
        ev.tools.push(tool)
      }
    }
  } else if (o.type === 'user') {
    const results = Array.isArray(content)
      ? (content as { type?: string; tool_use_id?: string }[]).filter((b) => b?.type === 'tool_result')
      : []
    if (results.length > 0) {
      ev.kind = 'tool_result'
      ev.results = results.map((b) => String(b.tool_use_id))
      if (String(o.permissionDecision?.source ?? '').startsWith('user')) ev.perm = true
    } else {
      const k = userKind(o)
      ev.kind = k.kind
      if (k.interrupt) ev.interrupt = true
    }
  } else {
    ev.kind =
      o.subtype === 'compact_boundary'
        ? 'compact'
        : o.subtype === 'turn_duration' || o.subtype === 'stop_hook_summary'
          ? 'turn_close'
          : 'system'
  }
  st.events.push(ev)
}

export function parseTranscript(text: string): ParseState {
  const st = newParseState()
  for (const line of text.split('\n')) {
    const l = line.trimEnd()
    if (l) ingestLine(st, l)
  }
  return st
}

const dur = (s: { startMs: number; endMs: number }) => s.endMs - s.startMs

// Full-session accounting: in-session segments (gaps ≤ BREAK_MS, adjacent
// same-kind merged) and breaks, which together cover [first, last] exactly.
export function classify(events: Ev[]): {
  segments: ActivitySegment[]
  breaks: ActivityBreak[]
  now?: ActivityNow
} {
  const n = events.length
  const kinds = events.map((e) => e.kind)
  // A slash command is a prompt when the model answers it (/handoff, a
  // skill); /clear, /model etc. get no assistant line and are not.
  for (let j = 0; j < n; j++) {
    if (kinds[j] !== 'cmd') continue
    let q = j + 1
    while (q < n && (kinds[q] === 'system' || kinds[q] === 'turn_close' || events[q].meta || kinds[q] === 'other_user')) q++
    kinds[j] = q < n && kinds[q] === 'assistant' ? 'prompt' : 'other_user'
  }

  // From the turn's last assistant line to the prompt (or notification)
  // that ended the quiet.
  const waitMark: (ActivityKind | null)[] = new Array(Math.max(0, n - 1)).fill(null)
  let lastA = -1
  for (let j = 0; j < n; j++) {
    const k = kinds[j]
    if (k === 'assistant') lastA = j
    else if ((k === 'prompt' || k === 'trigger') && lastA >= 0) {
      for (let q = lastA; q < j; q++) waitMark[q] ??= k === 'prompt' ? 'waiting' : 'background'
      lastA = -1
    }
  }

  const permIds = new Set<string>()
  for (const e of events) if (e.perm) for (const id of e.results ?? []) permIds.add(id)

  const outstanding = new Map<string, { tool: Tool; ts: number }>()
  const segments: ActivitySegment[] = []
  const breaks: ActivityBreak[] = []
  for (let k = 0; k < n; k++) {
    const ev = events[k]
    const kind = kinds[k]
    if (kind === 'assistant') for (const t of ev.tools ?? []) outstanding.set(t.id, { tool: t, ts: ev.ts })
    if (kind === 'tool_result') for (const id of ev.results ?? []) outstanding.delete(id)
    if (kind === 'prompt' || kind === 'compact') outstanding.clear() // a prompt interrupts anything still pending
    if (k === n - 1) break
    const start = ev.ts
    const end = events[k + 1].ts
    if (end <= start) continue
    let cat: ActivityKind
    if (outstanding.size > 0) {
      const oldest = outstanding.values().next().value!
      cat = permIds.has(oldest.tool.id) ? 'waiting' : oldest.tool.cat
    } else cat = waitMark[k] ?? 'thinking'
    if (end - start > BREAK_MS) {
      breaks.push({ startMs: start, endMs: end })
      continue
    }
    const prev = segments[segments.length - 1]
    if (prev && prev.kind === cat && prev.endMs === start) prev.endMs = end
    else segments.push({ startMs: start, endMs: end, kind: cat })
  }

  if (n === 0) return { segments, breaks }

  // State at the newest line.
  let lastTool: Tool | undefined
  for (let j = n - 1; j >= 0 && !lastTool; j--) lastTool = events[j].tools?.[events[j].tools!.length - 1]
  const tail = lastTool ? { tool: lastTool.name, target: lastTool.target } : {}
  let now: ActivityNow
  if (outstanding.size > 0) {
    const newest = [...outstanding.values()].pop()!
    now = { state: 'running', cat: newest.tool.cat, tool: newest.tool.name, target: newest.tool.target, sinceMs: newest.ts }
  } else {
    let lastAssistant = -1
    let lastWork = -1 // something that sets the model working again
    let closed = -1 // a turn-close line or an interrupt marker
    for (let j = 0; j < n; j++) {
      if (kinds[j] === 'assistant') lastAssistant = j
      else if (kinds[j] === 'prompt' || kinds[j] === 'trigger' || kinds[j] === 'tool_result') lastWork = j
      else if (kinds[j] === 'turn_close' || events[j].interrupt) closed = j
    }
    if (closed > lastAssistant && closed > lastWork) {
      // A closed turn waits from its last reply; an interrupt from the marker.
      const since = events[closed].interrupt || lastAssistant < 0 ? events[closed].ts : events[lastAssistant].ts
      now = { state: 'waiting', sinceMs: since, ...tail }
    } else if (lastWork > lastAssistant) now = { state: 'thinking', sinceMs: events[lastWork].ts, ...tail }
    else now = { state: 'thinking', sinceMs: events[Math.max(0, lastAssistant)].ts, ...tail }
  }
  return { segments, breaks, now }
}

// Coarsen to ≤ max segments without changing the span: a segment shorter
// than `min` is absorbed by its contiguous neighbour (which grows by exactly
// its duration). The threshold doubles until the count fits; contiguous runs
// only end at breaks, so this always terminates.
export function coarsen(segments: ActivitySegment[], max = MAX_SEGMENTS): ActivitySegment[] {
  let out = segments.map((s) => ({ ...s }))
  const span = out.reduce((a, s) => a + dur(s), 0)
  let min = span / (max * 4)
  // The span bound is a backstop: past it every contiguous run is already one
  // segment, and a hang here would freeze the main process's poll.
  while (out.length > max && min <= span * 2) {
    const next: ActivitySegment[] = []
    for (const s of out) {
      const prev = next[next.length - 1]
      if (prev && prev.endMs === s.startMs) {
        if (prev.kind === s.kind || dur(s) < min) {
          prev.endMs = s.endMs
          continue
        }
        if (dur(prev) < min) {
          prev.endMs = s.endMs
          prev.kind = s.kind
          continue
        }
      }
      next.push({ ...s })
    }
    out = next
    min *= 2
  }
  return out
}

function clip<T extends { startMs: number; endMs: number }>(items: T[], from: number): T[] {
  return items.filter((s) => s.endMs > from).map((s) => (s.startMs < from ? { ...s, startMs: from } : s))
}

export function buildActivity(st: ParseState, windowMs = WINDOW_MS, max = MAX_SEGMENTS): SessionActivity {
  const { events } = st
  const { segments, breaks, now } = classify(events)
  const startMs = events.length ? events[0].ts : 0
  const endMs = events.length ? events[events.length - 1].ts : 0
  const totals: Partial<Record<ActivityKind, number>> = {}
  for (const s of segments) totals[s.kind] = (totals[s.kind] ?? 0) + dur(s)
  const files = new Set<string>()
  let editsCount = 0
  for (const e of events)
    for (const t of e.tools ?? [])
      if (t.cat === 'edit') {
        editsCount++
        if (t.file) files.add(t.file)
      }

  const windowStartMs = Math.max(startMs, endMs - windowMs)
  const windowSegments = clip(segments, windowStartMs)
  let longestWait: ActivitySegment | undefined
  for (const s of windowSegments) if (s.kind === 'waiting' && (!longestWait || dur(s) > dur(longestWait))) longestWait = s
  return {
    windowStartMs,
    endMs,
    startMs,
    segments: coarsen(windowSegments, max),
    breaks: clip(breaks, windowStartMs),
    longestWait,
    totals,
    breakMs: breaks.reduce((a, b) => a + dur(b), 0),
    breakCount: breaks.length,
    waitedMs: totals.waiting ?? 0,
    editsCount,
    filesEdited: files.size,
    now,
  }
}

// ---------- incremental per-file reader ----------

interface FileEntry {
  size: number
  mtimeMs: number
  readPos: number // bytes consumed, including the unterminated carry
  carry: Buffer // bytes after the last newline, awaiting the rest of their line
  state: ParseState
  result: SessionActivity
}

const fileCache = new Map<string, FileEntry>()

// Unchanged size+mtime returns the cached result without touching the file
// body; a grown file reads only the new bytes; a shrunk one starts over.
export function readSessionActivity(file: string): SessionActivity {
  const stat = fs.statSync(file)
  let entry = fileCache.get(file)
  if (entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) return entry.result
  let state: ParseState
  let carry: Buffer
  let pos: number
  if (entry && stat.size >= entry.readPos) {
    state = entry.state
    carry = entry.carry
    pos = entry.readPos
  } else {
    state = newParseState()
    carry = Buffer.alloc(0)
    pos = 0
  }
  const fd = fs.openSync(file, 'r')
  try {
    while (pos < stat.size) {
      const buf = Buffer.alloc(Math.min(CHUNK_BYTES, stat.size - pos))
      const got = fs.readSync(fd, buf, 0, buf.length, pos)
      if (got <= 0) break
      pos += got
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got)
      // 0x0a never occurs inside a multi-byte UTF-8 sequence, so cutting at
      // the last newline never splits a character.
      const nl = data.lastIndexOf(0x0a)
      if (nl < 0) {
        carry = data
        continue
      }
      for (const line of data.subarray(0, nl).toString('utf-8').split('\n')) {
        const l = line.trimEnd()
        if (l) ingestLine(state, l)
      }
      carry = Buffer.from(data.subarray(nl + 1))
    }
  } finally {
    fs.closeSync(fd)
  }
  entry = { size: stat.size, mtimeMs: stat.mtimeMs, readPos: pos, carry, state, result: buildActivity(state) }
  fileCache.set(file, entry)
  return entry.result
}

// Drop cached files no longer being asked about (a session that ended).
export function pruneActivityCache(keep: Set<string>): void {
  for (const file of fileCache.keys()) if (!keep.has(file)) fileCache.delete(file)
}
