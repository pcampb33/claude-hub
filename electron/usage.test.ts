import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUsageResponse, recordFetch, servedFromCache, settleWithin, type UsageCacheState } from './usage.ts'
import type { UsageLimitsReport } from '../shared/ipc-types.ts'

// Trimmed from a real /api/oauth/usage response (2026-07-05): each window
// carries utilization + resets_at alongside null dollar fields we ignore.
const REAL_BODY = {
  five_hour: {
    utilization: 11,
    resets_at: '2026-07-06T07:20:00.271428+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day: {
    utilization: 3,
    resets_at: '2026-07-10T04:00:00.271451+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day_opus: null,
}

// A limits[] array as the live endpoint returns it (2026-07-10): a session
// window, the account-wide weekly, and a model-scoped weekly (the binding cap).
// Note snake-case `percent`/`resets_at` and the nested scope.model.display_name.
const LIMITS = [
  { kind: 'session', group: 'session', percent: 36, is_active: false, resets_at: '2026-07-11T07:19:59Z', scope: null },
  { kind: 'weekly_all', group: 'weekly', percent: 42, is_active: false, resets_at: '2026-07-17T03:59:59Z', scope: null },
  {
    kind: 'weekly_scoped',
    group: 'weekly',
    percent: 68,
    is_active: true,
    resets_at: '2026-07-17T03:59:59Z',
    scope: { model: { id: null, display_name: 'Fable' }, surface: null },
  },
]

test('parseUsageResponse: maps five_hour and seven_day from a real response', () => {
  const { fiveHour, sevenDay } = parseUsageResponse(REAL_BODY)
  assert.deepEqual(fiveHour, { utilization: 11, resetsAt: '2026-07-06T07:20:00.271428+00:00' })
  assert.deepEqual(sevenDay, { utilization: 3, resetsAt: '2026-07-10T04:00:00.271451+00:00' })
})

test('parseUsageResponse: no limits[] → scopedWeekly null', () => {
  assert.equal(parseUsageResponse(REAL_BODY).scopedWeekly, null)
})

test('parseUsageResponse: null windows and missing fields map to null', () => {
  assert.deepEqual(parseUsageResponse({ five_hour: null, seven_day: undefined }), {
    fiveHour: null,
    sevenDay: null,
    scopedWeekly: null,
  })
  // utilization present but resets_at missing → not a usable window
  assert.deepEqual(parseUsageResponse({ five_hour: { utilization: 5 } }), {
    fiveHour: null,
    sevenDay: null,
    scopedWeekly: null,
  })
})

test('parseUsageResponse: non-object bodies map to null windows', () => {
  assert.deepEqual(parseUsageResponse(null), { fiveHour: null, sevenDay: null, scopedWeekly: null })
  assert.deepEqual(parseUsageResponse('nope'), { fiveHour: null, sevenDay: null, scopedWeekly: null })
})

test('parseUsageResponse: picks the model-scoped weekly from limits[]', () => {
  assert.deepEqual(parseUsageResponse({ ...REAL_BODY, limits: LIMITS }).scopedWeekly, {
    utilization: 68,
    resetsAt: '2026-07-17T03:59:59Z',
    label: 'Fable',
  })
})

test('parseUsageResponse: multiple scoped weeklies → highest percent wins', () => {
  const limits = [
    { group: 'weekly', percent: 40, resets_at: '2026-07-17T03:59:59Z', scope: { model: { display_name: 'Sonnet' } } },
    { group: 'weekly', percent: 72, resets_at: '2026-07-17T03:59:59Z', scope: { model: { display_name: 'Opus' } } },
    { group: 'weekly', percent: 55, resets_at: '2026-07-17T03:59:59Z', scope: { model: { display_name: 'Fable' } } },
  ]
  assert.deepEqual(parseUsageResponse({ limits }).scopedWeekly, {
    utilization: 72,
    resetsAt: '2026-07-17T03:59:59Z',
    label: 'Opus',
  })
})

test('parseUsageResponse: account-wide-only weekly (no model scope) → scopedWeekly null', () => {
  const limits = [{ group: 'weekly', percent: 42, resets_at: '2026-07-17T03:59:59Z', scope: null }]
  assert.equal(parseUsageResponse({ limits }).scopedWeekly, null)
})

test('parseUsageResponse: malformed limits[] never throws → scopedWeekly null', () => {
  // not an array
  assert.equal(parseUsageResponse({ limits: 'nope' }).scopedWeekly, null)
  // scoped weekly but missing/blank display_name or non-numeric percent
  const limits = [
    null,
    42,
    { group: 'weekly', percent: 90, resets_at: '2026-07-17T03:59:59Z', scope: { model: { display_name: '' } } },
    { group: 'weekly', percent: '80', resets_at: '2026-07-17T03:59:59Z', scope: { model: { display_name: 'Fable' } } },
    { group: 'weekly', percent: 88, resets_at: 123, scope: { model: { display_name: 'Fable' } } },
  ]
  assert.equal(parseUsageResponse({ limits }).scopedWeekly, null)
})

// A fetch that never settles used to wedge the single-flight slot for the
// process's lifetime (see DEADLINE_MS in usage.ts) — the desktop tile then
// showed a blank em-dash forever while another process fetched fine. These
// two cover the guarantee that makes that impossible: settleWithin ALWAYS
// resolves, so getUsageLimits's `.finally` always clears the slot.
test('settleWithin resolves unavailable("timeout") when the promise never settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const settled = settleWithin(new Promise<UsageLimitsReport>(() => {}), 20_000)
  t.mock.timers.tick(20_000)
  const report = await settled
  assert.equal(report.available, false)
  assert.equal(report.reason, 'timeout')
  assert.equal(report.fiveHour, null)
})

test('settleWithin turns a rejection into a resolved unavailable report', async () => {
  const report = await settleWithin(Promise.reject(new Error('boom')), 20_000)
  assert.equal(report.available, false)
  assert.equal(report.reason, 'request-failed')
})

// The stale grace (STALE_GRACE_MS, 4h) re-serves the last good reading when a
// refresh fails — correct, since the endpoint's quota is account-level and the
// windows move slowly. What was wrong is that the re-served report was shaped
// exactly like a current one (available:true, no timestamp), so the dashboard
// printed an hours-old number as live. `staleAsOf` is the difference. The
// clock is injected as an explicit `at`/`now` here rather than mocked: both
// serve paths are pure over the cache state they're handed.
const HOUR = 60 * 60_000
const T0 = 1_700_000_000_000 // arbitrary fixed epoch — only the deltas matter
const FRESH: UsageLimitsReport = {
  available: true,
  fiveHour: { utilization: 11, resetsAt: '2026-07-06T07:20:00Z' },
  sevenDay: null,
  scopedWeekly: null,
}
const FAILED: UsageLimitsReport = {
  available: false,
  reason: 'http-429',
  fiveHour: null,
  sevenDay: null,
  scopedWeekly: null,
}

test('recordFetch: a fresh success is served unstamped and becomes the last good reading', () => {
  const state: UsageCacheState = { lastGood: null, lastServed: null }
  const served = recordFetch(state, FRESH, T0)
  assert.equal(served, FRESH)
  assert.equal(served.staleAsOf, undefined)
  assert.deepEqual(state.lastGood, { report: FRESH, at: T0 })
})

test('recordFetch: a failure inside the grace window re-serves the last good reading, stamped', () => {
  const state: UsageCacheState = { lastGood: { report: FRESH, at: T0 }, lastServed: null }
  const served = recordFetch(state, FAILED, T0 + 2 * HOUR)
  assert.equal(served.available, true)
  assert.deepEqual(served.fiveHour, FRESH.fiveHour)
  assert.equal(served.staleAsOf, T0) // when it was actually read, not when it was served
})

test('recordFetch: stamping copies — the report handed out fresh is never retro-marked', () => {
  const state: UsageCacheState = { lastGood: null, lastServed: null }
  const fresh: UsageLimitsReport = { ...FRESH }
  const servedFresh = recordFetch(state, fresh, T0)
  const servedStale = recordFetch(state, FAILED, T0 + 3 * HOUR)
  assert.equal(servedStale.staleAsOf, T0)
  // lastGood.report is the same object the fresh caller is still holding.
  assert.equal(servedFresh.staleAsOf, undefined)
  assert.equal(fresh.staleAsOf, undefined)
  assert.equal(state.lastGood?.report.staleAsOf, undefined)
  assert.notEqual(servedStale, state.lastGood?.report)
})

test('recordFetch: past the grace window the failure is served as-is, unstamped', () => {
  const state: UsageCacheState = { lastGood: { report: FRESH, at: T0 }, lastServed: null }
  const served = recordFetch(state, FAILED, T0 + 5 * HOUR)
  assert.equal(served, FAILED)
  assert.equal(served.staleAsOf, undefined)
})

test('recordFetch: a failure with no last good reading is served as-is', () => {
  const state: UsageCacheState = { lastGood: null, lastServed: null }
  assert.equal(recordFetch(state, FAILED, T0), FAILED)
})

// Serve path 1 — the short-circuit getUsageLimits takes before it ever reaches
// the grace logic. For the FAILURE_TTL_MS (5min) after a failed refresh every
// caller lands here, so an unstamped report escaping this path would defeat
// the whole fix.
test('servedFromCache: the stale stamp survives the short-circuit after a failure', () => {
  const state: UsageCacheState = { lastGood: { report: FRESH, at: T0 }, lastServed: null }
  recordFetch(state, FAILED, T0 + 2 * HOUR)
  const served = servedFromCache(state, T0 + 2 * HOUR + 60_000) // 1min later, inside FAILURE_TTL_MS
  assert.equal(served?.available, true)
  assert.equal(served?.staleAsOf, T0)
})

test('servedFromCache: a current reading is re-served without a stale stamp', () => {
  const state: UsageCacheState = { lastGood: null, lastServed: null }
  recordFetch(state, FRESH, T0)
  const served = servedFromCache(state, T0 + 10 * 60_000) // inside SUCCESS_TTL_MS
  assert.equal(served, FRESH)
  assert.equal(served?.staleAsOf, undefined)
})

test('servedFromCache: null with no entry, and once the TTL lapses', () => {
  const state: UsageCacheState = { lastGood: null, lastServed: null }
  assert.equal(servedFromCache(state, T0), null)
  recordFetch(state, FAILED, T0)
  assert.equal(servedFromCache(state, T0 + 10 * 60_000), null) // past FAILURE_TTL_MS
  recordFetch(state, FRESH, T0)
  assert.equal(servedFromCache(state, T0 + 40 * 60_000), null) // past SUCCESS_TTL_MS
})
