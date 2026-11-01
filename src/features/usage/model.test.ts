import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UsageReport } from '../../../shared/ipc-types'
import { assignSlots, fmtMinutes, fmtTokens, nextPeriodStart, niceCeil, OTHER_KEY, pickSeries, stackFor } from './model.ts'

function report(totals: Record<string, number>): UsageReport {
  const keys = Object.keys(totals)
  return {
    state: 'ready',
    error: null,
    coverage: { filesIndexed: 1, filesUnreadable: 0, firstIso: null, lastIso: null, indexedSinceIso: null },
    series: keys.map((key) => ({ key, name: key, kind: 'project' })),
    buckets: [],
    totals: Object.fromEntries(keys.map((k) => [k, { processed: totals[k], output: totals[k] % 7, activeMinutes: 0, sessions: 1 }])),
  }
}

test('pickSeries: top six by the selected metric, the rest fold into Other, zeros are dropped', () => {
  const r = report({ a: 10, b: 80, c: 30, d: 5, e: 70, f: 1, g: 60, h: 0 })
  const { shown, rest } = pickSeries(r, 'processed')
  assert.deepEqual(
    shown.map((s) => s.key),
    ['b', 'e', 'g', 'c', 'a', 'd'],
  )
  assert.deepEqual(
    rest.map((s) => s.key),
    ['f'],
  )
  // Active time is zero everywhere: nothing to show, rather than six empty series.
  assert.equal(pickSeries(r, 'activeMinutes').shown.length, 0)
})

test('assignSlots: a key keeps its colour while it stays shown; new keys take free slots', () => {
  const first = assignSlots(['a', 'b', 'c'], new Map())
  assert.deepEqual([...first], [['a', 0], ['b', 1], ['c', 2]])
  const second = assignSlots(['c', 'd', 'a'], first)
  assert.equal(second.get('c'), 2)
  assert.equal(second.get('a'), 0)
  assert.equal(second.get('d'), 1)
})

test('stackFor: shown series bottom-up, then everything else as Other', () => {
  const values = { a: { processed: 5, output: 1, activeMinutes: 1 }, z: { processed: 3, output: 0, activeMinutes: 0 }, y: { processed: 2, output: 0, activeMinutes: 0 } }
  const segs = stackFor(values, [{ key: 'a', name: 'a', kind: 'project' }, { key: 'b', name: 'b', kind: 'project' }], 'processed')
  assert.deepEqual(segs, [
    { key: 'a', value: 5 },
    { key: OTHER_KEY, value: 5 },
  ])
})

test('formatters', () => {
  assert.equal(fmtTokens(5_290_000_000), '5.29B')
  assert.equal(fmtTokens(618_000_000), '618M')
  assert.equal(fmtTokens(18_100_000), '18.1M')
  assert.equal(fmtTokens(950), '950')
  assert.equal(fmtTokens(5e9), '5B')
  assert.equal(fmtTokens(2.5e9), '2.5B')
  assert.equal(fmtTokens(100e3), '100k')
  assert.equal(fmtMinutes(45), '45m')
  assert.equal(fmtMinutes(125), '2h 5m')
  assert.equal(fmtMinutes(120), '2h')
  assert.equal(niceCeil(3.07e9), 5e9)
  assert.equal(niceCeil(1.2e6), 2e6)
})

test('nextPeriodStart: local day, week and month boundaries', () => {
  const day = new Date(2026, 9, 18).toISOString()
  assert.equal(nextPeriodStart('day', day), new Date(2026, 9, 19).toISOString())
  assert.equal(nextPeriodStart('week', new Date(2026, 9, 12).toISOString()), new Date(2026, 9, 19).toISOString())
  assert.equal(nextPeriodStart('month', new Date(2026, 11, 1).toISOString()), new Date(2027, 0, 1).toISOString())
})
