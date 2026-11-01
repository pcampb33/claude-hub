import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FIVE_HOUR_MS, WEEK_MS, onCoursePastHalf, paceRows, windowPace, formatSpan } from './pace.ts'

const NOW = Date.parse('2026-10-17T12:00:00Z')
const at = (msFromNow: number) => new Date(NOW + msFromNow).toISOString()

test('projection is used over elapsed share of the window', () => {
  // 3h of 5h gone (60%), 30% used → 50% at reset.
  const p = windowPace({ utilization: 30, resetsAt: at(2 * 3600_000) }, FIVE_HOUR_MS, NOW)
  assert.equal(p.kind, 'projected')
  if (p.kind !== 'projected') return
  assert.ok(Math.abs(p.elapsed - 0.6) < 1e-9)
  assert.ok(Math.abs(p.projected - 0.5) < 1e-9)
  assert.equal(p.runsOutAt, null)
})

test('a pace past 100% says when the window runs out', () => {
  // 50% gone, 80% used → runs out after another 0.2/0.8 × 2.5h = 37.5 min.
  const p = windowPace({ utilization: 80, resetsAt: at(2.5 * 3600_000) }, FIVE_HOUR_MS, NOW)
  assert.equal(p.kind, 'projected')
  if (p.kind !== 'projected') return
  assert.ok(Math.abs(p.projected - 1.6) < 1e-9)
  assert.equal(p.runsOutAt, NOW + 37.5 * 60_000)
})

test('too early in the window to project', () => {
  // 6 minutes into a 5h window: 2% used would "project" to 100%.
  const p = windowPace({ utilization: 2, resetsAt: at(FIVE_HOUR_MS - 6 * 60_000) }, FIVE_HOUR_MS, NOW)
  assert.equal(p.kind, 'early')
})

test('a reading whose reset has passed projects nothing', () => {
  const p = windowPace({ utilization: 90, resetsAt: at(-60_000) }, FIVE_HOUR_MS, NOW)
  assert.equal(p.kind, 'reset')
})

test('an unparseable reset is treated as unprojectable, not as a live window', () => {
  const p = windowPace({ utilization: 10, resetsAt: 'garbage' }, FIVE_HOUR_MS, NOW)
  assert.equal(p.kind, 'reset')
})

test('relevance: only a real projection past half counts, on any window', () => {
  const quiet = paceRows(
    {
      available: true,
      fiveHour: { utilization: 10, resetsAt: at(2.5 * 3600_000) }, // → 20%
      sevenDay: { utilization: 1, resetsAt: at(WEEK_MS - 3600_000) }, // early
      scopedWeekly: null,
    },
    NOW,
  )
  assert.equal(quiet.length, 2)
  assert.equal(onCoursePastHalf(quiet), false)

  const scopedHot = paceRows(
    {
      available: true,
      fiveHour: null,
      sevenDay: { utilization: 10, resetsAt: at(WEEK_MS / 2) }, // → 20%
      scopedWeekly: { utilization: 40, resetsAt: at(WEEK_MS / 2), label: 'Fable' }, // → 80%
    },
    NOW,
  )
  assert.deepEqual(
    scopedHot.map((r) => r.name),
    ['Weekly', 'Weekly · Fable'],
  )
  assert.equal(onCoursePastHalf(scopedHot), true)
})

test('formatSpan', () => {
  assert.equal(formatSpan(45 * 60_000), '45m')
  assert.equal(formatSpan(192 * 60_000), '3h 12m')
  assert.equal(formatSpan(52 * 3600_000), '2d 4h')
})
