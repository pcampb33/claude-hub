import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Pin APP_ROOT before importing: the module resolves log paths from it, and a
// leaked value would point the suite at the real scripts/ directory.
const SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'job-freshness-'))
fs.mkdirSync(path.join(SCRATCH_ROOT, 'scripts'))
process.env.APP_ROOT = SCRATCH_ROOT

const { assessJob, parseLogStamp, spendBreach } = await import('./job-freshness.ts')

const write = (name: string, text: string) =>
  fs.writeFileSync(path.join(SCRATCH_ROOT, 'scripts', name), text)

const NOW = Date.parse('2026-08-22T12:00:00.000Z')

test('parseLogStamp reads a leading ISO stamp and refuses anything else', () => {
  assert.equal(parseLogStamp('2026-08-21T08:30:04.189Z re-linked 0 note(s)'), '2026-08-21T08:30:04.189Z')
  assert.equal(parseLogStamp('re-linked 0 note(s)'), null)
})

test('a missing log is unknown, never stale', () => {
  const r = assessJob('ghost', 'Ghost job', 'does-not-exist.log', 24, NOW)
  // The distinction this module exists for: nobody instrumented this job, which
  // is not the same fact as "this job stopped running".
  assert.equal(r.state, 'unknown')
  assert.equal(r.lastRunIso, null)
  assert.match(r.detail, /no log/)
})

test('an empty log is unknown, and so is an undated last line', () => {
  write('empty.log', '\n  \n')
  assert.equal(assessJob('e', 'E', 'empty.log', 24, NOW).state, 'unknown')

  write('undated.log', 'started sweep\nfinished sweep\n')
  const r = assessJob('u', 'U', 'undated.log', 24, NOW)
  assert.equal(r.state, 'unknown')
  assert.equal(r.lastLine, 'finished sweep')
  assert.equal(r.lastRunIso, null)
})

test('a multi-line entry does not make a healthy job look unknown', () => {
  // Real logs spill a child's stderr after the dated line. Demanding a stamp on
  // the FINAL line reported `unknown` for a job that had just run and logged
  // normally — a false alarm from the module built to prevent false claims.
  write('spill.log', "2026-08-22T08:30:00.000Z done: ok\n'claude' is not recognized\n (status=1)\n")
  const r = assessJob('spill', 'Spill', 'spill.log', 24, NOW)
  assert.equal(r.state, 'current')
  assert.equal(r.lastRunIso, '2026-08-22T08:30:00.000Z')
  // The reported line is the DATED one — the line the timestamp describes.
  assert.equal(r.lastLine, '2026-08-22T08:30:00.000Z done: ok')
})

test('a job inside one expected interval is current', () => {
  write('fresh.log', '2026-08-22T08:30:00.000Z re-linked 2 stale note(s)\n')
  const r = assessJob('linker', 'Linker', 'fresh.log', 24, NOW)
  assert.equal(r.state, 'current')
  assert.equal(r.lastRunIso, '2026-08-22T08:30:00.000Z')
  assert.ok(r.hoursSince !== null && r.hoursSince < 4)
})

test('ONE missed run is stale — the real 2026-08-22 linker case', () => {
  // The log's last line is 2026-08-21T08:30Z while the scheduled task fired on
  // 08-22 and wrote nothing. Reading the log alone said "quiet"; this says late.
  // At the time of the incident the gap was ~30.5h, and the first draft of this
  // module waited two intervals before calling anything stale — which rendered
  // the one event it was built for as green.
  write('linker.log', '2026-08-21T08:30:04.189Z re-linked 0 stale note(s)\n')
  const r = assessJob('linker', 'Linker', 'linker.log', 24, Date.parse('2026-08-22T15:00:00.000Z'))
  assert.equal(r.state, 'stale')
  assert.match(r.detail, /missed at least one scheduled run/)
})

test('ordinary jitter inside the grace window is still current', () => {
  // A task firing minutes late, or a sweep running long, must not cry wolf.
  write('linker2.log', '2026-08-21T08:30:04.189Z re-linked 0 stale note(s)\n')
  const r = assessJob('linker', 'Linker', 'linker2.log', 24, Date.parse('2026-08-22T10:00:00.000Z'))
  assert.equal(r.state, 'current')
})

test('a job that RAN and FAILED is not green, event-driven or not', () => {
  // Recency alone said "reporting" for a hook whose every run ended FAILED.
  // A green light over a broken job is this module's own bug class one level up.
  write('failing.log', '2026-08-22T11:00:00.000Z FAILED: claude -p exited 1\n')
  const r = assessJob('curate', 'Curate', 'failing.log', null, NOW)
  assert.equal(r.state, 'stale')
  assert.match(r.detail, /last run failed/)

  write('failing2.log', '2026-08-22T11:00:00.000Z exit: triage failed: Command failed\n')
  assert.equal(assessJob('linker', 'Linker', 'failing2.log', 24, NOW).state, 'stale')
})

// --- the real lines the first failure regex missed ---------------------------
// Every line below is copied from what the scripts actually write. The original
// pattern (/\bFAILED:|\bfailed:|\berror:/i) matches none of them, so each of
// these ran, broke, and rendered green.

test('a drain that paid for a model call and changed nothing is not green', () => {
  // drain-inbox.mjs:148. `unusable plan` carries no `failed:`/`error:` token —
  // and none of the seven parseDrainPlan error strings does either.
  write('unusable.log', '2026-08-22T11:00:00.000Z exit: unusable plan (partition incomplete: 61/62 entries covered) — inbox untouched. cost=$0.1731\n')
  const r = assessJob('drain', 'Drain', 'unusable.log', 24, NOW)
  assert.equal(r.state, 'stale')
  assert.match(r.detail, /last run failed/)
})

test('a failed vault write is a failure despite the punctuation', () => {
  // drain-inbox.mjs:194. The old pattern demanded `FAILED:`; the line writes
  // `FAILED,`, so a note that could not be written to the vault read as green.
  write('promote.log', '2026-08-22T11:00:00.000Z   promote FAILED, left queued: Renderer hook test harness (EPERM: operation not permitted)\n')
  assert.equal(assessJob('drain', 'Drain', 'promote.log', 24, NOW).state, 'stale')
})

test('a run that finished but failed a promote mid-run is degraded, not green', () => {
  // drain-inbox.mjs: a failed promote or vault commit is followed by a normal `done:`.
  write(
    'degraded.log',
    [
      '2026-08-22T10:00:00.000Z   promote FAILED, left queued: Older run (EPERM)',
      '2026-08-22T10:00:01.000Z done: promoted 0, dropped 0, 1 entries remain queued. cost=$0.1000',
      '2026-08-22T11:00:00.000Z start: 3 inbox entries, 40 vault notes',
      '2026-08-22T11:00:05.000Z   PROMOTED A -> C:\\vault\\A.md (project hub; vault committed)',
      '2026-08-22T11:00:06.000Z   vault commit FAILED after promoting B: index.lock exists',
      '2026-08-22T11:00:07.000Z done: promoted 2, dropped 1, 0 entries remain queued. cost=$0.1200',
    ].join('\n') + '\n',
  )
  const r = assessJob('drain', 'Drain', 'degraded.log', 24, NOW)
  assert.equal(r.state, 'stale')
  assert.match(r.detail, /^last run finished degraded — vault commit FAILED after promoting B/)
})

test("an earlier run's failure does not degrade a clean run after it", () => {
  write(
    'recovered.log',
    [
      '2026-08-21T11:00:00.000Z start: 2 inbox entries, 40 vault notes',
      '2026-08-21T11:00:05.000Z   promote FAILED, left queued: A (EPERM)',
      '2026-08-21T11:00:07.000Z done: promoted 0, dropped 1, 1 entries remain queued. cost=$0.1000',
      '2026-08-22T11:00:00.000Z exit: inbox unchanged since last run — skipping LLM call',
    ].join('\n') + '\n',
  )
  assert.equal(assessJob('drain', 'Drain', 'recovered.log', 24, NOW).state, 'current')
})

test('a paid link run that produced nothing usable is a failure', () => {
  // link-vault.mjs:73 — the sidecar is left untouched after a sonnet call.
  write('noedges.log', '2026-08-22T11:00:00.000Z model proposed no valid edges (cost=$0.4210); leaving sidecar untouched\n')
  assert.equal(assessJob('linker', 'Linker', 'noedges.log', 24, NOW).state, 'stale')
})

test('a run that started and never reported an outcome is not current', () => {
  // The positive instance from scripts/drain-inbox.log: this exact line stood
  // as the terminal line for 24 hours — a killed run — and read green, because
  // an opening line contains no failure keyword and never will.
  write('halfrun.log', '2026-07-11T16:00:00.754Z start: 62 inbox entries, 42 vault notes (dedup-only)\n')
  const r = assessJob('drain', 'Drain', 'halfrun.log', 24, Date.parse('2026-07-12T16:00:00.000Z'))
  assert.equal(r.state, 'stale')
  assert.match(r.detail, /never reported an outcome/)

  // Same for the linker's opening line, and for a mid-run progress line — a
  // crash after the plan is logged leaves that one standing (drain-inbox has no
  // top-level try/catch, so nothing writes a failure line on the way out).
  write('sweep.log', '2026-08-21T08:30:01.890Z incremental link sweep…\n')
  assert.equal(assessJob('linker', 'Linker', 'sweep.log', 24, NOW).state, 'stale')
  write('midrun.log', '2026-08-21T08:30:01.890Z plan: 9 clusters → promote 3, drop 12 (dupes/already-vaulted), keep 4 queued. cost=$0.2\n')
  assert.equal(assessJob('drain', 'Drain', 'midrun.log', 24, NOW).state, 'stale')
})

test('a run that started moments ago is unknown, not a fault', () => {
  // The other half of the same honesty rule: a job currently mid-flight must
  // not be reported broken. A watchdog that cries wolf gets ignored, which
  // fails the same way as a false green. Also covers the hooks' `[pid N] ` tag
  // and an event-driven job, where "started and stopped" is still a fault even
  // though "quiet" is not.
  write('inflight.log', '2026-08-22T11:40:00.000Z [pid 54976] parsed 771 messages, reviewing 95970 chars\n')
  const r = assessJob('curate', 'Curate', 'inflight.log', null, NOW)
  assert.equal(r.state, 'unknown')
  assert.match(r.detail, /may still be running/)

  write('deadrun.log', '2026-08-20T11:40:00.000Z [pid 54976] parsed 771 messages, reviewing 95970 chars\n')
  assert.equal(assessJob('curate', 'Curate', 'deadrun.log', null, NOW).state, 'stale')
})

test('the ordinary daily outcomes of all four jobs stay current', () => {
  // The other direction of the same regression: widening the failure vocabulary
  // must not red-light the lines these scripts write when nothing is wrong.
  // `no parseable entries` is the drain's every-day result and sits one word
  // boundary away from `unparseable`.
  for (const [name, line] of [
    ['ok-drain.log', '2026-08-22T11:00:00.000Z exit: inbox has no parseable entries'],
    ['ok-drain2.log', '2026-08-22T11:00:00.000Z done: promoted 3, dropped 12, 4 entries remain queued. cost=$0.2'],
    ['ok-link.log', '2026-08-22T11:00:00.000Z re-linked 0 stale note(s); sidecar holds 462 edges'],
    ['ok-curate.log', '2026-08-22T11:00:00.000Z [pid 44312] exit: 3 messages, below pre-filter'],
    ['ok-recall.log', '2026-08-22T11:00:00.000Z [pid 13604] worker done: no-match (session=d5475d74 cost=$0.0748)'],
  ] as const) {
    write(name, `${line}\n`)
    assert.equal(assessJob('j', 'J', name, 24, NOW).state, 'current', line)
  }
})

test('an unrecognised log line never becomes a false green', () => {
  // The failure vocabulary is deliberately narrow. A line this module does not
  // recognise keeps the recency verdict rather than being read as success —
  // so a reworded log degrades, it does not lie.
  write('odd.log', '2026-08-22T11:00:00.000Z sweep concluded, 3 widgets reticulated\n')
  const r = assessJob('linker', 'Linker', 'odd.log', 24, NOW)
  assert.equal(r.state, 'current') // recency still applies
  assert.equal(r.lastLine, '2026-08-22T11:00:00.000Z sweep concluded, 3 widgets reticulated')
})

test('an event-driven job is never judged late', () => {
  // The curate hook fires per session end. A quiet week means a quiet week.
  write('curate.log', '2026-07-01T00:00:00.000Z done: triage=no-candidate\n')
  const r = assessJob('curate', 'Curate', 'curate.log', null, NOW)
  assert.equal(r.state, 'event-driven')
  assert.ok(r.hoursSince !== null)
})

// --- spend --------------------------------------------------------------------
// Every line below is in the shape the scripts write (curate-session.mjs,
// vault-recall.mjs, drain-inbox.mjs).

test('spend sums each window and leaves older runs out', () => {
  write(
    'spend-curate.log',
    [
      '2026-07-01T11:00:00.000Z [pid 1] done: triage=no-candidate (cost=$9.0000)', // > 30 days: no window
      '2026-08-01T12:00:00.000Z [pid 2] done: extract found nothing to save (cost=$0.3000)', // 21 days: month
      '2026-08-20T12:00:00.000Z [pid 3] done: queued 2 note(s) (cost=$0.5000)', // 2 days: week
      '2026-08-22T06:00:00.000Z [pid 4] done: triage=no-candidate (cost=$0.0100)', // 6h: day
      '2026-08-22T07:00:00.000Z [pid 5] exit: unparseable extract (12 chars, cost=$0.2000): SKIP', // 5h: day
      '2026-08-22T08:00:00.000Z [pid 6] parsed 771 messages, reviewing 95970 chars',
      '2026-08-22T13:00:00.000Z [pid 7] done: triage=no-candidate (cost=$5.0000)', // after now: no window
    ].join('\n'),
  )
  const s = assessJob('curate', 'Curate', 'spend-curate.log', null, NOW).spend!
  assert.equal(s.day.runs, 2)
  assert.ok(Math.abs(s.day.usd - 0.21) < 1e-9)
  assert.equal(s.week.runs, 3)
  assert.ok(Math.abs(s.week.usd - 0.71) < 1e-9)
  assert.equal(s.month.runs, 4)
  assert.ok(Math.abs(s.month.usd - 1.01) < 1e-9)
})

test('a cost=n/a run is a paid run of unknown cost, not a free one', () => {
  write(
    'spend-na.log',
    [
      '2026-08-22T10:00:00.000Z [pid 1] done: triage=no-candidate (cost=n/a)',
      '2026-08-22T10:30:00.000Z exit: unusable plan (partition incomplete) — inbox untouched. cost=n/a',
      '2026-08-22T11:00:00.000Z [pid 2] done: triage=no-candidate (cost=$0.0100)',
    ].join('\n'),
  )
  const s = assessJob('curate', 'Curate', 'spend-na.log', null, NOW).spend!
  assert.deepEqual(s.day, { usd: 0.01, runs: 3, unknownCostRuns: 2 })
})

test('an unreadable log is unknown spend, never $0', () => {
  // A scan that could not read its input reports unknown, not none.
  assert.equal(assessJob('ghost', 'Ghost', 'does-not-exist.log', null, NOW).spend, null)
  // ...while a readable log with no paid runs is a real zero.
  write('spend-zero.log', '2026-08-22T11:00:00.000Z exit: inbox has no parseable entries\n')
  assert.deepEqual(assessJob('drain', 'Drain', 'spend-zero.log', 24, NOW).spend!.week, { usd: 0, runs: 0, unknownCostRuns: 0 })
})

test('one run is billed once: drain repeats its cost on the plan line', () => {
  // drain-inbox.mjs prints the same cost on `plan:` and on the closing `done:`;
  // its cached-plan reruns report $0 and made no call. Recall's legacy
  // `done: injected` and the worker's `worker done:` are separate runs, and the
  // `done: delivered` that follows a worker carries no cost.
  write(
    'spend-drain.log',
    [
      '2026-08-22T08:00:00.000Z start: 3 inbox entries, 42 vault notes',
      '2026-08-22T08:00:07.000Z plan: 3 clusters → promote 1, drop 0 (dupes/already-vaulted), keep 2 queued. cost=$0.3759',
      '2026-08-22T08:00:08.000Z done: promoted 1, dropped 0, 2 entries remain queued. cost=$0.3759',
      '2026-08-22T09:00:00.000Z reusing cached plan from a prior run on this inbox (no LLM call)',
      '2026-08-22T09:00:01.000Z done: promoted 0, dropped 0, 2 entries remain queued. cost=$0.0000',
      '2026-08-22T10:00:00.000Z exit: unusable plan (partition incomplete: 61/62 entries covered) — inbox untouched. cost=0.1731',
    ].join('\n'),
  )
  const d = assessJob('drain', 'Drain', 'spend-drain.log', 24, NOW).spend!.day
  assert.equal(d.runs, 2)
  assert.ok(Math.abs(d.usd - 0.549) < 1e-9)

  write(
    'spend-recall.log',
    [
      '2026-08-22T09:00:00.000Z [pid 1] done: injected 1 ["JUCE judder fix"] (cost=$0.0487)',
      '2026-08-22T10:00:00.000Z [pid 2] start session=s1 project=chug promptChars=184 (worker spawned)',
      '2026-08-22T10:00:14.000Z [pid 3] worker done: matched 1 ["JUCE judder fix"] (session=s1 cost=$0.0130)',
      '2026-08-22T10:00:15.000Z [pid 4] done: delivered (session=s1)',
      '2026-08-22T11:00:00.000Z [pid 5] worker done: no-match (session=s2 cost=$0.0060)',
    ].join('\n'),
  )
  const r = assessJob('recall', 'Recall', 'spend-recall.log', null, NOW).spend!.day
  assert.equal(r.runs, 3)
  assert.ok(Math.abs(r.usd - 0.0677) < 1e-9)
})

test('the 7-day ceiling: the incident week breaches it, a normal week does not', () => {
  const w = (usd: number, unknownCostRuns = 0) => ({ usd, runs: 1, unknownCostRuns })
  const spend = (week: number, unknown = 0) => ({ day: w(0), week: w(week, unknown), month: w(week) })
  assert.equal(spendBreach(null), null) // unknown spend accuses nobody
  assert.equal(spendBreach(spend(9.5)), null)
  assert.equal(spendBreach(spend(20)), null)
  assert.equal(
    spendBreach(spend(81.2, 3)),
    'spent $81.20 in 7 days plus 3 run(s) of unknown cost (ceiling $20) — normal is under $10; last 24h $0.00',
  )
})
