import test from 'node:test'
import assert from 'node:assert/strict'
import { buildNeeds, headlineParts, type NeedsSources, type SourceRead } from './needs-core.ts'
import type {
  ExtensionsSnapshot,
  FloorStatusReport,
  GlobalConfigReport,
  RecallScorecard,
  VaultInboxReport,
} from '../../../../../shared/ipc-types.ts'

const NOW = Date.parse('2026-10-17T12:00:00.000Z')
const data = <T>(d: T): SourceRead<T> => ({ status: 'data', data: d, error: null })
const loading: SourceRead<never> = { status: 'loading', error: null }
const failed = (error: string): SourceRead<never> => ({ status: 'error', error })

const inbox = (count: number): VaultInboxReport => ({
  count,
  entries: Array.from({ length: count }, (_, i) => ({
    title: `n${i}`,
    timestamp: '2026-10-17T00:00:00.000Z',
    project: i % 2 ? 'claude-hub' : 'sandbox',
    sessionId: `s${i}`,
    justification: '',
    confidence: 'medium' as const,
  })),
})

const config = (states: ('ok' | 'attention' | 'unknown')[], schedulerError: string | null = null): GlobalConfigReport => ({
  generatedAt: '',
  schedulerError,
  settings: {} as GlobalConfigReport['settings'],
  footprint: {} as GlobalConfigReport['footprint'],
  automations: states.map((state, i) => ({
    id: `a${i}`,
    label: `Job ${i}`,
    kind: i === 0 ? 'hook' : 'scheduled',
    trigger: 'daily',
    command: '',
    state,
    detail: `detail ${i}`,
    overBudget: false,
    lastRunIso: null,
    warnings: [],
    taskName: null,
    running: false,
    logId: null,
  })),
})

const floors = (latest: { ok: boolean; hoursAgo: number } | null): FloorStatusReport => ({
  generatedAt: '',
  historyDays: 14,
  projects: [
    {
      id: 'p1',
      name: 'claude-hub',
      path: 'C:\\p1',
      verifyCommand: 'npm test',
      latest: latest && {
        v: 1,
        projectPath: 'C:\\p1',
        timestamp: new Date(NOW - latest.hoursAgo * 3_600_000).toISOString(),
        ok: latest.ok,
        exitCode: latest.ok ? 0 : 1,
        durationMs: 1000,
        command: 'npm test',
      },
      streakDays: null,
      days: [],
    },
    { id: 'p2', name: 'none', path: 'C:\\p2', verifyCommand: null, latest: null, streakDays: null, days: [] },
  ],
})

const health = (scores: number[]) =>
  scores.map((score, i) => ({
    id: `h${i}`,
    name: `proj${i}`,
    configHealth: {
      projectPath: '',
      generatedAt: '',
      project: { exists: true, path: '', estimatedTokens: 100 },
      global: { exists: true, path: '', estimatedTokens: 100 },
      combinedEstimatedTokens: 2939,
      mcpUnmeasured: true,
      findings: [],
      score,
    },
  }))

const ext = (statuses: ('connected' | 'failed' | 'needs-auth')[], checked = true): ExtensionsSnapshot => ({
  items: statuses.map((status, i) => ({
    id: `mcp:${i}`,
    kind: 'mcp',
    name: `s${i}`,
    scope: 'plugin',
    status,
    statusText: null,
    target: null,
    pluginId: 'design@synced',
    projectPath: null,
    usage: { calls: 0, lastUsedIso: null, topTools: [] },
    alwaysOnTokens: null,
    components: [],
  })),
  health: { state: checked ? 'ok' : 'never', checkedAtIso: checked ? '2026-10-17T11:00:00.000Z' : null, error: null },
  usage: { state: 'ok', error: null, sinceIso: null },
  generatedAtIso: '',
})

const recall = (since: string | null, readSessions: number): RecallScorecard => ({
  attempts: 10,
  noMatch: 2,
  offers: [],
  delivered: 5,
  readSessions,
  incompleteScans: 0,
  spendUsd: 1,
  errors: 0,
  since,
})

const quiet = (): NeedsSources => ({
  inbox: data(inbox(0)),
  automations: data(config(['ok', 'ok'])),
  floors: data(floors({ ok: true, hoursAgo: 2 })),
  health: data(health([97, 85])),
  extensions: data(ext(['connected'])),
  recall: data(recall('2026-10-10T00:00:00.000Z', 0)),
})

test('every source answered with nothing: zero items and "Nothing needs you"', () => {
  const s = buildNeeds(quiet(), NOW)
  assert.deepEqual(s.items, [])
  assert.deepEqual(s.pending, [])
  assert.deepEqual(s.unchecked, [])
  assert.deepEqual(headlineParts(s), { em: null, rest: 'Nothing needs you', note: null })
})

test('a loading source never reads as zero', () => {
  const s = buildNeeds({ ...quiet(), floors: loading }, NOW)
  assert.deepEqual(s.pending, ['floors'])
  assert.equal(headlineParts(s).rest, 'Checking what needs you…')
})

test('a failed extensions read is one unchecked entry, not an absence and not a crash', () => {
  const s = buildNeeds({ ...quiet(), extensions: failed('getExtensions is not implemented yet') }, NOW)
  assert.deepEqual(s.unchecked, [{ source: 'extensions', error: 'getExtensions is not implemented yet' }])
  assert.equal(s.items.length, 0)
  const h = headlineParts(s)
  assert.equal(h.rest, 'Nothing found so far')
  assert.equal(h.note, 'couldn’t check extensions')
})

test('an extensions snapshot with no completed health check is unknown, not "nothing broken"', () => {
  const s = buildNeeds({ ...quiet(), extensions: data(ext(['failed'], false)) }, NOW)
  assert.equal(s.items.length, 0)
  assert.equal(s.unchecked[0]?.source, 'extensions')
})

test('a re-check running after a failed one is pending, not "Nothing needs you"', () => {
  // The failed check left every item 'unchecked'; a stale checkedAtIso from an
  // earlier success must not make that read as a current, all-clear answer.
  const snap = ext([])
  snap.items = ext(['connected']).items.map((i) => ({ ...i, status: 'unchecked' as const }))
  snap.health = { state: 'running', checkedAtIso: '2026-10-17T10:00:00.000Z', error: 'mcp list timed out' }
  const s = buildNeeds({ ...quiet(), extensions: data(snap) }, NOW)
  assert.equal(s.items.length, 0)
  assert.deepEqual(s.pending, ['extensions'])
  assert.notEqual(headlineParts(s).rest, 'Nothing needs you')
})

test('an unrecognised CLI status counts as broken, as on the Extensions page', () => {
  const snap = ext(['needs-auth'])
  snap.items.push({ ...snap.items[0], id: 'mcp:x', status: 'unknown', statusText: 'Connection error' })
  const s = buildNeeds({ ...quiet(), extensions: data(snap) }, NOW)
  assert.equal(s.items.find((i) => i.key === 'extensions')?.badge, '2')
})

test('items are counted and ranked: broken first, then waiting, then unknown', () => {
  const s = buildNeeds(
    {
      inbox: data(inbox(3)),
      automations: data(config(['ok', 'attention', 'unknown'])),
      floors: data(floors({ ok: false, hoursAgo: 3 })),
      health: data(health([53, 68, 97])),
      extensions: data(ext(['failed', 'needs-auth', 'needs-auth', 'connected'])),
      recall: data(recall('2026-08-09T00:00:00.000Z', 0)),
    },
    NOW,
  )
  assert.deepEqual(
    s.items.map((i) => i.key),
    ['floor-red:p1', 'automation:a1', 'inbox', 'extensions', 'health:h0', 'automation-unknown:a2', 'recall'],
  )
  const ext3 = s.items.find((i) => i.key === 'extensions')!
  assert.equal(ext3.title, '3 MCP servers can’t connect')
  assert.equal(ext3.sub, '1 fail on every start · 2 need sign-in · none ever used')
  const h = s.items.find((i) => i.key === 'health:h0')!
  assert.equal(h.sub, 'lowest of 3 · ~2.9k tokens loaded every session · 1 other below 80')
  assert.deepEqual(h.peek, { widget: 'projects', ctx: { project: 'h0' } })
  assert.deepEqual(s.items.find((i) => i.key === 'automation:a1')!.peek, { widget: 'automation', ctx: { item: 'a1' } })
  assert.deepEqual(headlineParts(s), { em: '7 things', rest: ' need you', note: null })
})

test('with the Inbox widget on the board the inbox is left to it, but a loading inbox still never reads as zero', () => {
  const on = { inboxOnBoard: true }
  assert.deepEqual(buildNeeds({ ...quiet(), inbox: data(inbox(5)) }, NOW, on).items, [])
  assert.equal(buildNeeds({ ...quiet(), inbox: data(inbox(5)) }, NOW).items[0]?.key, 'inbox')
  assert.deepEqual(buildNeeds({ ...quiet(), inbox: loading }, NOW, on).pending, ['inbox'])
})

test('an over-budget job is titled by its spend, not as "isn’t doing its job"', () => {
  const report = config(['attention', 'attention'])
  report.automations[0] = { ...report.automations[0], label: 'Curate hook (SessionEnd)', overBudget: true }
  const titles = buildNeeds({ ...quiet(), automations: data(report) }, NOW).items.map((i) => i.title)
  assert.deepEqual(titles, ['Curate hook (SessionEnd) is over its spend ceiling', 'Job 1 isn’t doing its job'])
})

test('a stale or never-run floor is flagged; a green one and an unconfigured one are not', () => {
  assert.equal(buildNeeds({ ...quiet(), floors: data(floors({ ok: true, hoursAgo: 72 })) }, NOW).items[0]?.key, 'floor-stale:p1')
  assert.equal(buildNeeds({ ...quiet(), floors: data(floors(null)) }, NOW).items[0]?.key, 'floor-stale:p1')
})

test('the recall verdict is due only after 30 days with no reads', () => {
  const early = buildNeeds({ ...quiet(), recall: data(recall('2026-10-01T00:00:00.000Z', 0)) }, NOW)
  assert.equal(early.items.length, 0)
  const kept = buildNeeds({ ...quiet(), recall: data(recall('2026-08-09T00:00:00.000Z', 3)) }, NOW)
  assert.equal(kept.items.length, 0)
  const due = buildNeeds({ ...quiet(), recall: data(recall('2026-08-09T00:00:00.000Z', 0)) }, NOW)
  assert.equal(due.items[0]?.key, 'recall')
})

test('a scheduler outage is one item, not one per scheduled job', () => {
  const s = buildNeeds({ ...quiet(), automations: data(config(['ok', 'unknown', 'unknown'], 'schtasks failed')) }, NOW)
  assert.deepEqual(
    s.items.map((i) => i.key),
    ['automation-unknown:scheduler'],
  )
})

test('headline: one item is singular, and pending sources are noted beside a real count', () => {
  const s = buildNeeds({ ...quiet(), inbox: data(inbox(1)), recall: loading }, NOW)
  assert.deepEqual(headlineParts(s), { em: '1 thing', rest: ' needs you', note: 'still checking the recall experiment' })
})
