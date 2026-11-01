import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  attribute,
  buildAggregates,
  buildClaims,
  consumeChunk,
  groupSessions,
  ingestLine,
  newFileState,
  periodStarts,
  sessionsFor,
  type UsageIndexData,
} from './usage-index-core.ts'

const HOUR_MS = 3_600_000

function line(o: {
  id: string
  ts: string
  input?: number
  output?: number
  cacheRead?: number
  cacheCreate?: number
  cwd?: string
  entrypoint?: string
  model?: string
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: o.ts,
    cwd: o.cwd ?? 'C:\\projects\\chug',
    entrypoint: o.entrypoint ?? 'cli',
    message: {
      id: o.id,
      model: o.model ?? 'claude-opus',
      usage: {
        input_tokens: o.input ?? 0,
        output_tokens: o.output ?? 0,
        cache_read_input_tokens: o.cacheRead ?? 0,
        cache_creation_input_tokens: o.cacheCreate ?? 0,
      },
    },
  })
}

const totalP = (s: ReturnType<typeof newFileState>) => Object.values(s.hours).reduce((n, h) => n + h.p, 0)
const totalO = (s: ReturnType<typeof newFileState>) => Object.values(s.hours).reduce((n, h) => n + h.o, 0)
const totalR = (s: ReturnType<typeof newFileState>) => Object.values(s.hours).reduce((n, h) => n + h.r, 0)

test('ingestLine: processed = input + cache read + cache creation + output', () => {
  const s = newFileState('d', 's', false)
  ingestLine(s, line({ id: 'm1', ts: '2026-10-18T10:05:00Z', input: 2, output: 10, cacheRead: 1000, cacheCreate: 50 }))
  assert.equal(totalP(s), 1062)
  assert.equal(totalO(s), 10)
  assert.equal(totalR(s), 1)
  assert.equal(s.cwd, 'C:\\projects\\chug')
  assert.equal(s.headless, false)
})

test('ingestLine: lines repeating a message.id count once; only output growth is added', () => {
  const s = newFileState('d', 's', false)
  // Claude Code writes one line per content block; early lines carry a partial output count.
  ingestLine(s, line({ id: 'm1', ts: '2026-10-18T10:05:00Z', input: 2, output: 16, cacheRead: 58129, cacheCreate: 1366 }))
  ingestLine(s, line({ id: 'm1', ts: '2026-10-18T10:05:02Z', input: 2, output: 16, cacheRead: 58129, cacheCreate: 1366 }))
  ingestLine(s, line({ id: 'm1', ts: '2026-10-18T10:05:09Z', input: 2, output: 227, cacheRead: 58129, cacheCreate: 1366 }))
  assert.equal(totalR(s), 1)
  assert.equal(totalO(s), 227)
  assert.equal(totalP(s), 2 + 227 + 58129 + 1366)
  ingestLine(s, line({ id: 'm2', ts: '2026-10-18T10:06:00Z', input: 1, output: 1 }))
  assert.equal(totalR(s), 2)
})

test('ingestLine: skips non-usage lines, synthetic turns and corrupt JSON', () => {
  const s = newFileState('d', 's', false)
  ingestLine(s, JSON.stringify({ type: 'user', message: { role: 'user', content: 'what does "usage" mean' } }))
  ingestLine(s, line({ id: 'x', ts: '2026-10-18T10:05:00Z', output: 5, model: '<synthetic>' }))
  ingestLine(s, '{"type":"assistant","message":{"usage":')
  assert.equal(totalR(s), 0)
})

test('ingestLine: entrypoint sdk-cli marks the file headless', () => {
  const s = newFileState('d', 's', false)
  ingestLine(s, line({ id: 'm1', ts: '2026-10-18T10:05:00Z', output: 1, entrypoint: 'sdk-cli' }))
  assert.equal(s.headless, true)
})

test('ingestLine: active minutes are the distinct minutes with a response', () => {
  const s = newFileState('d', 's', false)
  ingestLine(s, line({ id: 'a', ts: '2026-10-18T10:05:01Z', output: 1 }))
  ingestLine(s, line({ id: 'b', ts: '2026-10-18T10:05:40Z', output: 1 }))
  ingestLine(s, line({ id: 'c', ts: '2026-10-18T10:07:00Z', output: 1 }))
  const hours = Object.values(s.hours)
  assert.equal(hours.length, 1)
  assert.deepEqual(hours[0].m, [5, 7])
})

test('consumeChunk: a final line without a newline is left for the next read', () => {
  const s = newFileState('d', 's', false)
  const first = line({ id: 'm1', ts: '2026-10-18T10:05:00Z', output: 10 }) + '\n'
  const second = line({ id: 'm2', ts: '2026-10-18T10:06:00Z', output: 20 })
  const half = second.slice(0, 40)
  const buf = Buffer.from(first + half)
  const consumed = consumeChunk(s, buf)
  assert.equal(consumed, Buffer.byteLength(first))
  assert.equal(s.offset, consumed)
  assert.equal(totalO(s), 10)
  // The rest of the line arrives; the reader resumes at the offset.
  consumeChunk(s, Buffer.from(second + '\n'))
  assert.equal(totalO(s), 30)
  assert.equal(totalR(s), 2)
})

test('consumeChunk: a multi-byte character is never split', () => {
  const s = newFileState('d', 's', false)
  const l = JSON.stringify({ ...JSON.parse(line({ id: 'm1', ts: '2026-10-18T10:05:00Z', output: 3 })), cwd: 'C:\\projects\\café—x' })
  assert.equal(consumeChunk(s, Buffer.from(l + '\n')), Buffer.byteLength(l) + 1)
  assert.equal(s.cwd, 'C:\\projects\\café—x')
})

// ---- attribution ----

const claims = buildClaims({
  projects: [
    { id: 'p-sandbox', name: 'sandbox', path: 'C:\\projects\\claude-hub-sandbox' },
    { id: 'p-hub', name: 'claude-hub', path: 'C:\\projects\\claude-hub' },
    { id: 'p-chug', name: 'chug', path: 'C:\\projects\\chug' },
  ],
  experiments: ['C:\\projects\\claude-hub-sandbox\\Reverse Engineer MX'],
})

test('attribute: an experiment folder wins over the sandbox project that contains it', () => {
  assert.equal(attribute('C:\\projects\\claude-hub-sandbox\\Reverse Engineer MX', false, claims).key, 'experiment:Reverse Engineer MX')
  assert.equal(attribute('c:/projects/claude-hub-sandbox/reverse engineer mx/sub', false, claims).name, 'sandbox / Reverse Engineer MX')
  assert.equal(attribute('C:\\projects\\claude-hub-sandbox', false, claims).key, 'project:p-sandbox')
})

test('attribute: longest registered prefix, on a path boundary', () => {
  assert.equal(attribute('C:\\projects\\claude-hub\\.claude\\worktrees\\agent-1', false, claims).key, 'project:p-hub')
  assert.equal(attribute('C:\\projects\\chug', false, claims).key, 'project:p-chug')
  assert.equal(attribute('C:\\projects\\chug2', false, claims).key, 'other')
  assert.equal(attribute(null, false, claims).key, 'other')
})

test('attribute: headless runs get their own bucket wherever they ran', () => {
  const s = attribute('C:\\projects\\claude-hub', true, claims)
  assert.equal(s.key, 'headless')
  assert.equal(s.kind, 'headless')
})

// ---- sessions ----

function indexOf(files: UsageIndexData['files']): UsageIndexData {
  return { v: 1, createdMs: 0, files }
}

test('groupSessions: a subagent transcript counts toward its parent session and project', () => {
  const parent = newFileState('C--projects-chug', 'sess1', false)
  ingestLine(parent, line({ id: 'p1', ts: '2026-10-18T10:05:00Z', output: 10, cwd: 'C:\\projects\\chug' }))
  const sub = newFileState('C--projects-chug', 'sess1', true)
  // The subagent ran in a worktree elsewhere, in the same minute and one more.
  ingestLine(sub, line({ id: 's1', ts: '2026-10-18T10:05:30Z', output: 5, cwd: 'D:\\elsewhere' }))
  ingestLine(sub, line({ id: 's2', ts: '2026-10-18T10:09:00Z', output: 5, cwd: 'D:\\elsewhere' }))
  const sessions = groupSessions(indexOf({ 'a.jsonl': parent, 'a/subagents/x.jsonl': sub }))
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].cwd, 'C:\\projects\\chug')
  assert.equal(sessions[0].mainFile, 'a.jsonl')
  const agg = buildAggregates(sessions, claims, 'day', 1, Date.parse('2026-10-18T12:00:00Z'))
  assert.equal(agg.totals['project:p-chug'].output, 20)
  assert.equal(agg.totals['project:p-chug'].activeMinutes, 2) // minute 5 (shared) + minute 9
  assert.equal(agg.totals['project:p-chug'].sessions, 1)
})

test('groupSessions: a headless parent makes its subagents headless too', () => {
  const parent = newFileState('d', 's', false)
  ingestLine(parent, line({ id: 'p1', ts: '2026-10-18T10:05:00Z', output: 1, entrypoint: 'sdk-cli' }))
  const sub = newFileState('d', 's', true)
  ingestLine(sub, line({ id: 's1', ts: '2026-10-18T10:05:00Z', output: 1, entrypoint: 'cli' }))
  const [g] = groupSessions(indexOf({ p: parent, q: sub }))
  assert.equal(g.headless, true)
})

test('groupSessions: subagents whose parent transcript is gone fall back to their own cwd', () => {
  const sub = newFileState('d', 's', true)
  ingestLine(sub, line({ id: 's1', ts: '2026-10-18T10:05:00Z', output: 1, cwd: 'C:\\projects\\chug' }))
  const [g] = groupSessions(indexOf({ q: sub }))
  assert.equal(g.mainFile, null)
  assert.equal(attribute(g.cwd, g.headless, claims).key, 'project:p-chug')
})

test('groupSessions: a response copied into a forked transcript counts once, for the earliest file', () => {
  // --fork-session / resume copy the parent's lines verbatim (same message.id,
  // same timestamp) into the new transcript, then the fork adds its own.
  const parent = newFileState('C--projects-chug', 'parent', false)
  ingestLine(parent, line({ id: 'a1', ts: '2026-10-18T10:05:00Z', cacheRead: 100, output: 1 }))
  ingestLine(parent, line({ id: 'a2', ts: '2026-10-18T10:06:00Z', cacheRead: 200, output: 2 }))
  const fork = newFileState('C--projects-chug', 'fork', false)
  ingestLine(fork, line({ id: 'a2', ts: '2026-10-18T10:06:00Z', cacheRead: 200, output: 2 }))
  ingestLine(fork, line({ id: 'b1', ts: '2026-10-18T10:20:00Z', cacheRead: 50, output: 5 }))
  // The fork is listed first and sorts first: neither order may decide who is credited.
  const sessions = groupSessions(indexOf({ 'a-fork.jsonl': fork, 'b-parent.jsonl': parent }))
  const agg = buildAggregates(sessions, claims, 'day', 1, Date.parse('2026-10-18T12:00:00Z'))
  const t = agg.totals['project:p-chug']
  assert.equal(t.processed, 101 + 202 + 55)
  assert.equal(t.output, 8)
  assert.equal(t.activeMinutes, 3) // minutes 5, 6 (once) and 20
  assert.equal(t.sessions, 2)
  const rows = sessionsFor(sessions, claims, 'project:p-chug', 0, Date.parse('2026-10-19T00:00:00Z'))
  assert.deepEqual(
    rows.map((r) => [r.group.sessionId, r.processed]),
    [
      ['parent', 303],
      ['fork', 55],
    ],
  )
})

test('groupSessions: sibling transcripts holding the same responses count them once', () => {
  const a = newFileState('d', 's', true)
  const b = newFileState('d', 's', true)
  for (const s of [a, b]) {
    ingestLine(s, line({ id: 'x', ts: '2026-10-18T10:05:00Z', output: 10 }))
    ingestLine(s, line({ id: 'x', ts: '2026-10-18T10:05:01Z', output: 30 }))
  }
  const agg = buildAggregates(groupSessions(indexOf({ a, b })), claims, 'day', 1, Date.parse('2026-10-18T12:00:00Z'))
  assert.equal(agg.totals['project:p-chug'].output, 30)
  assert.equal(agg.totals['project:p-chug'].activeMinutes, 1)
})

// ---- periods (local time) ----

test('periodStarts: hour periods end with the current local hour', () => {
  const now = new Date(2026, 9, 18, 14, 30).getTime()
  const { starts, end } = periodStarts('hour', 48, now)
  assert.equal(starts.length, 48)
  assert.equal(starts[47], new Date(2026, 9, 18, 14).getTime())
  assert.equal(end, starts[47] + HOUR_MS)
  assert.equal(starts[0], starts[47] - 47 * HOUR_MS)
})

test('periodStarts: day periods start at local midnight', () => {
  const now = new Date(2026, 9, 18, 0, 10).getTime()
  const { starts, end } = periodStarts('day', 30, now)
  assert.equal(starts[29], new Date(2026, 9, 18).getTime())
  assert.equal(starts[0], new Date(2026, 8, 19).getTime())
  assert.equal(end, new Date(2026, 9, 19).getTime())
})

test('periodStarts: weeks start on Monday, including when today is Sunday or Monday', () => {
  // 2026-10-18 is a Sunday: its week began Monday 2026-10-12.
  const sunday = periodStarts('week', 12, new Date(2026, 9, 18, 23, 0).getTime())
  assert.equal(sunday.starts[11], new Date(2026, 9, 12).getTime())
  assert.equal(new Date(sunday.starts[0]).getDay(), 1)
  assert.equal(sunday.starts[0], new Date(2026, 9, 12 - 77).getTime())
  assert.equal(sunday.end, new Date(2026, 9, 19).getTime())
  const monday = periodStarts('week', 1, new Date(2026, 9, 19, 0, 5).getTime())
  assert.equal(monday.starts[0], new Date(2026, 9, 19).getTime())
})

test('periodStarts: months start on the 1st and cross the year boundary', () => {
  const { starts, end } = periodStarts('month', 12, new Date(2026, 9, 18).getTime())
  assert.equal(starts[11], new Date(2026, 9, 1).getTime())
  assert.equal(starts[0], new Date(2025, 10, 1).getTime())
  assert.equal(end, new Date(2026, 10, 1).getTime())
})

// ---- report ----

test('buildAggregates: buckets by local period, totals and series ordered by processed', () => {
  const now = new Date(2026, 9, 18, 14, 30).getTime()
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString()
  const chug = newFileState('c', 'chug1', false)
  ingestLine(chug, line({ id: 'a', ts: at(18, 9), cacheRead: 100, output: 1, cwd: 'C:\\projects\\chug' }))
  ingestLine(chug, line({ id: 'b', ts: at(17, 23, 59), cacheRead: 100, output: 1, cwd: 'C:\\projects\\chug' }))
  ingestLine(chug, line({ id: 'old', ts: at(1, 9), cacheRead: 999999, cwd: 'C:\\projects\\chug' })) // outside the window
  const hub = newFileState('h', 'hub1', false)
  ingestLine(hub, line({ id: 'c', ts: at(18, 10), cacheRead: 1000, output: 1, cwd: 'C:\\projects\\claude-hub' }))
  const hook = newFileState('h', 'hook1', false)
  ingestLine(hook, line({ id: 'd', ts: at(18, 11), input: 5, cwd: 'C:\\projects\\claude-hub', entrypoint: 'sdk-cli' }))

  const sessions = groupSessions(indexOf({ a: chug, b: hub, c: hook }))
  const agg = buildAggregates(sessions, claims, 'day', 2, now)
  assert.equal(agg.buckets.length, 2)
  assert.equal(agg.buckets[0].startIso, new Date(2026, 9, 17).toISOString())
  assert.equal(agg.buckets[0].values['project:p-chug'].processed, 101) // 23:59 local stays on the 17th
  assert.equal(agg.buckets[1].values['project:p-chug'].processed, 101)
  assert.equal(agg.buckets[1].values['project:p-hub'].processed, 1001)
  assert.equal(agg.totals['project:p-chug'].processed, 202)
  assert.equal(agg.totals['headless'].processed, 5)
  assert.deepEqual(
    agg.series.map((s) => s.key),
    ['project:p-hub', 'project:p-chug', 'headless'],
  )

  const month = buildAggregates(sessions, claims, 'month', 1, now)
  assert.equal(month.totals['project:p-chug'].processed, 202 + 999999)
})

test('sessionsFor: the drill-down for one key and range, largest first, with the last response time', () => {
  const now = new Date(2026, 9, 18, 14, 30).getTime()
  const at = (h: number, m: number) => new Date(2026, 9, 18, h, m).toISOString()
  const small = newFileState('c', 's-small', false)
  ingestLine(small, line({ id: 'a', ts: at(9, 0), output: 1 }))
  const big = newFileState('c', 's-big', false)
  ingestLine(big, line({ id: 'b', ts: at(9, 0), output: 100 }))
  ingestLine(big, line({ id: 'c', ts: at(10, 42), output: 100 }))
  const sessions = groupSessions(indexOf({ a: small, b: big }))
  const { starts, end } = periodStarts('day', 1, now)
  const rows = sessionsFor(sessions, claims, 'project:p-chug', starts[0], end)
  assert.deepEqual(
    rows.map((r) => r.group.sessionId),
    ['s-big', 's-small'],
  )
  assert.equal(rows[0].lastMs, new Date(2026, 9, 18, 10, 42).getTime())
  assert.equal(sessionsFor(sessions, claims, 'project:p-hub', starts[0], end).length, 0)
})
