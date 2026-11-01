import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assignSlot,
  deriveDesktopState,
  feedTypedLine,
  isClearCommand,
  loadRecords,
  lowestFreeSlot,
  needsYouTransitions,
  resumeRefusal,
  saveRecords,
  startsWithClear,
  validateColor,
  validateName,
  validateSlot,
  validateTarget,
  type DesktopRecord,
  type StateInput,
} from './desktop-model.ts'
import type { DesktopSession, DesktopSnapshot } from '../shared/ipc-types.ts'

const rec = (id: string, slot: number): DesktopRecord => ({
  id,
  claudeSessionId: `c-${id}`,
  name: id,
  color: 'teal',
  slot,
  target: { kind: 'project', key: 'p1' },
  createdAtIso: '2026-10-18T00:00:00.000Z',
  exitCode: null,
})

test('validateName trims and enforces 1-60 chars, no control chars, no double quote', () => {
  assert.equal(validateName('  Fix the build  '), 'Fix the build')
  assert.equal(validateName('x'.repeat(60)), 'x'.repeat(60))
  assert.throws(() => validateName('   '), /1-60/)
  assert.throws(() => validateName('x'.repeat(61)), /1-60/)
  assert.throws(() => validateName('a\tb'), /control/)
  assert.throws(() => validateName('a\u007fb'), /control/)
  assert.throws(() => validateName('say "hi"'), /double quote/)
  assert.throws(() => validateName(42), /text/)
})

test('validateColor and validateSlot accept only the contract values', () => {
  assert.equal(validateColor('lilac'), 'lilac')
  assert.throws(() => validateColor('red'), /Color must be/)
  assert.equal(validateSlot(9), 9)
  for (const bad of [0, 10, 1.5, '3']) assert.throws(() => validateSlot(bad), /Slot must be/)
})

test('lowestFreeSlot takes the first gap and refuses a full desktop', () => {
  assert.equal(lowestFreeSlot([]), 1)
  assert.equal(lowestFreeSlot([rec('a', 1), rec('b', 3)]), 2)
  const full = Array.from({ length: 9 }, (_, i) => rec(`s${i}`, i + 1))
  assert.throws(() => lowestFreeSlot(full), /holds 9 sessions; forget an exited one first/)
})

test('assignSlot moves into a free slot, or swaps with the holder', () => {
  const records = [rec('a', 1), rec('b', 2)]
  assert.deepEqual(assignSlot(records, 'a', 5).map((r) => [r.id, r.slot]), [['a', 5], ['b', 2]])
  assert.deepEqual(assignSlot(records, 'a', 2).map((r) => [r.id, r.slot]), [['a', 2], ['b', 1]])
  assert.throws(() => assignSlot(records, 'zz', 3), /No such/)
})

test('loadRecords: missing file is empty but flagged missing; corrupt or malformed is an error, never empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-records-'))
  const file = path.join(dir, 'desktop-sessions.json')
  try {
    // Flagged so the orphan reaper can tell "removed" from "no sessions".
    assert.deepEqual(loadRecords(file), { ok: true, records: [], missing: true })
    saveRecords(file, [])
    assert.deepEqual(loadRecords(file), { ok: true, records: [] })
    saveRecords(file, [rec('a', 1)])
    assert.deepEqual(loadRecords(file), { ok: true, records: [rec('a', 1)] })
    for (const bad of [
      '{ not json',
      '[]',
      JSON.stringify({ version: 3, sessions: [] }),
      JSON.stringify({ version: 2, sessions: [{ ...rec('a', 1), color: 'red' }] }),
      JSON.stringify({ version: 2, sessions: [rec('a', 1), rec('b', 1)] }),
      JSON.stringify({ version: 2, sessions: [rec('a', 1), rec('a', 2)] }),
    ]) {
      fs.writeFileSync(file, bad)
      const loaded = loadRecords(file)
      assert.equal(loaded.ok, false, bad)
      assert.match(loaded.ok ? '' : loaded.error, /won't overwrite/)
      // Removing it would lose every session's resume id: never advised.
      assert.doesNotMatch(loaded.ok ? '' : loaded.error, /remove|move|delete/)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('records: a version-1 file (projectId) reads as project targets and is saved back as version 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-records-v1-'))
  const file = path.join(dir, 'desktop-sessions.json')
  try {
    const { target: _target, ...v1 } = { ...rec('a', 1), projectId: 'p1' }
    void _target
    fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: [v1] }))
    const loaded = loadRecords(file)
    assert.deepEqual(loaded, { ok: true, records: [rec('a', 1)] })
    saveRecords(file, loaded.ok ? loaded.records : [])
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as { version: number; sessions: Record<string, unknown>[] }
    assert.equal(saved.version, 2)
    assert.deepEqual(saved.sessions[0].target, { kind: 'project', key: 'p1' })
    assert.equal('projectId' in saved.sessions[0], false)

    const experiment = { ...rec('b', 2), target: { kind: 'experiment', key: 'tiny-exp' } }
    fs.writeFileSync(file, JSON.stringify({ version: 2, sessions: [experiment] }))
    assert.deepEqual(loadRecords(file), { ok: true, records: [experiment] })

    // Each version's own shape only, and a target the desktop can resolve.
    for (const bad of [
      { version: 1, sessions: [rec('a', 1)] }, // v1 without projectId
      { version: 2, sessions: [v1] }, // v2 without target
      { version: 2, sessions: [{ ...rec('a', 1), target: { kind: 'path', key: 'C:\\x' } }] },
      { version: 2, sessions: [{ ...rec('a', 1), target: { kind: 'project', key: '' } }] },
      { version: 3, sessions: [] },
    ]) {
      fs.writeFileSync(file, JSON.stringify(bad))
      const result = loadRecords(file)
      assert.equal(result.ok, false, JSON.stringify(bad))
      assert.equal(fs.readFileSync(file, 'utf-8'), JSON.stringify(bad), 'never rewritten')
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('validateTarget accepts a project or experiment key only', () => {
  assert.deepEqual(validateTarget({ kind: 'experiment', key: 'x', extra: 1 }), { kind: 'experiment', key: 'x' })
  for (const bad of [null, 'p1', { kind: 'project' }, { kind: 'folder', key: 'x' }, { kind: 'project', key: 3 }]) {
    assert.throws(() => validateTarget(bad), /project or an experiment/)
  }
})

test('resumeRefusal: already on the desktop, running elsewhere, or unverifiable', () => {
  const records = [rec('a', 1)]
  const none = { sessions: [], error: null }
  assert.match(resumeRefusal('c-a', records, new Set(['a']), none) ?? '', /already open on the desktop as "a"/)
  assert.match(resumeRefusal('c-a', records, new Set(), none) ?? '', /already on the desktop as "a"; resume it there/)
  const elsewhere = { sessions: [{ pid: 9, sessionId: 'x', name: '', cwd: '', target: null, targetName: null, status: 'idle' as const, updatedAtIso: null }], error: null }
  assert.match(resumeRefusal('x', records, new Set(), elsewhere) ?? '', /another terminal \(pid 9\); take it over instead/)
  assert.match(resumeRefusal('x', records, new Set(), { sessions: null, error: 'no folder' }) ?? '', /Couldn't check .*: no folder/)
  assert.equal(resumeRefusal('y', records, new Set(), elsewhere), null)
})

const T0 = '2026-10-18T10:00:00.000Z'
const user = (ts = T0) => JSON.stringify({ type: 'user', timestamp: ts })
const assistant = (tool?: string, ts = '2026-10-18T10:00:05.000Z') =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      model: 'claude-opus-5',
      usage: { input_tokens: 100_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 50_000, output_tokens: 10 },
      content: tool ? [{ type: 'tool_use', name: tool }] : [{ type: 'text', text: 'hi' }],
    },
  })
const close = JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: '2026-10-18T10:00:09.000Z' })
const lines = (...l: string[]): StateInput['transcript'] => ({ kind: 'lines', lines: l })
const input = (over: Partial<StateInput>): StateInput => ({ alive: true, hostUnreachable: false, prompt: null, transcript: { kind: 'missing' }, ...over })

test('state: not alive is exited, but still reports the transcript facts', () => {
  const s = deriveDesktopState(input({ alive: false, transcript: lines(user(), assistant()) }))
  assert.equal(s.state, 'exited')
  assert.equal(s.lastActivityIso, '2026-10-18T10:00:05.000Z')
  assert.equal(s.contextPct, 20) // 200k of a 1M opus window
})

test('state: an unreachable host makes no claim', () => {
  assert.equal(deriveDesktopState(input({ hostUnreachable: true, alive: false })).state, 'unknown')
})

test('state: a menu on screen is needs-you, with the question as detail, ahead of everything else', () => {
  const s = deriveDesktopState(input({ prompt: { line: 'Do you want to proceed?' }, transcript: lines(user(), assistant('Bash')) }))
  assert.deepEqual([s.state, s.stateDetail], ['needs-you', 'Do you want to proceed?'])
  assert.equal(deriveDesktopState(input({ prompt: { line: null } })).state, 'needs-you')
})

test('state: no transcript yet, or one with no turns, is starting', () => {
  for (const transcript of [{ kind: 'missing' } as const, lines(JSON.stringify({ type: 'mode' }))]) {
    const s = deriveDesktopState(input({ transcript }))
    assert.deepEqual([s.state, s.stateDetail], ['starting', 'waiting for the first prompt'])
  }
})

test('state: an open turn is working with the last tool, however old', () => {
  const old = '2020-01-01T00:00:00.000Z'
  const s = deriveDesktopState(input({ transcript: lines(user(old), assistant('Read', old), assistant('Bash', old)) }))
  assert.deepEqual([s.state, s.stateDetail], ['working', 'Bash'])
  // A tool from the previous, closed turn is not this turn's tool.
  const fresh = deriveDesktopState(input({ transcript: lines(user(), assistant('Edit'), close, user()) }))
  assert.deepEqual([fresh.state, fresh.stateDetail], ['working', null])
})

test('state: a closed turn is your-turn; an unreadable transcript is unknown', () => {
  assert.equal(deriveDesktopState(input({ transcript: lines(user(), assistant('Bash'), close) })).state, 'your-turn')
  const stop = JSON.stringify({ type: 'system', subtype: 'stop_hook_summary' })
  assert.equal(deriveDesktopState(input({ transcript: lines(user(), assistant(), stop, '{"partial') })).state, 'your-turn')
  assert.equal(deriveDesktopState(input({ transcript: { kind: 'unreadable' } })).state, 'unknown')
})

test("state: Claude Code's own status wins over the transcript, but not over a menu or a dead process", () => {
  // busy = working even when the transcript says the turn closed (it lags).
  const busy = deriveDesktopState(input({ claudeStatus: 'busy', transcript: lines(user(), assistant('Bash'), close) }))
  assert.deepEqual([busy.state, busy.stateDetail], ['working', null])
  // shell stays set while a background process the session started runs on
  // (measured: 12 minutes after turn_duration), so only an open turn is work.
  const bg = deriveDesktopState(input({ claudeStatus: 'shell', transcript: lines(user(), assistant('Bash'), close) }))
  assert.deepEqual([bg.state, bg.stateDetail], ['your-turn', 'a background process it started is still running'])
  assert.equal(deriveDesktopState(input({ claudeStatus: 'shell', transcript: lines(user(), assistant('Bash')) })).state, 'working')
  assert.deepEqual(
    (({ state, stateDetail }) => [state, stateDetail])(deriveDesktopState(input({ claudeStatus: 'busy', transcript: lines(user(), assistant('Edit')) }))),
    ['working', 'Edit'],
  )
  // idle = your turn even while the transcript still shows the turn open...
  assert.equal(deriveDesktopState(input({ claudeStatus: 'idle', transcript: lines(user(), assistant('Bash')) })).state, 'your-turn')
  // ...or can't be read; a session with no turns yet is still starting.
  assert.equal(deriveDesktopState(input({ claudeStatus: 'idle', transcript: { kind: 'unreadable' } })).state, 'your-turn')
  assert.equal(deriveDesktopState(input({ claudeStatus: 'idle' })).state, 'starting')
  // 'unknown' or absent falls back to the transcript.
  assert.equal(deriveDesktopState(input({ claudeStatus: 'unknown', transcript: lines(user(), assistant('Bash')) })).state, 'working')
  assert.equal(deriveDesktopState(input({ claudeStatus: null, transcript: lines(user(), assistant(), close) })).state, 'your-turn')
  // The on-screen menu and a dead process still come first.
  assert.equal(deriveDesktopState(input({ claudeStatus: 'busy', prompt: { line: 'Proceed?' } })).state, 'needs-you')
  assert.equal(deriveDesktopState(input({ claudeStatus: 'idle', alive: false })).state, 'exited')
})

// Esc writes "[Request interrupted by user…]" and a local slash command writes
// its <command-name>/<local-command-*> lines; neither writes turn_duration.
test('state: an interrupt or a local slash command closes the turn', () => {
  const userText = (content: unknown) => JSON.stringify({ type: 'user', timestamp: '2026-10-18T10:00:07.000Z', message: { role: 'user', content } })
  const closers = [
    userText([{ type: 'text', text: '[Request interrupted by user]' }]),
    userText([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
    userText('[Request interrupted by user]'),
    userText('<command-name>/config</command-name>\n            <command-message>config</command-message>\n            <command-args></command-args>'),
    userText('<local-command-stdout>Login successful</local-command-stdout>'),
    userText('<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>'),
  ]
  for (const closer of closers) {
    const s = deriveDesktopState(input({ transcript: lines(user(), assistant('Bash'), closer) }))
    assert.deepEqual([s.state, s.stateDetail], ['your-turn', null], closer)
    assert.equal(s.lastActivityIso, '2026-10-18T10:00:07.000Z')
  }
  // A local command as the session's very first line is still your turn, not "starting".
  assert.equal(deriveDesktopState(input({ transcript: lines(closers[3]) })).state, 'your-turn')
  // Ordinary prompts and tool results still open (or keep open) the turn.
  assert.equal(deriveDesktopState(input({ transcript: lines(user(), assistant(), close, userText('fix the build')) })).state, 'working')
  assert.equal(deriveDesktopState(input({ transcript: lines(user(), assistant('Bash'), userText([{ type: 'tool_result', content: 'ok' }])) })).state, 'working')
})

test('feedTypedLine rebuilds the submitted line from keystrokes; escapes and control keys make it unknown', () => {
  const feed = (...chunks: string[]) => {
    let buffer = ''
    const submitted: string[] = []
    for (const c of chunks) {
      const r = feedTypedLine(buffer, c)
      buffer = r.buffer
      submitted.push(...r.submitted)
    }
    return { buffer, submitted }
  }
  assert.deepEqual(feed('/', 'c', 'l', 'e', 'x', '\x7f', 'a', 'r', '\r'), { buffer: '', submitted: ['/clear'] })
  assert.deepEqual(feed('/clear\r'), { buffer: '', submitted: ['/clear'] })
  assert.deepEqual(feed('ab\bc', 'd'), { buffer: 'acd', submitted: [] })
  // Arrow keys / Shift+Enter / Tab completion: the line is no longer known.
  assert.deepEqual(feed('/cl', '\x1b[A', 'ear\r'), { buffer: '', submitted: ['ear'] })
  assert.deepEqual(feed('/cl', '\t', '\r'), { buffer: '', submitted: [''] })
  assert.deepEqual(feed('x\ry\r'), { buffer: '', submitted: ['x', 'y'] })
  assert.equal(feed('a'.repeat(1000)).buffer.length, 256)
})

test('isClearCommand and startsWithClear', () => {
  for (const yes of ['/clear', '  /clear ', '/clear now']) assert.equal(isClearCommand(yes), true, yes)
  for (const no of ['/clearer', 'clear', '/compact', 'please /clear']) assert.equal(isClearCommand(no), false, no)
  const clearLine = JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>' } })
  assert.equal(startsWithClear([JSON.stringify({ type: 'mode' }), clearLine]), true)
  assert.equal(startsWithClear([JSON.stringify({ type: 'user', message: { role: 'user', content: 'Summarize <command-name>/clear</command-name>' } })]), false)
  assert.equal(startsWithClear(['{"partial']), false)
})

const session = (id: string, state: DesktopSession['state']): DesktopSession => ({
  ...rec(id, 1),
  target: { kind: 'project', key: 'p1' },
  targetName: 'p',
  poppedOut: false,
  tier: null,
  alive: true,
  state,
  stateDetail: null,
  lastActivityIso: null,
  contextPct: null,
})
const snapshot = (...sessions: DesktopSession[]): DesktopSnapshot => ({ host: { state: 'up', error: null }, records: { error: null }, sessions, outside: { sessions: [], error: null } })

test('needsYouTransitions fires on entering needs-you only, never on the first snapshot', () => {
  const next = snapshot(session('a', 'needs-you'), session('b', 'needs-you'), session('c', 'working'))
  assert.deepEqual(needsYouTransitions(null, next), [])
  const prev = snapshot(session('a', 'working'), session('b', 'needs-you'))
  assert.deepEqual(needsYouTransitions(prev, next).map((s) => s.id), ['a'])
})
