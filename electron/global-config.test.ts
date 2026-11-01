import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseTaskLine,
  parseHooks,
  hookScriptPath,
  scheduledWarnings,
  taskResultText,
  runRecordWarnings,
  hookAutomations,
  scheduledAutomations,
} from './global-config.ts'
import type { JobFreshness } from '../shared/ipc-types.ts'

test('parseTaskLine reads a full scheduler row', () => {
  const row = parseTaskLine(
    'claude-hub floor verify|Ready|2026-08-23T12:07:56.0000000-04:00|0|2026-08-24T04:45:00.0000000-04:00|True|False',
  )
  assert.ok(row)
  assert.equal(row.taskName, 'claude-hub floor verify')
  assert.equal(row.state, 'Ready')
  assert.equal(row.lastResult, 0)
  assert.equal(row.startWhenAvailable, true)
  assert.equal(row.wakeToRun, false)
  assert.ok(row.lastRunIso?.startsWith('2026-08-23'))
})

test('parseTaskLine: a never-run task reports no last run, not the 1999 sentinel', () => {
  // Task Scheduler dates a task that has never run to 1999-11-30. Rendering
  // that as a real "last run" would be a confident claim about a run nobody made.
  const row = parseTaskLine('claude-hub server|Ready|1999-11-30T00:00:00.0000000-05:00|0||False|False')
  assert.ok(row)
  assert.equal(row.lastRunIso, null)
  assert.equal(row.nextRunIso, null)
})

test('parseTaskLine: output it does not understand is null, not an empty task', () => {
  assert.equal(parseTaskLine(''), null)
  assert.equal(parseTaskLine('Get-ScheduledTask : Access is denied'), null)
  assert.equal(parseTaskLine('claude-hub server|Ready|||'), null) // truncated row
})

test('scheduledWarnings names the condition that silently drops a run', () => {
  const base = {
    taskName: 't',
    state: 'Ready',
    lastRunIso: null,
    lastResult: 0,
    nextRunIso: null,
    startWhenAvailable: false,
    wakeToRun: false,
  }
  // The real 2026-08-23 linker skip: asleep at 04:30, never retried, log simply
  // stops — which reads as quiet rather than missed.
  assert.deepEqual(scheduledWarnings(base), ['a run missed while the machine is asleep is never retried'])
  assert.deepEqual(scheduledWarnings({ ...base, startWhenAvailable: true }), [])
  assert.ok(scheduledWarnings({ ...base, startWhenAvailable: true, state: 'Disabled' }).includes('the task is disabled'))
})

test('parseHooks reads every registered command across events', () => {
  const hooks = parseHooks({
    hooks: {
      SessionEnd: [{ hooks: [{ type: 'command', command: 'node C:/projects/claude-hub/scripts/curate-session.mjs' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node C:/projects/claude-hub/scripts/vault-recall.mjs' }] }],
    },
  })
  assert.equal(hooks.length, 2)
  assert.deepEqual(
    hooks.map((h) => h.event),
    ['SessionEnd', 'UserPromptSubmit'],
  )
})

test('parseHooks: no hooks, or a settings file that could not be read, yields none', () => {
  assert.deepEqual(parseHooks({}), [])
  assert.deepEqual(parseHooks(null), [])
  assert.deepEqual(parseHooks({ hooks: { SessionEnd: 'not-an-array' } }), [])
})

test('hookScriptPath finds the script a hook command runs', () => {
  // A hook whose script has moved still looks perfectly configured in
  // settings.json and fails on every single session, so the page checks the
  // file exists — which needs the path out of the command line first.
  assert.equal(
    hookScriptPath('node C:/projects/claude-hub/scripts/curate-session.mjs'),
    'C:/projects/claude-hub/scripts/curate-session.mjs',
  )
  assert.equal(hookScriptPath('node C:\\projects\\claude-hub\\scripts\\vault-recall.mjs --worker'), 'C:\\projects\\claude-hub\\scripts\\vault-recall.mjs')
  assert.equal(hookScriptPath('echo hello'), null)
})

// --- the scheduler's own run record, joined to the job's log -----------------

test('taskResultText names the codes these jobs produce and refuses to gloss the rest', () => {
  assert.equal(taskResultText(0), null)
  assert.equal(taskResultText(null), null)
  assert.equal(taskResultText(0x41300), null)
  assert.equal(taskResultText(0x41301), 'still running')
  assert.match(taskResultText(0x800710e0) ?? '', /terminated rather than finished/)
  // An unrecognised code is reported as itself, never as a pass.
  assert.equal(taskResultText(1), 'reported 0x1')
})

// The live 2026-08-23 linker state, which the page rendered as one sentence
// ("last output 65.5h ago") for two different failures.
const LINKER = {
  taskName: 'claude-hub vault linker',
  state: 'Ready',
  lastRunIso: '2026-08-22T08:36:29.000Z',
  lastResult: 0x800710e0,
  nextRunIso: '2026-08-24T08:30:00.000Z',
  startWhenAvailable: false,
  wakeToRun: false,
}

test('runRecordWarnings: a start with nothing in the log after it is a run that produced no output', () => {
  const warnings = runRecordWarnings(LINKER, '2026-08-21T08:30:04.189Z', true)
  assert.match(warnings[0], /started it .* and the log has nothing after that/)
  assert.match(warnings[1], /terminated rather than finished/)
})

test('runRecordWarnings: a log newer than the last start means the missing runs never began', () => {
  const warnings = runRecordWarnings(LINKER, '2026-08-22T08:40:00.000Z', true)
  assert.match(warnings[0], /has not started it since .* the missing runs never began/)
})

test('runRecordWarnings: no probe, or a probe that could not date a run, states the start and infers nothing', () => {
  assert.deepEqual(
    runRecordWarnings({ ...LINKER, lastResult: 0 }, undefined, true).map((w) => w.replace(/ it .*/, ' it …')),
    ['Task Scheduler last started it …'],
  )
  assert.equal(runRecordWarnings({ ...LINKER, lastResult: 0 }, null, true).length, 1)
})

test('runRecordWarnings stays silent on a healthy row and on a task that never ran', () => {
  assert.deepEqual(runRecordWarnings(LINKER, '2026-08-21T08:30:04.189Z', false), [])
  assert.deepEqual(runRecordWarnings({ ...LINKER, lastRunIso: null }, null, true), [
    'Task Scheduler has no record of this task ever starting',
  ])
})

test('runRecordWarnings does not date a running task with an earlier instance result', () => {
  // A running task's LastTaskResult describes some previous instance —
  // attaching it to the named start would report the wrong run's outcome.
  const warnings = runRecordWarnings({ ...LINKER, state: 'Running' }, undefined, true)
  assert.equal(warnings.length, 1)
})

// --- the report's rows: a failure to read is never an absence ----------------

const KNOWN_TASKS = ['claude-hub floor verify', 'claude-hub inbox drain']

const probe = (id: string, state: JobFreshness['state']): JobFreshness => ({
  id,
  label: id,
  state,
  detail: `${id} is ${state}`,
  lastLine: null,
  lastRunIso: '2026-10-19T08:30:00.000Z',
  hoursSince: 28,
  spend: null,
})

test('scheduledAutomations: a failed scheduler query keeps every known job, graded unknown', () => {
  // readScheduledTasks returns no rows when the query fails. Building rows only
  // from that answer took every scheduled job off the page, so the Needs feed
  // went silent and the widget head read "all working".
  const byId = new Map(['drain', 'verify'].map((id) => [id, probe(id, 'current')]))
  const rows = scheduledAutomations([], 'spawn powershell.exe ENOENT', byId)
  assert.deepEqual(
    rows.map((r) => r.label),
    KNOWN_TASKS,
  )
  for (const r of rows) {
    assert.equal(r.kind, 'scheduled')
    assert.equal(r.state, 'unknown')
    assert.match(r.detail, /Task Scheduler/)
    assert.equal(r.taskName, null) // nothing to run when the scheduler cannot be read
  }
})

test('scheduledAutomations: a stale probe still accuses while the scheduler is unreadable', () => {
  const byId = new Map([['drain', probe('drain', 'stale')]])
  const drain = scheduledAutomations([], 'Access is denied', byId).find((r) => r.label === 'claude-hub inbox drain')
  assert.equal(drain?.state, 'attention')
})

test('scheduledAutomations: a known job missing from a successful query needs attention, not silence', () => {
  const verify = parseTaskLine('claude-hub floor verify|Ready|2026-10-19T08:45:00.000Z|0|2026-10-20T08:45:00.000Z|True|False')!
  const byId = new Map(['drain', 'verify'].map((id) => [id, probe(id, 'current')]))
  const rows = scheduledAutomations([verify], null, byId)
  assert.deepEqual(
    rows.map((r) => r.label),
    KNOWN_TASKS,
  )
  assert.equal(rows.find((r) => r.label === 'claude-hub floor verify')?.state, 'ok')
  const drain = rows.find((x) => x.label === 'claude-hub inbox drain')!
  assert.equal(drain.state, 'attention')
  assert.match(drain.detail, /not registered/)
  assert.equal(drain.logId !== null, true) // its log is still one click away
})

test('hookAutomations: an unparseable settings.json reports the hooks unknown, not absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-global-config-'))
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, '{ "hooks": {}, }') // a hand edit's trailing comma
  const rows = hookAutomations(file, new Map())
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'hook')
  assert.equal(rows[0].state, 'unknown')
  assert.match(rows[0].detail, /settings\.json/)
})

test('hookAutomations: no settings.json at all is no hooks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-global-config-'))
  assert.deepEqual(hookAutomations(path.join(dir, 'settings.json'), new Map()), [])
})

// --- spend: over budget reaches the attention path ---------------------------

const spendWindow = (usd: number) => ({ usd, runs: 10, unknownCostRuns: 0 })
const spending = (p: JobFreshness, weekUsd: number): JobFreshness => ({
  ...p,
  spend: { day: spendWindow(weekUsd / 7), week: spendWindow(weekUsd), month: spendWindow(weekUsd * 4) },
})

test('a current job over the 7-day spend ceiling needs attention, and keeps its freshness sentence', () => {
  // The 2026-10 incident: the curate hook graded ok the whole time it spent
  // ~$80 a week curating its own transcripts.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-global-config-'))
  const script = path.join(dir, 'curate-session.mjs')
  fs.writeFileSync(script, '')
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(
    file,
    JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: `node ${script}` }] }] } }),
  )
  const over = hookAutomations(file, new Map([['curate', spending(probe('curate', 'event-driven'), 80)]]))
  assert.equal(over.length, 1)
  assert.equal(over[0].state, 'attention')
  assert.match(over[0].detail, /spent \$80\.00 in 7 days \(ceiling \$20\)/)
  assert.match(over[0].detail, /curate is event-driven/) // the freshness verdict is still there

  const normal = hookAutomations(file, new Map([['curate', spending(probe('curate', 'event-driven'), 9)]]))
  assert.equal(normal[0].state, 'ok')
})

test('a scheduled job over budget needs attention without inventing a scheduler story', () => {
  // runRecordWarnings speaks for a row in FRESHNESS trouble. An over-budget
  // drain whose log is current must not grow "the missing runs never began".
  const drain = parseTaskLine('claude-hub inbox drain|Ready|2026-10-19T08:00:00.000Z|0|2026-10-20T16:00:00.000Z|True|False')!
  const byId = new Map([['drain', spending(probe('drain', 'current'), 25)]])
  const row = scheduledAutomations([drain], null, byId).find((r) => r.label === 'claude-hub inbox drain')!
  assert.equal(row.state, 'attention')
  assert.match(row.detail, /spent \$25\.00/)
  assert.deepEqual(row.warnings, [])
})
