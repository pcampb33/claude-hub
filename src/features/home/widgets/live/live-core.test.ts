import test from 'node:test'
import assert from 'node:assert/strict'
import { activitySentence, blockedOn, findSession, liveMeta, liveSessions, modelLabel, roomLeft, stateLabel, whereTimeWent } from './live-core.ts'
import type { LiveProjectStatus, SessionActivity } from '../../../../../shared/ipc-types.ts'

const turns = (inputs: number[]) => inputs.map((input) => ({ input, output: 100, tool: true }))
const p = (over: Partial<LiveProjectStatus>): LiveProjectStatus => ({ registryId: 'r', name: 'n', state: 'active', ...over })

test('room left: remaining context over the average growth of recent turns', () => {
  const r = roomLeft(p({ contextLimit: 1_000_000, contextTokens: 200_000, recentTurns: turns([190_000, 195_000, 200_000]) }))
  assert.deepEqual(r, { kind: 'estimate', turns: 160, perTurn: 5000 })
})

test('room left: only the last 10 turns set the rate', () => {
  const inputs = [0, 0, 0, ...Array.from({ length: 10 }, (_, i) => 100_000 + i * 1000)]
  const r = roomLeft(p({ contextLimit: 200_000, contextTokens: 109_000, recentTurns: turns(inputs) }))
  assert.deepEqual(r, { kind: 'estimate', turns: 91, perTurn: 1000 })
})

test('room left: one turn, a flat or shrinking curve, or no limit give no number', () => {
  assert.equal(roomLeft(p({ contextLimit: 1e6, contextTokens: 5, recentTurns: turns([5]) })).kind, 'too-few')
  assert.equal(roomLeft(p({ contextLimit: 1e6, contextTokens: 5, recentTurns: turns([9, 5]) })).kind, 'not-growing')
  assert.equal(roomLeft(p({ contextTokens: 5, recentTurns: turns([1, 5]) })).kind, 'unknown')
})

test('live sessions: ended ones are dropped, working sorts before idle', () => {
  const snap = {
    updatedAt: '',
    projects: [
      p({ registryId: 'a', state: 'idle', lastTimestamp: '2026-10-17T11:00:00Z' }),
      p({ registryId: 'b', state: 'ended' }),
      p({ registryId: 'c', state: 'active', lastTimestamp: '2026-10-17T10:00:00Z', sessionId: 'sc' }),
    ],
  }
  assert.deepEqual(
    liveSessions(snap).map((s) => s.registryId),
    ['c', 'a'],
  )
  assert.equal(findSession(snap, 'sc')?.registryId, 'c')
  assert.equal(liveMeta(liveSessions(snap)), '1 working · 1 idle')
})

test('live sessions: one waiting on you sorts first, counts apart, and never reads as idle', () => {
  const snap = {
    updatedAt: '',
    projects: [
      p({ registryId: 'a', state: 'active', lastTimestamp: '2026-10-17T11:00:00Z' }),
      p({ registryId: 'w', state: 'waiting', lastTimestamp: '2026-10-17T09:00:00Z', waitingFor: 'approve Bash: ls' }),
      p({ registryId: 'i', state: 'idle', lastTimestamp: '2026-10-17T12:00:00Z' }),
    ],
  }
  const live = liveSessions(snap)
  assert.deepEqual(live.map((s) => s.registryId), ['w', 'a', 'i'])
  assert.equal(liveMeta(live), '1 needs you · 1 working · 1 idle')
  assert.deepEqual(stateLabel(live[0]), { word: 'needs you', tone: 'danger' })
})

test('model label', () => {
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5')
  assert.equal(modelLabel('<synthetic>'), null)
  assert.equal(modelLabel('gpt-x'), 'gpt-x')
})

const act = (over: Partial<SessionActivity>): SessionActivity => ({
  windowStartMs: 0,
  endMs: 0,
  startMs: 0,
  segments: [],
  breaks: [],
  totals: {},
  breakMs: 0,
  breakCount: 0,
  waitedMs: 0,
  editsCount: 0,
  filesEdited: 0,
  ...over,
})
const clock = () => '13:02'

test('sentence: running a tool, then the edits, then how long it waited on you', () => {
  const a = act({
    editsCount: 14,
    filesEdited: 9,
    waitedMs: 20_000,
    now: { state: 'running', cat: 'edit', tool: 'Edit', target: 'src/App.css', sinceMs: 0 },
  })
  assert.equal(activitySentence(a, clock), 'Editing src/App.css · 14 edits in 9 files · waited on you <1m')
  const sh = act({ waitedMs: 2 * 3_600_000 + 6 * 60_000, now: { state: 'running', cat: 'shell', tool: 'Bash', target: 'npm test', sinceMs: 0 } })
  assert.equal(activitySentence(sh, clock), 'Running npm test · no edits yet · waited on you 2.1h')
})

test('sentence: a turn that is over says since when, and drops the waited clause', () => {
  const a = act({ editsCount: 3, filesEdited: 2, waitedMs: 600_000, now: { state: 'waiting', sinceMs: 1, tool: 'Edit', target: 'x' } })
  assert.equal(activitySentence(a, clock), 'Turn over — waiting on you since 13:02 · 3 edits in 2 files')
  const one = act({ editsCount: 1, filesEdited: 1, now: { state: 'thinking', sinceMs: 0, tool: 'Read', target: 'a.ts' } })
  assert.equal(activitySentence(one, clock), 'Thinking · last Read a.ts · 1 edit in 1 file · waited on you 0m')
})

test('sentence: a session blocked on a dialog says what it waits on, not the timeline’s "Thinking"', () => {
  const a = act({ editsCount: 1, filesEdited: 1, now: { state: 'thinking', sinceMs: 0, tool: 'Bash', target: 'ls app' } })
  assert.equal(activitySentence(a, clock, blockedOn(p({ state: 'waiting', waitingFor: 'approve Bash: npm test' }))), 'Waiting on you: approve Bash: npm test · 1 edit in 1 file')
  assert.equal(activitySentence(a, clock, blockedOn(p({ state: 'waiting' }))), 'Waiting on you · 1 edit in 1 file')
  assert.equal(blockedOn(p({ state: 'active' })), null)
})

test('where the time went: groups summed, largest first, breaks last', () => {
  const a = act({
    totals: { waiting: 7_200_000, thinking: 1_800_000, read: 60_000, web: 60_000, shell: 300_000 },
    breakCount: 2,
    breakMs: 18_000_000,
  })
  assert.equal(whereTimeWent(a), 'waiting on you 2.0h · thinking 30m · shell 5m · other tools 2m · 2 breaks over 2h (5.0h)')
  assert.equal(whereTimeWent(act({})), 'no time recorded yet')
})
