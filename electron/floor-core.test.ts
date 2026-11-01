import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HISTORY_DAYS,
  parseLedgerLines,
  computeStreakDays,
  computeDayHistory,
  buildFloorStatusReport,
  makeVerifyRunRecord,
  findEntryByTranscriptDirName,
} from './floor-core.ts'
import { sanitize } from './status.ts'
import type { RegistryEntry, VerifyRunRecord } from '../shared/ipc-types.ts'

// Every case injects this fixed local `now` — no wall-clock anywhere.
const NOW = new Date(2026, 5, 15, 12, 0, 0) // 2026-06-15 local noon

const DEMO_PATH = 'C:\\projects\\demo'

// Local-noon timestamps: safely inside the intended local calendar day
// regardless of the machine's UTC offset.
function rec(ok: boolean, daysAgo: number, hour = 12): VerifyRunRecord {
  return {
    v: 1,
    projectPath: DEMO_PATH,
    timestamp: new Date(2026, 5, 15 - daysAgo, hour).toISOString(),
    ok,
    exitCode: ok ? 0 : 1,
    durationMs: 1234,
    command: 'npm test',
  }
}

test('parseLedgerLines skips malformed and unknown-version lines without poisoning the rest', () => {
  const good = rec(true, 0)
  const text = [
    JSON.stringify(good),
    '{ this is not json',
    JSON.stringify({ ...good, v: 2 }), // future schema version — skipped, not guessed at
    '',
    JSON.stringify(rec(false, 1)),
  ].join('\n')
  const records = parseLedgerLines(text)
  assert.equal(records.length, 2)
  assert.equal(records[0].ok, true)
  assert.equal(records[1].ok, false)
})

test('computeStreakDays: no records → null', () => {
  assert.equal(computeStreakDays([]), null)
})

test('computeStreakDays: latest record red → 0', () => {
  assert.equal(computeStreakDays([rec(true, 2), rec(false, 0)]), 0)
})

test('computeStreakDays: red 3 days ago then green every day since → 3', () => {
  const records = [rec(false, 3), rec(true, 2), rec(true, 1), rec(true, 0)]
  assert.equal(computeStreakDays(records), 3)
})

test('computeStreakDays: a day with no run breaks the streak', () => {
  // Green 5 days ago and green today, nothing in between: the ledger observed
  // two days, not six. The old "days since the last red" rule said 5.
  assert.equal(computeStreakDays([rec(true, 5), rec(true, 0)]), 1)
})

test('computeStreakDays: multiple runs on one day count as one day', () => {
  assert.equal(computeStreakDays([rec(true, 1, 9), rec(true, 0, 9), rec(true, 0, 17)]), 2)
})

test('computeStreakDays: does not grow while nobody runs the floor', () => {
  // The bug this rule exists for: a single green run, read weeks later. The
  // count is anchored to the last run, so it is the same number forever.
  const oneRun = [rec(true, 42)]
  assert.equal(computeStreakDays(oneRun), 1)
  const fourDaysGreen = [rec(true, 45), rec(true, 44), rec(true, 43), rec(true, 42)]
  assert.equal(computeStreakDays(fourDaysGreen), 4)
})

test('computeDayHistory: same-day red-then-green → day green (last run of the day wins)', () => {
  const days = computeDayHistory([rec(false, 0, 9), rec(true, 0, 15)], NOW)
  assert.equal(days[days.length - 1].status, 'green')
})

test('computeDayHistory: window is the last 14 local days ending today, oldest→newest', () => {
  // One run just outside the window (14 days ago), one on its first day (13 days ago).
  const days = computeDayHistory([rec(true, 14), rec(true, 13)], NOW)
  assert.equal(days.length, HISTORY_DAYS)
  assert.equal(days[0].date, '2026-06-02')
  assert.equal(days[days.length - 1].date, '2026-06-15')
  assert.equal(days[0].status, 'green')
  assert.equal(days.filter((d) => d.status !== 'none').length, 1)
})

test('buildFloorStatusReport: unconfigured project passes through with verifyCommand null', () => {
  const entry: RegistryEntry = { id: 'a', name: 'demo', path: DEMO_PATH, addedAt: '2026-06-01T00:00:00.000Z' }
  const report = buildFloorStatusReport([entry], [], NOW)
  assert.equal(report.historyDays, HISTORY_DAYS)
  assert.equal(report.projects.length, 1)
  const project = report.projects[0]
  assert.equal(project.verifyCommand, null)
  assert.equal(project.latest, null)
  assert.equal(project.streakDays, null)
  assert.ok(project.days.every((d) => d.status === 'none'))
})

test('buildFloorStatusReport: ledger records match their project case-insensitively', () => {
  const entry: RegistryEntry = {
    id: 'a',
    name: 'demo',
    path: 'C:\\Projects\\DEMO', // registry casing differs from the recorded path
    addedAt: '2026-06-01T00:00:00.000Z',
    verifyCommand: 'npm test',
  }
  const report = buildFloorStatusReport([entry], [rec(true, 0)], NOW)
  const project = report.projects[0]
  assert.equal(project.verifyCommand, 'npm test')
  assert.ok(project.latest)
  assert.equal(project.streakDays, 1) // one green day observed, so one day claimed
})

test('makeVerifyRunRecord round-trips through parseLedgerLines', () => {
  // The real protection: whatever the builder emits, the parser accepts —
  // schema drift between recorder and reader can't be silent.
  const record = makeVerifyRunRecord({
    projectPath: DEMO_PATH,
    ok: true,
    exitStatus: 0,
    durationMs: 4321,
    command: 'npm test',
    timestamp: '2026-06-15T12:00:00.000Z',
  })
  const parsed = parseLedgerLines(JSON.stringify(record))
  assert.equal(parsed.length, 1)
  assert.deepEqual(parsed[0], record)
})

test('makeVerifyRunRecord normalizes a non-numeric exit status to null', () => {
  // execSync sets err.status undefined/null on timeout and signal kills.
  const record = makeVerifyRunRecord({
    projectPath: DEMO_PATH,
    ok: false,
    exitStatus: undefined,
    durationMs: 600000,
    command: 'npm test',
    timestamp: '2026-06-15T12:00:00.000Z',
  })
  assert.equal(record.exitCode, null)
  assert.equal(parseLedgerLines(JSON.stringify(record)).length, 1)
})

test('findEntryByTranscriptDirName matches a sanitized dirname case-insensitively', () => {
  const entry: RegistryEntry = { id: 'a', name: 'demo', path: DEMO_PATH, addedAt: '2026-06-01T00:00:00.000Z' }
  const dirName = sanitize(DEMO_PATH).toUpperCase()
  assert.equal(findEntryByTranscriptDirName(dirName, [entry]), entry)
  assert.equal(findEntryByTranscriptDirName('some-other-project', [entry]), null)
})
