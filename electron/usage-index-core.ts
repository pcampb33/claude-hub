// Pure core of the usage index (electron/usage-index.ts does the fs work):
// folding transcript lines into per-file hourly aggregates, attributing a
// session to a project, and bucketing the hours into a report. No fs, no
// clock — every function takes what it needs, so all of it is unit-testable.
import type {
  UsageGranularity,
  UsageReport,
  UsageSeries,
  UsageSeriesKind,
  UsageValues,
} from '../shared/ipc-types.ts'

// Bump when FileState's meaning changes: a stored index of another version is
// rebuilt from scratch, never read as if it were current.
export const USAGE_INDEX_VERSION = 2

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

// One file's usage inside one hour (key: ms since epoch / HOUR_MS). Stored in
// UTC hours; the report maps them onto local periods. Every whole-hour zone
// (all of the user's) puts a UTC hour wholly inside one local hour.
export interface HourAgg {
  p: number // processed: input + cache_read + cache_creation + output
  o: number // output tokens
  r: number // responses
  m: number[] // minutes of the hour (0-59) with a response, sorted, unique
}

// A counted response, keyed by message.id: [hour key, minute, input, output,
// cacheRead, cacheCreation]. Claude Code writes one line per content block,
// every block repeating the response's message.id and usage — and the
// output_tokens of the early lines is a partial count (measured: 16 on the
// first line, 227 on the last). So a repeated id is not counted again; only
// growth over what was already counted is added. Every id is kept because a
// response can also sit in more than one transcript: a forked or resumed
// session copies its parent's lines verbatim (same id, same timestamp; 511
// such ids measured 2026-10-20), and groupSessions credits each to one file.
export type CountedResponse = [number, number, number, number, number, number]

export interface FileState {
  size: number
  mtimeMs: number
  offset: number // bytes consumed: always just past a newline
  sessionId: string // a subagent transcript carries its parent session's id
  dir: string // the encoded project folder under ~/.claude/projects
  subagent: boolean
  cwd: string | null // first cwd seen on a response line
  headless: boolean | null // entrypoint 'sdk-cli'; null until a response line says
  responses: Record<string, CountedResponse>
  hours: Record<string, HourAgg>
}

export interface UsageIndexData {
  v: number
  // When this index was first built. Transcripts Claude Code had already
  // deleted by then were never seen, so coverage before it is partial.
  createdMs: number
  files: Record<string, FileState> // keyed by path relative to the projects root
}

export function newFileState(dir: string, sessionId: string, subagent: boolean): FileState {
  return { size: 0, mtimeMs: 0, offset: 0, sessionId, dir, subagent, cwd: null, headless: null, responses: {}, hours: {} }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

interface RawUsageLine {
  type?: unknown
  timestamp?: unknown
  cwd?: unknown
  entrypoint?: unknown
  message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> }
}

function addMinute(minutes: number[], minute: number): void {
  let i = 0
  while (i < minutes.length && minutes[i] < minute) i++
  if (minutes[i] !== minute) minutes.splice(i, 0, minute)
}

// Folds one transcript line into the file's state. Lines that are not an
// assistant response with usage are skipped before JSON.parse: Claude Code
// also writes ~400KB request-blob lines, and most lines carry no usage.
export function ingestLine(state: FileState, line: string): void {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return
  let parsed: RawUsageLine
  try {
    parsed = JSON.parse(line) as RawUsageLine
  } catch {
    return // a corrupt line; the trailing partial line never reaches here
  }
  const msg = parsed?.message
  const usage = msg?.usage
  if (parsed.type !== 'assistant' || !usage || typeof usage !== 'object' || typeof msg.id !== 'string') return
  if (state.cwd === null && typeof parsed.cwd === 'string' && parsed.cwd) state.cwd = parsed.cwd
  if (state.headless === null && typeof parsed.entrypoint === 'string') state.headless = parsed.entrypoint === 'sdk-cli'
  // Claude Code's own placeholder turns (API errors, interrupts): no request was made.
  if (msg.model === '<synthetic>') return
  const ms = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN
  if (Number.isNaN(ms)) return

  const vals = [
    num(usage.input_tokens),
    num(usage.output_tokens),
    num(usage.cache_read_input_tokens),
    num(usage.cache_creation_input_tokens),
  ]
  const seen = Object.prototype.hasOwnProperty.call(state.responses, msg.id) ? state.responses[msg.id] : undefined
  if (seen) {
    const agg = state.hours[seen[0]]
    for (let i = 0; i < 4; i++) {
      const growth = vals[i] - seen[i + 2]
      if (growth <= 0) continue
      seen[i + 2] = vals[i]
      agg.p += growth
      if (i === 1) agg.o += growth
    }
    return
  }
  const hour = Math.floor(ms / HOUR_MS)
  const minute = Math.floor((ms - hour * HOUR_MS) / MINUTE_MS)
  const agg = (state.hours[hour] ??= { p: 0, o: 0, r: 0, m: [] })
  agg.p += vals[0] + vals[1] + vals[2] + vals[3]
  agg.o += vals[1]
  agg.r += 1
  addMinute(agg.m, minute)
  state.responses[msg.id] = [hour, minute, vals[0], vals[1], vals[2], vals[3]]
}

// Folds every complete line of `buf` (bytes read from state.offset on) and
// returns how many bytes that was: through the last newline. A final line
// with no newline yet may be mid-write, so it is left for the next read.
// Splitting on the 0x0a byte never cuts a UTF-8 sequence.
export function consumeChunk(state: FileState, buf: Buffer): number {
  const consumed = buf.lastIndexOf(0x0a) + 1
  if (consumed === 0) return 0
  for (const line of buf.toString('utf8', 0, consumed).split('\n')) {
    if (line) ingestLine(state, line)
  }
  state.offset += consumed
  return consumed
}

// ---- Attribution ------------------------------------------------------------

export interface AttributionInput {
  projects: { id: string; name: string; path: string }[]
  experiments: string[] // sandbox experiment folder paths
}

interface Claim {
  path: string // normalized
  series: UsageSeries
}

const HEADLESS: UsageSeries = { key: 'headless', name: 'Headless runs (hooks & scripts)', kind: 'headless' }
const OTHER: UsageSeries = { key: 'other', name: 'Unregistered folders', kind: 'other' }

function normPath(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function basename(p: string): string {
  const parts = p.replace(/\//g, '\\').replace(/\\+$/, '').split('\\')
  return parts[parts.length - 1] ?? p
}

export function buildClaims(input: AttributionInput): Claim[] {
  const claims: Claim[] = [
    ...input.projects.map((p) => ({
      path: normPath(p.path),
      series: { key: `project:${p.id}`, name: p.name, kind: 'project' as UsageSeriesKind },
    })),
    ...input.experiments.map((e) => ({
      path: normPath(e),
      series: { key: `experiment:${basename(e)}`, name: `sandbox / ${basename(e)}`, kind: 'experiment' as UsageSeriesKind },
    })),
  ]
  // Longest first, so the first match is the most specific: an experiment
  // folder inside the registered sandbox wins over the sandbox itself.
  return claims.sort((a, b) => b.path.length - a.path.length)
}

export function attribute(cwd: string | null, headless: boolean, claims: Claim[]): UsageSeries {
  if (headless) return HEADLESS
  if (!cwd) return OTHER
  const c = normPath(cwd)
  for (const claim of claims) {
    if (c === claim.path || c.startsWith(claim.path + '\\')) return claim.series
  }
  return OTHER
}

// ---- Sessions ---------------------------------------------------------------

export interface SessionGroup {
  sessionId: string
  mainFile: string | null // relative path of the session's own transcript
  cwd: string | null
  headless: boolean
  // Per hour key: tokens summed over the session's files, minutes unioned —
  // a subagent working in the same minute as its parent is one active minute.
  hours: Map<number, { p: number; o: number; m: Set<number> }>
}

function firstResponseMs(f: FileState): number {
  let first = Infinity
  for (const [key, agg] of Object.entries(f.hours)) first = Math.min(first, Number(key) * HOUR_MS + agg.m[0] * MINUTE_MS)
  return first
}

// Per file, the response ids another file is credited with. A response that
// sits in several transcripts (copied by a fork or a resume) is credited to
// the file whose first response is earliest, the one it was copied from; a
// tie (a full-history copy) goes to the smaller path, so the listing order
// never decides.
function copiedElsewhere(files: Record<string, FileState>): Map<string, Set<string>> {
  const owner = new Map<string, string>()
  const firsts = new Map<string, number>()
  const first = (rel: string): number => {
    let ms = firsts.get(rel)
    if (ms === undefined) firsts.set(rel, (ms = firstResponseMs(files[rel])))
    return ms
  }
  const dropped = new Map<string, Set<string>>()
  for (const [rel, f] of Object.entries(files)) {
    for (const id of Object.keys(f.responses)) {
      const cur = owner.get(id)
      if (cur === undefined) {
        owner.set(id, rel)
        continue
      }
      const curWins = first(cur) < first(rel) || (first(cur) === first(rel) && cur < rel)
      const loser = curWins ? rel : cur
      if (!curWins) owner.set(id, rel)
      let ids = dropped.get(loser)
      if (!ids) dropped.set(loser, (ids = new Set()))
      ids.add(id)
    }
  }
  return dropped
}

// A file's hours rebuilt from its responses, leaving out `skip`.
function hoursWithout(f: FileState, skip: Set<string>): Record<string, Omit<HourAgg, 'r'>> {
  const out: Record<string, Omit<HourAgg, 'r'>> = {}
  for (const [id, [hour, minute, input, output, cacheRead, cacheCreation]] of Object.entries(f.responses)) {
    if (skip.has(id)) continue
    const agg = (out[hour] ??= { p: 0, o: 0, m: [] })
    agg.p += input + output + cacheRead + cacheCreation
    agg.o += output
    addMinute(agg.m, minute)
  }
  return out
}

// Groups file states into sessions, counting a response copied into several
// transcripts once. Subagent transcripts take their parent's cwd and headless
// flag (falling back to their own when the parent's transcript is gone).
export function groupSessions(index: UsageIndexData): SessionGroup[] {
  const groups = new Map<string, SessionGroup & { fallbackCwd: string | null; fallbackHeadless: boolean | null }>()
  const dropped = copiedElsewhere(index.files)
  for (const [rel, f] of Object.entries(index.files)) {
    const id = `${f.dir}|${f.sessionId}`
    let g = groups.get(id)
    if (!g) {
      g = { sessionId: f.sessionId, mainFile: null, cwd: null, headless: false, hours: new Map(), fallbackCwd: null, fallbackHeadless: null }
      groups.set(id, g)
    }
    if (f.subagent) {
      g.fallbackCwd ??= f.cwd
      g.fallbackHeadless ??= f.headless
    } else {
      g.mainFile = rel
      g.cwd = f.cwd
      g.headless = f.headless === true
    }
    const skip = dropped.get(rel)
    for (const [key, agg] of Object.entries(skip ? hoursWithout(f, skip) : f.hours)) {
      const hour = Number(key)
      let h = g.hours.get(hour)
      if (!h) {
        h = { p: 0, o: 0, m: new Set() }
        g.hours.set(hour, h)
      }
      h.p += agg.p
      h.o += agg.o
      for (const minute of agg.m) h.m.add(minute)
    }
  }
  const out: SessionGroup[] = []
  for (const g of groups.values()) {
    const { fallbackCwd, fallbackHeadless, ...group } = g
    if (group.mainFile === null) {
      group.cwd = fallbackCwd
      group.headless = fallbackHeadless === true
    }
    out.push(group)
  }
  return out
}

// ---- Periods ----------------------------------------------------------------

// Start of each of the last `periods` local periods (oldest first), plus the
// end of the newest one. Days, weeks (Monday) and months are built with the
// Date constructor so DST days come out 23 or 25 hours long, as they are.
export function periodStarts(granularity: UsageGranularity, periods: number, nowMs: number): { starts: number[]; end: number } {
  const now = new Date(nowMs)
  const startOf = (k: number): number => {
    // k periods before the current one (negative = after it).
    const y = now.getFullYear()
    const mo = now.getMonth()
    const d = now.getDate()
    switch (granularity) {
      case 'hour': {
        const h = new Date(nowMs)
        h.setMinutes(0, 0, 0)
        return h.getTime() - k * HOUR_MS
      }
      case 'day':
        return new Date(y, mo, d - k).getTime()
      case 'week': {
        const sinceMonday = (now.getDay() + 6) % 7
        return new Date(y, mo, d - sinceMonday - 7 * k).getTime()
      }
      case 'month':
        return new Date(y, mo - k, 1).getTime()
    }
  }
  const starts: number[] = []
  for (let k = periods - 1; k >= 0; k--) starts.push(startOf(k))
  return { starts, end: startOf(-1) }
}

// Index of the period containing ms, or -1 when it falls outside them all.
function periodIndex(starts: number[], end: number, ms: number): number {
  if (ms < starts[0] || ms >= end) return -1
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= ms) lo = mid
    else hi = mid - 1
  }
  return lo
}

// ---- Report -----------------------------------------------------------------

const zero = (): UsageValues => ({ processed: 0, output: 0, activeMinutes: 0 })

export type UsageAggregates = Pick<UsageReport, 'series' | 'buckets' | 'totals'>

export function buildAggregates(
  sessions: SessionGroup[],
  claims: Claim[],
  granularity: UsageGranularity,
  periods: number,
  nowMs: number,
): UsageAggregates {
  const { starts, end } = periodStarts(granularity, periods, nowMs)
  const buckets = starts.map((s) => ({ startIso: new Date(s).toISOString(), values: {} as Record<string, UsageValues> }))
  const totals: UsageReport['totals'] = {}
  const seriesByKey = new Map<string, UsageSeries>()
  for (const s of sessions) {
    const series = attribute(s.cwd, s.headless, claims)
    let touched = false
    for (const [hour, h] of s.hours) {
      const i = periodIndex(starts, end, hour * HOUR_MS)
      if (i < 0) continue
      touched = true
      const v = (buckets[i].values[series.key] ??= zero())
      v.processed += h.p
      v.output += h.o
      v.activeMinutes += h.m.size
      const t = (totals[series.key] ??= { ...zero(), sessions: 0 })
      t.processed += h.p
      t.output += h.o
      t.activeMinutes += h.m.size
    }
    if (touched) {
      totals[series.key].sessions += 1
      seriesByKey.set(series.key, series)
    }
  }
  const series = [...seriesByKey.values()].sort((a, b) => totals[b.key].processed - totals[a.key].processed)
  return { series, buckets, totals }
}

export interface SessionTotals {
  group: SessionGroup
  processed: number
  output: number
  activeMinutes: number
  lastMs: number
}

// The sessions behind one series key inside [startMs, endMs), largest first.
export function sessionsFor(
  sessions: SessionGroup[],
  claims: Claim[],
  key: string,
  startMs: number,
  endMs: number,
): SessionTotals[] {
  const out: SessionTotals[] = []
  for (const s of sessions) {
    if (attribute(s.cwd, s.headless, claims).key !== key) continue
    const row: SessionTotals = { group: s, processed: 0, output: 0, activeMinutes: 0, lastMs: 0 }
    let touched = false
    for (const [hour, h] of s.hours) {
      const ms = hour * HOUR_MS
      if (ms < startMs || ms >= endMs) continue
      touched = true
      row.processed += h.p
      row.output += h.o
      row.activeMinutes += h.m.size
      row.lastMs = Math.max(row.lastMs, ms + Math.max(...h.m) * MINUTE_MS)
    }
    if (touched) out.push(row)
  }
  return out.sort((a, b) => b.processed - a.processed)
}

// Earliest and latest response anywhere in the index.
export function indexSpan(index: UsageIndexData): { firstIso: string | null; lastIso: string | null } {
  let first = Infinity
  let last = -Infinity
  for (const f of Object.values(index.files)) {
    for (const [key, agg] of Object.entries(f.hours)) {
      const ms = Number(key) * HOUR_MS
      if (ms + agg.m[0] * MINUTE_MS < first) first = ms + agg.m[0] * MINUTE_MS
      const lastMs = ms + agg.m[agg.m.length - 1] * MINUTE_MS
      if (lastMs > last) last = lastMs
    }
  }
  return Number.isFinite(first)
    ? { firstIso: new Date(first).toISOString(), lastIso: new Date(last).toISOString() }
    : { firstIso: null, lastIso: null }
}
