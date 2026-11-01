import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DesktopLaunchTargets, DesktopRecentSession, DesktopSession, OutsideSession } from '../../../shared/ipc-types.ts'
import { defaultColor } from './desktop-model.ts'
import {
  actionLabel,
  autoName,
  buildModel,
  chooseTab,
  emptyNote,
  filterRows,
  launcherView,
  launchSpec,
  moveHighlight,
  navRows,
  SEARCH_CAP,
  TAB_CAP,
  trimTitle,
  visibleTabs,
  type GroupKey,
  type LauncherModel,
  type LauncherRow,
} from './launcher-model.ts'

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

function outside(over: Partial<OutsideSession>): OutsideSession {
  return {
    pid: 100,
    sessionId: 'o1',
    name: '',
    cwd: 'C:\\projects\\claude-hub',
    target: { kind: 'project', key: 'p1' },
    targetName: 'claude-hub',
    status: 'idle',
    updatedAtIso: '2026-10-18T09:00:00.000Z',
    ...over,
  }
}

const hubConv = (sessionId: string, title: string, day: string): DesktopRecentSession => ({
  sessionId,
  title,
  target: { kind: 'project', key: 'p1' },
  targetName: 'claude-hub',
  lastActivityIso: `2026-10-${day}T00:00:00.000Z`,
  liveElsewhere: false,
})

const launch: DesktopLaunchTargets = {
  targets: [
    { kind: 'project', key: 'p2', name: 'billing', lastActivityIso: null },
    { kind: 'experiment', key: 'garden', name: 'garden-app', lastActivityIso: '2026-10-17T00:00:00.000Z' },
    { kind: 'project', key: 'p1', name: 'claude-hub', lastActivityIso: '2026-10-18T00:00:00.000Z' },
    { kind: 'project', key: 'p3', name: 'atlas', lastActivityIso: null },
  ],
  recent: [
    hubConv('r-old', 'Fix the login flow', '10'),
    { sessionId: 'r-new', title: 'Garden watering schedule', target: { kind: 'experiment', key: 'garden' }, targetName: 'garden-app', lastActivityIso: '2026-10-17T00:00:00.000Z', liveElsewhere: false },
    { ...hubConv('c1', 'Already on the desktop', '18') },
    { ...hubConv('o1', 'Running elsewhere', '18'), liveElsewhere: true },
    { sessionId: 'r-orphan', title: 'Live but unmatched', target: { kind: 'project', key: 'p2' }, targetName: 'billing', lastActivityIso: '2026-10-01T00:00:00.000Z', liveElsewhere: true },
  ],
  error: null,
}

const sessions = [session({})]
const none = new Set<GroupKey>()
const keys = (rows: LauncherRow[]) => rows.map((r) => r.key)
const allRows = (m: LauncherModel) => [...m.continue.flatMap((r) => [r, ...r.older]), ...m.new, ...m.takeover]
const withRecent = (...extra: DesktopRecentSession[]): DesktopLaunchTargets => ({ ...launch, recent: [...launch.recent, ...extra] })

test('Continue: one row per place, its latest conversation, the older ones under it', () => {
  const m = buildModel({ outside: [], launch: withRecent(hubConv('r-mid', 'Tidy the dock', '12')), sessions })
  // c1 is on the desktop: never offered. o1 has no outside process, so it stays (unavailable).
  assert.deepEqual(
    m.continue.map((r) => [r.key, keys(r.older)]),
    [
      ['recent:o1', ['recent:r-mid', 'recent:r-old']],
      ['recent:r-new', []],
      ['recent:r-orphan', []],
    ],
  )
  assert.equal(m.continue[0].where, 'claude-hub')
})

test('a conversation live in another terminal is offered only as a take-over', () => {
  const m = buildModel({ outside: [outside({})], launch, sessions })
  assert.deepEqual(keys(m.takeover), ['outside:o1'])
  assert.ok(!keys(allRows(m)).includes('recent:o1'))
  assert.deepEqual(
    m.continue.map((r) => [r.key, keys(r.older)]),
    [
      ['recent:r-new', []],
      ['recent:r-old', []],
      ['recent:r-orphan', []],
    ],
  )
})

test('New: projects and experiments in one list, recent activity first, never-used last by name', () => {
  const m = buildModel({ outside: [], launch, sessions })
  assert.deepEqual(keys(m.new), ['project:p1', 'experiment:garden', 'project:p3', 'project:p2'])
  assert.deepEqual(
    m.new.map((r) => r.where),
    ['project', 'experiment', 'project', 'project'],
  )
})

test('primary action per row kind', () => {
  const m = buildModel({ outside: [outside({}), outside({ sessionId: 'o2', pid: 7, target: null, targetName: null, cwd: 'D:\\scratch\\tool' })], launch, sessions })
  const by = (key: string) => allRows(m).find((r) => r.key === key)!
  assert.deepEqual(by('outside:o1').action, { kind: 'take-over', pid: 100, sessionId: 'o1' })
  // Not a known project or experiment: the desktop has nowhere to run it.
  assert.equal(by('outside:o2').action.kind, 'unavailable')
  assert.equal(by('outside:o2').where, 'tool')
  assert.deepEqual(by('recent:r-old').action, { kind: 'resume', target: { kind: 'project', key: 'p1' }, sessionId: 'r-old' })
  // Live elsewhere but no process to take over: no action, and it says why.
  assert.equal(by('recent:r-orphan').action.kind, 'unavailable')
  assert.deepEqual(by('experiment:garden').action, { kind: 'new', target: { kind: 'experiment', key: 'garden' } })
  assert.deepEqual(
    ['outside:o1', 'recent:r-old', 'project:p1', 'outside:o2'].map((k) => actionLabel(by(k).action)),
    ['Take over', 'Resume', 'New session', null],
  )
})

test('an unreadable outside list and a pending target list still build', () => {
  const m = buildModel({ outside: null, launch: null, sessions })
  assert.deepEqual([m.continue.length, m.new.length, m.takeover.length], [0, 0, 0])
})

test('Take over is a tab only while something runs in another terminal', () => {
  assert.deepEqual(visibleTabs(buildModel({ outside: [], launch, sessions })), ['continue', 'new'])
  assert.deepEqual(visibleTabs(buildModel({ outside: null, launch, sessions })), ['continue', 'new'])
  assert.deepEqual(visibleTabs(buildModel({ outside: [outside({})], launch, sessions })), ['continue', 'new', 'takeover'])
})

test('tabs: the first TAB_CAP rows, all of them once shown all, and no other group', () => {
  const targets = Array.from({ length: 12 }, (_, i) => ({ kind: 'project' as const, key: `k${i}`, name: `p${String(i).padStart(2, '0')}`, lastActivityIso: null }))
  const m = buildModel({ outside: [], launch: { ...launch, targets }, sessions })
  const [capped] = launcherView(m, 'new', '', none)
  assert.equal(capped.label, 'New')
  assert.equal(capped.rows.length, TAB_CAP)
  assert.equal(capped.total, 12)
  const [all] = launcherView(m, 'new', '', new Set<GroupKey>(['new']))
  assert.equal(all.rows.length, 12)
  assert.deepEqual(
    launcherView(m, 'continue', '  ', none).map((g) => g.key),
    ['continue'],
  )
})

test('default tab: Continue when it has rows or is loading, else the last tab used, else the first with rows', () => {
  const live = [outside({ sessionId: 'zz' })]
  const full = buildModel({ outside: live, launch, sessions })
  const noConv = buildModel({ outside: live, launch: { ...launch, recent: [] }, sessions })
  assert.equal(chooseTab(full, null, 'new', false), 'continue')
  assert.equal(chooseTab(noConv, null, null, true), 'continue')
  assert.equal(chooseTab(noConv, null, 'takeover', false), 'takeover')
  assert.equal(chooseTab(noConv, null, 'bogus', false), 'new')
  // A pick this visit wins, unless its tab went away.
  assert.equal(chooseTab(full, 'new', null, false), 'new')
  assert.equal(chooseTab(buildModel({ outside: [], launch, sessions }), 'takeover', null, false), 'continue')
  assert.equal(chooseTab(buildModel({ outside: [], launch: { ...launch, recent: [] }, sessions }), null, 'takeover', false), 'new')
})

test('search: all three groups at once, each ranked and capped', () => {
  const m = buildModel({ outside: [outside({ sessionId: 'o9', name: 'garden refactor' })], launch, sessions })
  assert.deepEqual(
    launcherView(m, 'new', 'garden', none).map((g) => [g.label, keys(g.rows)]),
    [
      ['Continue', ['recent:r-new']],
      ['New', ['experiment:garden']],
      ['Take over', ['outside:o9']],
    ],
  )
  // Continue searches older conversations too, each a row of its own.
  const older = buildModel({ outside: [], launch: withRecent(hubConv('r-mid', 'Newer hub work', '11')), sessions })
  const [conv] = launcherView(older, 'continue', 'login', none)
  assert.deepEqual(keys(conv.rows), ['recent:r-old'])
  assert.deepEqual(conv.rows[0].older, [])
  // Capped per group; the total is before the cap.
  const many = Array.from({ length: 9 }, (_, i) => ({ kind: 'experiment' as const, key: `e${i}`, name: `demo-${i}`, lastActivityIso: null }))
  const [, newGroup] = launcherView(buildModel({ outside: [], launch: { ...launch, targets: many }, sessions }), 'continue', 'demo', none)
  assert.equal(newGroup.rows.length, SEARCH_CAP)
  assert.equal(newGroup.total, 9)
})

test('search ranking: every word must match; name prefix ranks above word prefix above anywhere', () => {
  const m = buildModel({ outside: [], launch, sessions })
  const rows = allRows(m)
  assert.deepEqual(keys(filterRows(rows, 'flow')), ['recent:r-old'])
  // Matches the place too (targetName), and multiple words narrow.
  assert.deepEqual(keys(filterRows(rows, 'claude login')), ['recent:r-old'])
  // "hub": no name starts with it, a word of "claude-hub" does.
  assert.equal(filterRows(rows, 'hub')[0].key, 'project:p1')
  assert.deepEqual(filterRows(rows, 'zzz'), [])
  // "Garden watering…" starts with it; the newer "Water the garden" has it only as a later word.
  const ranked = buildModel({ outside: [], launch: withRecent({ ...hubConv('r-word', 'Water the garden', '18') }), sessions })
  const [conv] = launcherView(ranked, 'continue', 'garden', none)
  assert.deepEqual(keys(conv.rows), ['recent:r-new', 'recent:r-word'])
})

test('arrow keys walk the visible rows, expanded older conversations included, and stop at the ends', () => {
  const m = buildModel({ outside: [], launch: withRecent(hubConv('r-mid', 'Mid', '12')), sessions })
  const view = launcherView(m, 'continue', '', none)
  assert.deepEqual(keys(navRows(view, new Set())), ['recent:o1', 'recent:r-new', 'recent:r-orphan'])
  const rows = navRows(view, new Set(['recent:o1']))
  assert.deepEqual(keys(rows), ['recent:o1', 'recent:r-mid', 'recent:r-old', 'recent:r-new', 'recent:r-orphan'])
  assert.equal(moveHighlight(rows, null, 1), 'recent:o1')
  assert.equal(moveHighlight(rows, 'recent:o1', 1), 'recent:r-mid')
  assert.equal(moveHighlight(rows, 'recent:o1', -1), 'recent:o1')
  assert.equal(moveHighlight(rows, 'recent:r-orphan', 1), 'recent:r-orphan')
  assert.equal(moveHighlight(rows, 'filtered-away', 1), 'recent:o1')
  assert.equal(moveHighlight([], null, 1), null)
})

test('auto-name: the target name, or the conversation title trimmed, numbered when taken', () => {
  const rows = allRows(buildModel({ outside: [outside({ name: 'refactor' })], launch, sessions: [session({ name: 'claude-hub' })] }))
  const by = (key: string) => rows.find((r) => r.key === key)!
  assert.equal(autoName(by('project:p1'), [session({ name: 'claude-hub' })]), 'claude-hub 2')
  assert.equal(autoName(by('experiment:garden'), []), 'garden-app')
  assert.equal(autoName(by('recent:r-old'), []), 'Fix the login flow')
  assert.equal(autoName(by('outside:o1'), []), 'refactor')
  assert.equal(trimTitle('  a   very long title that keeps going well past forty characters  '), 'a very long title that keeps going well…')
  assert.equal(trimTitle('short'), 'short')
})

test('auto-colour: the first colour no live session wears', () => {
  assert.equal(defaultColor([session({ color: 'frost' }), session({ color: 'orange', alive: false })]), 'purple')
})

test('launch specs for resume and new rows; none for take-over or unavailable', () => {
  assert.deepEqual(launchSpec({ kind: 'resume', target: { kind: 'project', key: 'p1' }, sessionId: 's' }, 'n', 'teal'), {
    target: { kind: 'project', key: 'p1' },
    mode: 'resume',
    sessionId: 's',
    name: 'n',
    color: 'teal',
  })
  assert.deepEqual(launchSpec({ kind: 'new', target: { kind: 'experiment', key: 'g' } }, 'n', 'blue'), {
    target: { kind: 'experiment', key: 'g' },
    mode: 'new',
    name: 'n',
    color: 'blue',
  })
  assert.equal(launchSpec({ kind: 'take-over', pid: 1, sessionId: 's' }, 'n', 'blue'), null)
  assert.equal(launchSpec({ kind: 'unavailable', reason: 'x' }, 'n', 'blue'), null)
})

test('a placeholder title never becomes a session name: the place name is used instead', () => {
  for (const title of ['(no message found)', 'Untitled conversation']) {
    const m = buildModel({ outside: [], launch: { ...launch, recent: [hubConv('ph', title, '19')] }, sessions: [] })
    assert.equal(autoName(m.continue[0], []), 'claude-hub')
  }
  const named = buildModel({ outside: [], launch: { ...launch, recent: [hubConv('ok', 'Fix the login flow', '19')] }, sessions: [] })
  assert.equal(autoName(named.continue[0], []), 'Fix the login flow')
})

test('an empty tab never claims there is nothing when part of the list failed', () => {
  assert.match(emptyNote('new', null), /^No projects/)
  assert.match(emptyNote('continue', null), /^No earlier conversations/)
  for (const key of ['continue', 'new'] as const) {
    const note = emptyNote(key, "Couldn't read the project registry: EACCES")
    assert.doesNotMatch(note, /^No /)
    assert.match(note, /couldn't be read/)
  }
})
