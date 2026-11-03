// Session Desktop records and state derivation: the pure half of
// desktop-core.ts, kept apart so node --test covers it without a host.
// Electron-free.
import fs from 'node:fs'
import { contextLimitFor } from './live-core.ts'
import {
  DESKTOP_COLORS,
  type DesktopColor,
  type DesktopSession,
  type DesktopSessionState,
  type DesktopSnapshot,
  type DesktopTargetRef,
  type LaunchTier,
  type OutsideSession,
} from '../shared/ipc-types.ts'

export const MAX_SLOTS = 9

// One persisted desktop session (desktop-sessions.json). Everything else on a
// DesktopSession is derived each time from the host and the transcript.
export interface DesktopRecord {
  id: string
  claudeSessionId: string
  name: string
  color: DesktopColor
  slot: number
  target: DesktopTargetRef
  createdAtIso: string
  exitCode: number | null
  // The boundary tier of its latest launch; absent on records from before boundaries.
  tier?: LaunchTier
}

// Version 1 records ran only in registered projects ({projectId}); they are
// read as {target: {kind: 'project', key: projectId}} and saved as version 2.
export interface RecordsFile {
  version: 2
  sessions: DesktopRecord[]
}

export function validateTarget(target: unknown): DesktopTargetRef {
  const t = target as Partial<DesktopTargetRef> | null
  if (typeof t !== 'object' || t === null || (t.kind !== 'project' && t.kind !== 'experiment') || typeof t.key !== 'string' || t.key.length === 0) {
    throw new Error('Target must be a project or an experiment')
  }
  return { kind: t.kind, key: t.key }
}

// Names reach Claude Code as a `--name` argument and the renderer as a label.
// Quotes are refused because Windows rebuilds argv into one command line.
export function validateName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('Name must be text')
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > 60) throw new Error('Name must be 1-60 characters')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error('Name cannot contain control characters')
  if (trimmed.includes('"')) throw new Error('Name cannot contain a double quote')
  return trimmed
}

export function validateColor(color: unknown): DesktopColor {
  if (!(DESKTOP_COLORS as readonly unknown[]).includes(color)) throw new Error(`Color must be one of ${DESKTOP_COLORS.join(', ')}`)
  return color as DesktopColor
}

export function validateSlot(slot: unknown): number {
  if (!Number.isInteger(slot) || (slot as number) < 1 || (slot as number) > MAX_SLOTS) throw new Error(`Slot must be 1-${MAX_SLOTS}`)
  return slot as number
}

export function lowestFreeSlot(records: DesktopRecord[]): number {
  const taken = new Set(records.map((r) => r.slot))
  for (let slot = 1; slot <= MAX_SLOTS; slot++) if (!taken.has(slot)) return slot
  throw new Error('The desktop holds 9 sessions; forget an exited one first')
}

// Move a session to a slot; whoever held it takes the mover's old slot.
export function assignSlot(records: DesktopRecord[], id: string, slot: number): DesktopRecord[] {
  const mover = records.find((r) => r.id === id)
  if (!mover) throw new Error('No such desktop session')
  const from = mover.slot
  return records.map((r) => (r.id === id ? { ...r, slot } : r.slot === slot ? { ...r, slot: from } : r))
}

// The record in a file of `version`, or null if it is malformed.
function toRecord(value: unknown, version: 1 | 2): DesktopRecord | null {
  const r = value as (Partial<DesktopRecord> & { projectId?: unknown }) | null
  if (
    typeof r !== 'object' ||
    r === null ||
    typeof r.id !== 'string' ||
    typeof r.claudeSessionId !== 'string' ||
    typeof r.name !== 'string' ||
    !(DESKTOP_COLORS as readonly unknown[]).includes(r.color) ||
    !Number.isInteger(r.slot) ||
    (r.slot as number) < 1 ||
    (r.slot as number) > MAX_SLOTS ||
    typeof r.createdAtIso !== 'string' ||
    !(r.exitCode === null || typeof r.exitCode === 'number')
  ) {
    return null
  }
  let target: DesktopTargetRef
  try {
    target = version === 1 ? validateTarget({ kind: 'project', key: r.projectId }) : validateTarget(r.target)
  } catch {
    return null
  }
  const tier = r.tier === 'audit' || r.tier === 'guarded' || r.tier === 'admin' ? { tier: r.tier } : {}
  return { id: r.id, claudeSessionId: r.claudeSessionId, name: r.name, color: r.color as DesktopColor, slot: r.slot as number, target, createdAtIso: r.createdAtIso, exitCode: r.exitCode as number | null, ...tier }
}

// Throws on anything that isn't a well-formed records file, so the caller can
// refuse to overwrite it: losing the file loses every session's resume id.
export function parseRecords(text: string): DesktopRecord[] {
  const parsed = JSON.parse(text) as { version?: unknown; sessions?: unknown } | null
  if (!parsed || (parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.sessions)) throw new Error('not a version-1 or version-2 records file')
  const version = parsed.version
  const records = parsed.sessions.map((r) => toRecord(r, version))
  const bad = records.findIndex((r) => r === null)
  if (bad >= 0) throw new Error(`record ${bad + 1} is malformed`)
  const sessions = records as DesktopRecord[]
  const ids = new Set(sessions.map((r) => r.id))
  const slots = new Set(sessions.map((r) => r.slot))
  if (ids.size !== sessions.length) throw new Error('duplicate session ids')
  if (slots.size !== sessions.length) throw new Error('two sessions share a slot')
  return sessions
}

// Missing file = no sessions yet, flagged `missing`: it may also have been
// removed, so it says nothing about what runs on the host. Any other failure
// is an error, never an empty list: an empty list would be written back over
// the real one.
export function loadRecords(file: string): { ok: true; records: DesktopRecord[]; missing?: true } | { ok: false; error: string } {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, records: [], missing: true }
    return { ok: false, error: `Can't read ${file}: ${(err as Error).message}` }
  }
  try {
    return { ok: true, records: parseRecords(text) }
  } catch (err) {
    return { ok: false, error: `${file} is unreadable (${(err as Error).message}); fix it in place (it holds every session's resume id), the desktop won't overwrite it` }
  }
}

export function saveRecords(file: string, records: DesktopRecord[]): void {
  const body: RecordsFile = { version: 2, sessions: records }
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

// What the user has typed on the current input line, rebuilt from the raw
// keystrokes the hub relays, so a submitted `/clear` can be noticed (Claude
// Code then starts a new transcript; desktop-core rebinds the record to it).
// Best effort by design: an escape sequence (arrows, Shift+Enter, a bracketed
// paste) or a control key (Tab completion, Ctrl+U) makes the line unknown, so
// the buffer resets. Known gap: a tab-completed `/cl⇥` is never seen as /clear.
const MAX_TYPED_LINE = 256
export function feedTypedLine(buffer: string, data: string): { buffer: string; submitted: string[] } {
  const submitted: string[] = []
  for (const ch of data) {
    if (ch === '\x1b') {
      buffer = ''
      break
    }
    if (ch === '\r') {
      submitted.push(buffer)
      buffer = ''
    } else if (ch === '\x7f' || ch === '\b') {
      buffer = buffer.slice(0, -1)
    } else if (ch < ' ') {
      buffer = ''
    } else if (buffer.length < MAX_TYPED_LINE) {
      buffer += ch
    }
  }
  return { buffer, submitted }
}

export function isClearCommand(line: string): boolean {
  const text = line.trim()
  return text === '/clear' || text.startsWith('/clear ')
}

// The line Claude Code writes first in the transcript a /clear starts.
export function startsWithClear(lines: string[]): boolean {
  return lines.some((text) => {
    try {
      const line = JSON.parse(text) as RawLine
      return line.type === 'user' && typeof line.message?.content === 'string' && line.message.content.startsWith('<command-name>/clear</command-name>')
    } catch {
      return false
    }
  })
}

export type TranscriptRead ={ kind: 'missing' } | { kind: 'unreadable' } | { kind: 'lines'; lines: string[] }

export interface StateInput {
  alive: boolean
  // The host exists but can't be reached: nothing can be claimed.
  hostUnreachable: boolean
  // Non-null while a choice menu is on screen.
  prompt: { line: string | null } | null
  transcript: TranscriptRead
  // Claude Code's own status for the session's process (its
  // ~/.claude/sessions record); absent or 'unknown' = derive from the transcript.
  claudeStatus?: OutsideSession['status'] | null
  // What a 'waiting' process waits on, in Claude Code's words.
  claudeWaitingFor?: string | null
}

export interface DerivedState {
  state: DesktopSessionState
  stateDetail: string | null
  lastActivityIso: string | null
  contextPct: number | null
}

interface RawLine {
  type?: string
  subtype?: string
  timestamp?: string
  message?: { model?: string; usage?: Record<string, number | undefined>; content?: unknown }
}

// The text of a user line: a plain string, or the text blocks of an array.
function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as { type?: string; text?: unknown }[])
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
}

// User lines that end a turn without a turn_duration / stop_hook_summary line:
// Esc writes "[Request interrupted by user…]", and a local slash command
// (/config, /login, /clear…) writes <command-name> / <local-command-*> lines.
function closesTurn(content: unknown): boolean {
  const text = userText(content).trimStart()
  return text.startsWith('[Request interrupted by user') || text.includes('<command-name>') || text.includes('<local-command-')
}

// The facts a transcript tail gives, read the way live-core.ts reads them: a
// turn is open while the newest user/assistant line comes after the newest
// turn_duration / stop_hook_summary system line (or interrupt / local command).
function transcriptFacts(lines: string[]) {
  let lastActivity = -1
  let lastClose = -1
  let lastActivityIso: string | null = null
  let contextPct: number | null = null
  let toolSinceClose: string | null = null
  lines.forEach((text, i) => {
    let line: RawLine
    try {
      line = JSON.parse(text) as RawLine
    } catch {
      return // the last line may be mid-write
    }
    if (line.type === 'user' || line.type === 'assistant') {
      lastActivity = i
      if (typeof line.timestamp === 'string') lastActivityIso = line.timestamp
    }
    if (
      (line.type === 'system' && (line.subtype === 'turn_duration' || line.subtype === 'stop_hook_summary')) ||
      (line.type === 'user' && closesTurn(line.message?.content))
    ) {
      lastClose = i
      toolSinceClose = null
    }
    if (line.type === 'assistant' && line.message) {
      const { model, usage, content } = line.message
      if (Array.isArray(content)) {
        for (const block of content as { type?: string; name?: string }[]) {
          if (block.type === 'tool_use' && typeof block.name === 'string') toolSinceClose = block.name
        }
      }
      if (usage) {
        const tokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        const known = typeof model === 'string' && model !== '<synthetic>' ? model : undefined
        contextPct = Math.min(100, Math.round((tokens / contextLimitFor(known)) * 100))
      }
    }
  })
  return { hasActivity: lastActivity >= 0, turnOpen: lastActivity > lastClose, lastActivityIso, contextPct, toolSinceClose }
}

// What a desktop session is doing, in priority order: no process, a menu
// waiting on you, Claude Code's own busy/idle status when it has one, no
// transcript yet, an open turn (however long a tool runs), a closed one. A
// transcript that couldn't be read is 'unknown', not idle.
export function deriveDesktopState(input: StateInput): DerivedState {
  const facts = input.transcript.kind === 'lines' ? transcriptFacts(input.transcript.lines) : null
  const base = { lastActivityIso: facts?.lastActivityIso ?? null, contextPct: facts?.contextPct ?? null }
  if (input.hostUnreachable) return { ...base, state: 'unknown', stateDetail: "can't reach the desktop host" }
  if (!input.alive) return { ...base, state: 'exited', stateDetail: null }
  if (input.prompt) return { ...base, state: 'needs-you', stateDetail: input.prompt.line }
  if (input.claudeStatus === 'waiting') return { ...base, state: 'needs-you', stateDetail: input.claudeWaitingFor ?? null }
  if (input.claudeStatus === 'busy') {
    return { ...base, state: 'working', stateDetail: facts?.turnOpen ? facts.toolSinceClose : null }
  }
  // 'shell' stays set while a process the session started in the background
  // (a dev server, say) is still running, long after the turn ended. Only an
  // open turn is work; a closed one is waiting on you.
  if (input.claudeStatus === 'shell' && facts && facts.hasActivity) {
    return facts.turnOpen
      ? { ...base, state: 'working', stateDetail: facts.toolSinceClose }
      : { ...base, state: 'your-turn', stateDetail: 'a background process it started is still running' }
  }
  if (input.transcript.kind === 'missing' || (facts && !facts.hasActivity)) {
    return { ...base, state: 'starting', stateDetail: 'waiting for the first prompt' }
  }
  if (input.claudeStatus === 'idle') return { ...base, state: 'your-turn', stateDetail: null }
  if (!facts) return { ...base, state: 'unknown', stateDetail: "couldn't read the transcript" }
  if (facts.turnOpen) return { ...base, state: 'working', stateDetail: facts.toolSinceClose }
  return { ...base, state: 'your-turn', stateDetail: null }
}

// Why a past conversation can't be resumed as a new desktop session, or null.
// Two processes on one transcript would interleave it, so a conversation that
// is already on the desktop, or running elsewhere, is refused, and so is one
// whose liveness couldn't be checked (outside null = the records were unreadable).
export function resumeRefusal(
  sessionId: string,
  records: DesktopRecord[],
  liveIds: Set<string>,
  outside: { sessions: OutsideSession[] | null; error: string | null },
): string | null {
  const own = records.find((r) => r.claudeSessionId === sessionId)
  if (own) return liveIds.has(own.id) ? `That conversation is already open on the desktop as "${own.name}"` : `That conversation is already on the desktop as "${own.name}"; resume it there`
  if (outside.sessions === null) return `Couldn't check whether that conversation is running elsewhere: ${outside.error ?? 'unknown error'}`
  const elsewhere = outside.sessions.find((o) => o.sessionId === sessionId)
  if (elsewhere) return `That conversation is running in another terminal (pid ${elsewhere.pid}); take it over instead`
  return null
}

// Sessions that just came to need you. The first snapshot (prev null) never
// counts: every waiting session would announce itself when the app opened.
export function needsYouTransitions(prev: DesktopSnapshot | null, next: DesktopSnapshot): DesktopSession[] {
  if (!prev) return []
  const before = new Map(prev.sessions.map((s) => [s.id, s.state]))
  return next.sessions.filter((s) => s.state === 'needs-you' && before.get(s.id) !== 'needs-you')
}
