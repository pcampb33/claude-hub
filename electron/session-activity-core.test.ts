import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BREAK_MS,
  MAX_SEGMENTS,
  WINDOW_MS,
  buildActivity,
  classify,
  parseTranscript,
  readSessionActivity,
} from './session-activity-core.ts'
import type { SessionActivity } from '../shared/ipc-types.ts'

// Synthetic transcripts in the real line shapes. Times are seconds from T0.
const T0 = Date.parse('2026-06-15T10:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const L = (o: object) => JSON.stringify(o)
const prompt = (s: number, text = 'do the thing') =>
  L({ type: 'user', timestamp: at(s), origin: { kind: 'human' }, message: { role: 'user', content: text } })
const say = (s: number, text = 'ok') =>
  L({ type: 'assistant', timestamp: at(s), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }] } })
const use = (s: number, id: string, name: string, input: object = {}) =>
  L({ type: 'assistant', timestamp: at(s), message: { content: [{ type: 'tool_use', id, name, input }] } })
const result = (s: number, id: string, source = 'config') =>
  L({
    type: 'user',
    timestamp: at(s),
    permissionDecision: { decision: 'accept', source },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
  })
const turnEnd = (s: number) => L({ type: 'system', subtype: 'turn_duration', timestamp: at(s) })
const notification = (s: number) =>
  L({ type: 'user', timestamp: at(s), origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>agent done</task-notification>' } })
const userText = (s: number, text: string, extra: object = {}) =>
  L({ type: 'user', timestamp: at(s), ...extra, message: { role: 'user', content: [{ type: 'text', text }] } })

const sec = (ms: number) => (ms - T0) / 1000
const segs = (lines: string[]) =>
  classify(parseTranscript(lines.join('\n')).events).segments.map((x) => [sec(x.startMs), sec(x.endMs), x.kind])

// The invariant every timeline must hold: segments + breaks tile the span.
function assertTiles(a: SessionActivity) {
  const sum = [...a.segments, ...a.breaks].reduce((t, x) => t + (x.endMs - x.startMs), 0)
  assert.equal(sum, a.endMs - a.windowStartMs, 'segments + breaks must sum exactly to the window span')
  const items = [...a.segments, ...a.breaks].sort((x, y) => x.startMs - y.startMs)
  for (let i = 1; i < items.length; i++) assert.equal(items[i].startMs, items[i - 1].endMs, 'no gaps or overlaps')
}
function assertFullTiles(lines: string[]) {
  const st = parseTranscript(lines.join('\n'))
  const { segments, breaks } = classify(st.events)
  const sum = [...segments, ...breaks].reduce((t, x) => t + (x.endMs - x.startMs), 0)
  assert.equal(sum, st.events[st.events.length - 1].ts - st.events[0].ts, 'full-session segments + breaks = wall span')
}

test('a turn: thinking, a running tool, thinking, then waiting on you until the next prompt', () => {
  const lines = [prompt(0), use(10, 't1', 'Bash', { command: 'npm test' }), result(70, 't1'), say(80), turnEnd(81), prompt(600)]
  assert.deepEqual(segs(lines), [
    [0, 10, 'thinking'],
    [10, 70, 'shell'],
    [70, 80, 'thinking'],
    [80, 600, 'waiting'],
  ])
  assertFullTiles(lines)
})

test('each tool category gets its own kind; a permission you clicked counts as waiting', () => {
  const lines = [
    prompt(0),
    use(1, 'e', 'Edit', { file_path: 'C:/p/a.ts' }),
    result(2, 'e'),
    use(2, 'r', 'Grep', { pattern: 'x' }),
    result(3, 'r'),
    use(3, 'a', 'Agent', { description: 'scan' }),
    result(10, 'a'),
    use(10, 'w', 'WebFetch', { url: 'https://x' }),
    result(12, 'w'),
    use(12, 'o', 'Skill', { skill: 'x' }),
    result(13, 'o'),
    use(13, 'b', 'Bash', { command: 'rm -rf x' }),
    result(40, 'b', 'user_temporary'),
    say(41),
  ]
  assert.deepEqual(segs(lines), [
    [0, 1, 'thinking'],
    [1, 2, 'edit'],
    [2, 3, 'read'],
    [3, 10, 'agent'],
    [10, 12, 'web'],
    [12, 13, 'other'],
    [13, 40, 'waiting'],
    [40, 41, 'thinking'],
  ])
})

test('an interrupted turn: the tool ran, then the session waited on you; the state reads waiting', () => {
  const head = [prompt(0), use(5, 't', 'Bash', { command: 'sleep 99' }), result(20, 't'), userText(20, '[Request interrupted by user for tool use]')]
  const lines = [...head, prompt(120)]
  assert.deepEqual(segs(lines), [
    [0, 5, 'thinking'],
    [5, 20, 'shell'],
    [20, 120, 'waiting'],
  ])
  assertFullTiles(lines)
  // Interrupts write no turn-close line; the marker alone ends the turn.
  const a = buildActivity(parseTranscript(head.join('\n')))
  assert.equal(a.now?.state, 'waiting')
})

test('a slash command the model answers is a prompt; one it does not answer is not', () => {
  const lines = [
    prompt(0),
    say(10),
    turnEnd(11),
    userText(100, '<command-name>/handoff</command-name>'),
    userText(100, 'expanded skill body', { isMeta: true }),
    say(110),
    turnEnd(111),
    userText(200, '<command-name>/model</command-name>'),
    userText(200, '<local-command-stdout>Set model</local-command-stdout>'),
    prompt(300),
  ]
  assert.deepEqual(segs(lines), [
    [0, 10, 'thinking'],
    [10, 100, 'waiting'], // ended by /handoff, which the model answered
    [100, 110, 'thinking'],
    [110, 300, 'waiting'], // /model got no reply, so the wait runs on to the prompt
  ])
  assertFullTiles(lines)
})

test('a `!` bash-mode command is not a prompt: the wait on you runs on through it', () => {
  // Real shape: plain-string content, no origin, no isMeta.
  const bash = (s: number, text: string) => L({ type: 'user', timestamp: at(s), message: { role: 'user', content: text } })
  const head = [prompt(0), say(60), turnEnd(61), bash(600, '<bash-input>git status</bash-input>'), bash(602, '<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>')]
  const lines = [...head, prompt(2400)]
  assert.deepEqual(segs(lines), [
    [0, 60, 'thinking'],
    [60, 2400, 'waiting'],
  ])
  assertFullTiles(lines)
  assert.equal(buildActivity(parseTranscript(head.join('\n'))).now?.state, 'waiting')
})

test('a quiet stretch broken by an agent notification, not you, is background', () => {
  const lines = [
    prompt(0),
    use(1, 'a', 'Agent', { description: 'bg', run_in_background: true }),
    result(2, 'a'),
    say(3),
    turnEnd(4),
    notification(1000),
    say(1010),
    turnEnd(1011),
    prompt(2000),
  ]
  assert.deepEqual(segs(lines), [
    [0, 1, 'thinking'],
    [1, 2, 'agent'],
    [2, 3, 'thinking'],
    [3, 1000, 'background'],
    [1000, 1010, 'thinking'],
    [1010, 2000, 'waiting'],
  ])
  assertFullTiles(lines)
})

test('a gap over 2h becomes a break and the span still tiles exactly', () => {
  const long = BREAK_MS / 1000 + 600
  const lines = [prompt(0), say(10), turnEnd(11), prompt(11 + long), say(11 + long + 5)]
  const st = parseTranscript(lines.join('\n'))
  const { breaks, segments } = classify(st.events)
  assert.deepEqual(breaks.map((b) => [sec(b.startMs), sec(b.endMs)]), [[11, 11 + long]])
  assert.deepEqual(segments.map((x) => x.kind), ['thinking', 'waiting', 'thinking'])
  const a = buildActivity(st)
  assert.equal(a.breakCount, 1)
  assert.equal(a.breakMs, long * 1000)
  assert.equal(a.waitedMs, 1000, 'the break is not counted as in-session waiting')
  assertTiles(a)
  assertFullTiles(lines)
})

test('out-of-order timestamps are clamped, so the tiling still holds', () => {
  const lines = [prompt(0), say(50), use(40, 't', 'Read', { file_path: 'x' }), result(60, 't'), say(70)]
  assertFullTiles(lines)
  assertTiles(buildActivity(parseTranscript(lines.join('\n'))))
})

test('request blobs, sidechain lines, bookkeeping and partial lines never become events', () => {
  const blob = L({ type: 'api-request-blob', message: { role: 'user', content: [{ type: 'text', text: '"type":"user"' }] } })
  const side = L({ type: 'assistant', isSidechain: true, timestamp: at(5), message: { content: [] } })
  const st = parseTranscript([prompt(0), blob, side, L({ type: 'ai-title', aiTitle: 'x' }), '{"type":"user","timest', say(10)].join('\n'))
  assert.equal(st.events.length, 2)
})

test('edits: counted once per tool_use id, distinct files case-insensitively; targets relative to the project', () => {
  const cwdLine = L({ type: 'user', cwd: 'C:\\proj', timestamp: at(0), origin: { kind: 'human' }, message: { role: 'user', content: 'go' } })
  const e1 = use(1, 'e1', 'Edit', { file_path: 'C:\\proj\\src\\App.css' })
  const lines = [cwdLine, e1, e1, result(2, 'e1'), use(3, 'e2', 'Write', { file_path: 'c:/proj/src/app.css' }), result(4, 'e2'), use(5, 'e3', 'Edit', { file_path: 'C:/proj/b.ts' })]
  const a = buildActivity(parseTranscript(lines.join('\n')))
  assert.equal(a.editsCount, 3)
  assert.equal(a.filesEdited, 2)
  assert.deepEqual(a.now, { state: 'running', cat: 'edit', tool: 'Edit', target: 'b.ts', sinceMs: T0 + 5000 })
  const out = buildActivity(parseTranscript([cwdLine, use(1, 'x', 'Read', { file_path: 'D:/other/deep/dir/file.md' })].join('\n')))
  assert.equal(out.now?.state === 'running' && out.now.target, '…/dir/file.md')
})

test('the state at the newest line: thinking mid-turn, waiting after the turn closes', () => {
  const mid = buildActivity(parseTranscript([prompt(0), use(1, 't', 'Bash'), result(9, 't')].join('\n')))
  assert.deepEqual(mid.now, { state: 'thinking', sinceMs: T0 + 9000, tool: 'Bash', target: '' })
  const done = buildActivity(parseTranscript([prompt(0), say(4), turnEnd(5)].join('\n')))
  assert.deepEqual(done.now, { state: 'waiting', sinceMs: T0 + 4000 })
})

test('payload cap: only the last 6h of wall time, at most MAX_SEGMENTS, and still exact', () => {
  // 8h of alternating 15s tool runs and 15s thinking: ~1900 raw segments.
  const lines = [prompt(0)]
  let t = 0
  for (let i = 0; t < 8 * 3600; i++) {
    lines.push(use(t + 15, `t${i}`, i % 3 ? 'Bash' : 'Edit', { command: 'x', file_path: `f${i % 7}` }), result(t + 30, `t${i}`))
    t += 30
  }
  const st = parseTranscript(lines.join('\n'))
  const full = classify(st.events)
  assert.ok(full.segments.length > 1000)
  const a = buildActivity(st)
  assert.ok(a.segments.length <= MAX_SEGMENTS, `${a.segments.length} segments`)
  assert.equal(a.endMs - a.windowStartMs, WINDOW_MS)
  assert.equal(a.segments[0].startMs, a.windowStartMs)
  assertTiles(a)
  assert.ok(JSON.stringify(a).length < 20_000, `payload ${JSON.stringify(a).length}B`)
  // Totals are whole-session, not window.
  assert.equal(Object.values(a.totals).reduce((x, y) => x + y, 0), a.endMs - a.startMs)
})

test('incremental reads: appending (even mid-line) gives the same result as one full parse', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 's.jsonl')
  const lines = [prompt(0), use(10, 't1', 'Bash', { command: 'npm test' }), result(70, 't1'), say(80), turnEnd(81), prompt(600), say(610)]
  const text = lines.join('\n') + '\n'
  const cut = text.indexOf('npm test') // split inside a line
  fs.writeFileSync(file, text.slice(0, cut))
  const first = readSessionActivity(file)
  assert.equal(first.endMs, T0, 'the partial line is not parsed yet')
  fs.appendFileSync(file, text.slice(cut, text.length - 40))
  readSessionActivity(file)
  fs.appendFileSync(file, text.slice(text.length - 40))
  assert.deepEqual(readSessionActivity(file), buildActivity(parseTranscript(text)))
})

test('a file that shrank is re-read from the start, not appended to', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 's.jsonl')
  fs.writeFileSync(file, [prompt(0), say(10), turnEnd(11), prompt(500), say(520)].join('\n') + '\n')
  readSessionActivity(file)
  const shorter = [prompt(0), use(3, 'x', 'Read', { file_path: 'a' }), result(4, 'x')].join('\n') + '\n'
  fs.writeFileSync(file, shorter)
  assert.deepEqual(readSessionActivity(file), buildActivity(parseTranscript(shorter)))
})

test('an unreadable transcript throws (the caller turns it into activityError), never an empty timeline', () => {
  assert.throws(() => readSessionActivity(path.join(os.tmpdir(), 'no-such-dir-xyz', 'gone.jsonl')))
})
