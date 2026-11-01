import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DesktopSession, DesktopSnapshot } from '../../../shared/ipc-types.ts'
import {
  ChunkSequencer,
  defaultColor,
  defaultName,
  deskBody,
  errorText,
  dockOrder,
  formatDuration,
  groupDock,
  pickOnStage,
  reconcileStage,
  sessionTime,
  shrinkStage,
  summarize,
} from './desktop-model.ts'

function session(over: Partial<DesktopSession>): DesktopSession {
  return {
    id: 'd1',
    claudeSessionId: 'c1',
    name: 'one',
    color: 'frost',
    slot: 1,
    target: { kind: 'project', key: 'p1' },
    targetName: 'claude-hub',
    poppedOut: false,
    tier: null,
    createdAtIso: '2026-10-18T10:00:00.000Z',
    alive: true,
    state: 'working',
    stateDetail: null,
    lastActivityIso: null,
    contextPct: null,
    exitCode: null,
    ...over,
  }
}

test('dock groups in attention order, drops empty groups, keeps slot order inside a group', () => {
  const groups = groupDock([
    session({ id: 'a', slot: 3, state: 'your-turn' }),
    session({ id: 'b', slot: 2, state: 'working' }),
    session({ id: 'c', slot: 1, state: 'working' }),
    session({ id: 'd', slot: 4, state: 'needs-you' }),
  ])
  assert.deepEqual(
    groups.map((g) => [g.key, g.sessions.map((s) => s.id)]),
    [
      ['needs-you', ['d']],
      ['working', ['c', 'b']],
      ['your-turn', ['a']],
    ],
  )
})

test('Other holds starting, unknown and exited, live ones ahead of exited', () => {
  const groups = groupDock([
    session({ id: 'x', slot: 1, state: 'exited', alive: false }),
    session({ id: 'u', slot: 5, state: 'unknown' }),
    session({ id: 's', slot: 6, state: 'starting' }),
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].label, 'Other')
  assert.deepEqual(
    groups[0].sessions.map((s) => s.id),
    ['s', 'u', 'x'],
  )
  assert.deepEqual(dockOrder([session({ id: 'w', state: 'your-turn' }), session({ id: 'n', state: 'needs-you' })]), ['n', 'w'])
})

test('summary counts every record, plus the needs-you and working ones', () => {
  assert.deepEqual(
    summarize([
      session({ state: 'needs-you' }),
      session({ state: 'working' }),
      session({ state: 'working' }),
      session({ state: 'exited', alive: false }),
    ]),
    { total: 4, needsYou: 1, working: 2 },
  )
  assert.deepEqual(summarize([]), { total: 0, needsYou: 0, working: 0 })
})

test('durations are compact and a bad timestamp never renders NaN', () => {
  assert.equal(formatDuration(30_000), '<1m')
  assert.equal(formatDuration(42 * 60_000), '42m')
  assert.equal(formatDuration(65 * 60_000), '1h 05m')
  assert.equal(formatDuration(5 * 3_600_000 + 60_000), '5h')
  assert.equal(formatDuration(50 * 3_600_000), '2d')
  assert.equal(formatDuration(NaN), '—')
})

test('card time is idle time on your turn and exit, session age otherwise', () => {
  const now = Date.parse('2026-10-18T11:00:00.000Z')
  assert.equal(sessionTime(session({ state: 'working' }), now), '1h')
  assert.equal(sessionTime(session({ state: 'your-turn', lastActivityIso: '2026-10-18T10:34:00.000Z' }), now), 'idle 26m')
  assert.equal(sessionTime(session({ state: 'your-turn', lastActivityIso: null }), now), 'idle')
  assert.equal(sessionTime(session({ state: 'exited', lastActivityIso: '2026-10-18T10:50:00.000Z' }), now), 'ended 10m ago')
})

test('default name is the project name, numbered when taken', () => {
  assert.equal(defaultName('claude-hub', []), 'claude-hub')
  assert.equal(defaultName('claude-hub', [session({ name: 'claude-hub' })]), 'claude-hub 2')
  assert.equal(defaultName('claude-hub', [session({ name: 'claude-hub' }), session({ name: 'claude-hub 2' })]), 'claude-hub 3')
})

test('default colour skips colours live sessions wear, ignoring exited ones', () => {
  assert.equal(defaultColor([]), 'frost')
  assert.equal(defaultColor([session({ color: 'frost' }), session({ color: 'purple' })]), 'orange')
  assert.equal(defaultColor([session({ color: 'frost', alive: false, state: 'exited' })]), 'frost')
  const allSix = (['frost', 'purple', 'orange', 'blue', 'teal', 'lilac'] as const).map((color) => session({ color }))
  assert.equal(defaultColor([...allSix, session({ color: 'frost' })]), 'purple')
})

test('picking a session already on stage leaves every tile where it is', () => {
  const stage = ['a', 'b', 'c']
  assert.equal(pickOnStage(stage, 4, 'b', ['b', 'a', 'c']), stage)
})

test('picking a new session takes a free position, else displaces the least recent in place', () => {
  assert.deepEqual(pickOnStage(['a', 'b'], 4, 'c', ['a', 'b']), ['a', 'b', 'c'])
  // b was picked longest ago, so c lands in b's position.
  assert.deepEqual(pickOnStage(['a', 'b'], 2, 'c', ['a', 'b']), ['a', 'c'])
  // Never-picked tiles go first.
  assert.deepEqual(pickOnStage(['a', 'b'], 2, 'c', ['b']), ['c', 'b'])
  // Focus layout: one tile, always replaced.
  assert.deepEqual(pickOnStage(['a'], 1, 'b', ['a']), ['b'])
})

test('shrinking keeps the most recent tiles in positional order', () => {
  assert.deepEqual(shrinkStage(['a', 'b', 'c', 'd'], 2, ['c', 'a', 'd', 'b']), ['a', 'c'])
  assert.deepEqual(shrinkStage(['a', 'b'], 4, []), ['a', 'b'])
})

test('reconcile drops gone sessions, replacing them in place, and fills free positions', () => {
  // b was forgotten; d (most recently picked off-stage) takes its position.
  assert.deepEqual(reconcileStage(['a', 'b', 'c'], 4, ['a', 'c', 'd', 'e'], ['d']), ['a', 'd', 'c', 'e'])
  // Nothing to fill with: the stage compacts.
  assert.deepEqual(reconcileStage(['a', 'b'], 4, ['a'], []), ['a'])
  // Empty stage fills from dock order.
  assert.deepEqual(reconcileStage([], 2, ['n', 'w', 't'], []), ['n', 'w'])
  // Never over capacity.
  assert.deepEqual(reconcileStage(['a', 'b', 'c'], 1, ['a', 'b', 'c'], []), ['a'])
})

test('chunks that arrive before the screen are held, and only those newer than it are written', () => {
  const seq = new ChunkSequencer()
  assert.deepEqual(seq.push({ id: 'a', seq: 4, data: 'four' }), [])
  assert.deepEqual(seq.push({ id: 'a', seq: 6, data: 'six' }), [])
  assert.deepEqual(seq.push({ id: 'a', seq: 5, data: 'five' }), [])
  // The screen already includes chunk 4.
  assert.deepEqual(seq.seed(4), ['five', 'six'])
  assert.deepEqual(seq.push({ id: 'a', seq: 6, data: 'six again' }), [])
  assert.deepEqual(seq.push({ id: 'a', seq: 7, data: 'seven' }), ['seven'])
})

test('a failed screen fetch releases every held chunk in order', () => {
  const seq = new ChunkSequencer()
  seq.push({ id: 'a', seq: 2, data: 'b' })
  seq.push({ id: 'a', seq: 1, data: 'a' })
  assert.deepEqual(seq.seed(-Infinity), ['a', 'b'])
  assert.deepEqual(seq.push({ id: 'a', seq: 3, data: 'c' }), ['c'])
})

test('a screen newer than every held chunk writes none of them', () => {
  const seq = new ChunkSequencer()
  seq.push({ id: 'a', seq: 1, data: 'old' })
  assert.deepEqual(seq.seed(10), [])
  assert.deepEqual(seq.push({ id: 'a', seq: 10, data: 'dup' }), [])
  assert.deepEqual(seq.push({ id: 'a', seq: 11, data: 'new' }), ['new'])
})

test('deskBody: unreadable records are an error panel, never the empty state', () => {
  const snap = (over: Partial<DesktopSnapshot>): DesktopSnapshot => ({
    host: { state: 'down', error: null },
    records: { error: null },
    sessions: [],
    outside: { sessions: [], error: null },
    ...over,
  })
  assert.equal(deskBody(snap({ records: { error: 'desktop-sessions.json is unreadable' } })), 'records-error')
  assert.equal(deskBody(snap({ host: { state: 'down', error: 'host unreachable' } })), 'empty')
  assert.equal(deskBody(snap({})), 'empty')
  assert.equal(deskBody(snap({ sessions: [session({})] })), 'sessions')
})

test('errorText drops the IPC wrapper and keeps the message', () => {
  assert.equal(errorText(new Error("Error invoking remote method 'desktop:targets': Error: registry unreadable")), 'registry unreadable')
  assert.equal(errorText(new Error('plain')), 'plain')
  assert.equal(errorText('a string'), 'a string')
})
