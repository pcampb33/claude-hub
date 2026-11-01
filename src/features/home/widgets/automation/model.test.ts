import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GlobalAutomation } from '../../../../../shared/ipc-types.ts'
import { dialPlacements, freshnessFor, gradeSummary, logGist, minutesUntil, runHour, shortLabel, spendText } from './model.ts'

function job(over: Partial<GlobalAutomation>): GlobalAutomation {
  return {
    id: 'task:claude-hub vault linker',
    label: 'claude-hub vault linker',
    kind: 'scheduled',
    trigger: 'scheduled',
    command: '',
    state: 'ok',
    detail: '',
    lastRunIso: null,
    warnings: [],
    taskName: 'claude-hub vault linker',
    running: false,
    logId: 'log:linker',
    ...over,
  }
}

test('the run hour comes from the scheduler next-run text in 12h and 24h locales', () => {
  assert.deepEqual(runHour(job({ trigger: 'next Sat 4:30 AM' })), { hour: 4.5, from: 'schedule' })
  assert.deepEqual(runHour(job({ trigger: 'next Sat 12:00 PM' })), { hour: 12, from: 'schedule' })
  assert.deepEqual(runHour(job({ trigger: 'next Sat 12:15 AM' })), { hour: 0.25, from: 'schedule' })
  assert.deepEqual(runHour(job({ trigger: 'next Sa. 04:45' })), { hour: 4.75, from: 'schedule' })
})

test('with no schedule text the last start places the job; with neither it is not placed', () => {
  const iso = new Date(2026, 9, 17, 12, 0).toISOString()
  assert.deepEqual(runHour(job({ trigger: 'scheduled', lastRunIso: iso })), { hour: 12, from: 'last run' })
  // Placing a job nobody can date would draw a dot on a guess.
  assert.equal(runHour(job({ trigger: 'scheduled', lastRunIso: null })), null)
})

test('two jobs fifteen minutes apart do not share a spot on the dial', () => {
  const dots = dialPlacements(
    [
      { a: job({ id: 'b' }), hour: 4.75 },
      { a: job({ id: 'a' }), hour: 4.5 },
      { a: job({ id: 'c' }), hour: 12 },
    ],
    50,
    50,
    40,
    12,
  )
  assert.deepEqual(
    dots.map((d) => d.a.id),
    ['a', 'b', 'c'],
  )
  const dist = Math.hypot(dots[0].x - dots[1].x, dots[0].y - dots[1].y)
  assert.ok(dist > 10, `dots ${dist.toFixed(1)}px apart`)
  // Noon sits straight down from the centre on the outer ring.
  assert.ok(Math.abs(dots[2].x - 50) < 1e-9 && Math.abs(dots[2].y - 90) < 1e-9)
})

test('a countdown is only given when the scheduler agrees on the day', () => {
  const now = new Date(2026, 9, 17, 11, 16) // a Saturday
  const today = now.toLocaleString(undefined, { weekday: 'short' })
  assert.equal(minutesUntil(job({ trigger: `next ${today} 12:00 PM` }), 12, now), 44)
  // Next run three days out: a daily countdown would be wrong.
  const later = new Date(2026, 9, 20).toLocaleString(undefined, { weekday: 'short' })
  assert.equal(minutesUntil(job({ trigger: `next ${later} 12:00 PM` }), 12, now), null)
})

test('freshness joins on the log id, and an unprobed automation has none', () => {
  const f = [{ id: 'linker', label: '', state: 'current' as const, detail: '', lastLine: 'x', lastRunIso: null, hoursSince: 1, spend: null }]
  assert.equal(freshnessFor(job({}), f)?.lastLine, 'x')
  assert.equal(freshnessFor(job({ logId: null }), f), null)
})

test('spend text names runs of unknown cost, so a floor never reads as a total', () => {
  assert.equal(spendText({ usd: 0, runs: 0, unknownCostRuns: 0 }), '$0.00 · no paid runs')
  assert.equal(spendText({ usd: 8.123, runs: 1, unknownCostRuns: 0 }), '$8.12 · 1 run')
  assert.equal(spendText({ usd: 81.2, runs: 851, unknownCostRuns: 3 }), '$81.20 · 851 runs, 3 of unknown cost')
})

test('labels drop the hub prefix and the hook event; log rows drop the timestamp and pid', () => {
  assert.equal(shortLabel(job({})), 'Vault linker')
  assert.equal(shortLabel(job({ label: 'Curate hook (SessionEnd)' })), 'Curate hook')
  assert.equal(logGist('2026-10-17T15:14:13.146Z [pid 179424] worker done: no-match'), 'worker done: no-match')
  assert.equal(logGist('exit: inbox has no parseable entries'), 'exit: inbox has no parseable entries')
})

test('the meta line names the worst grade first and never calls unknown working', () => {
  assert.equal(gradeSummary([job({ state: 'ok' }), job({ state: 'unknown' })]), '1 unknown')
  assert.equal(gradeSummary([job({ state: 'attention' }), job({ state: 'unknown' })]), '1 needs attention')
  assert.equal(gradeSummary([job({ state: 'ok' })]), 'all working')
})
