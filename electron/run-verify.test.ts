import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// APP_ROOT holds both registry.json and the verify ledger this appends to, so
// redirecting it is what keeps a test run out of the real ledger — the ledger
// is what the dashboard's green-streak reads, and a stray red in it would be
// indistinguishable from a real failing verify.
process.env.APP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-verify-root-'))
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-verify-proj-'))

const GREEN = { id: 'verify-green', name: 'green', path: project, addedAt: '2026-08-01T00:00:00.000Z', verifyCommand: 'exit 0' }
const RED = { id: 'verify-red', name: 'red', path: project, addedAt: '2026-08-01T00:00:00.000Z', verifyCommand: 'exit 3' }
const UNSET = { id: 'verify-unset', name: 'unset', path: project, addedAt: '2026-08-01T00:00:00.000Z' }
fs.writeFileSync(path.join(process.env.APP_ROOT, 'registry.json'), JSON.stringify([GREEN, RED, UNSET]))

const { runVerify } = await import('./run-verify.ts')
const { ledgerPath, parseLedgerLines } = await import('./floor-core.ts')
const { startVerifyJob, endVerifyJob } = await import('./verify-jobs.ts')

function ledger() {
  try {
    return parseLedgerLines(fs.readFileSync(ledgerPath(), 'utf-8'))
  } catch {
    return []
  }
}

function resetLedger(): void {
  fs.rmSync(ledgerPath(), { force: true })
}

test('a passing verify records green in the ledger', async () => {
  resetLedger()

  await runVerify(GREEN.id)

  const records = ledger()
  assert.equal(records.length, 1)
  assert.equal(records[0].ok, true)
  assert.equal(records[0].command, 'exit 0')
})

// The exit code is carried through rather than flattened to a boolean: a red
// verify's code is what tells you whether the chain failed or never ran. The
// record spells it `exitCode` — `exitStatus` is only the input field name, and
// a ledger line with the wrong key parses back with the value silently gone.
test('a failing verify records red, with the status the command exited on', async () => {
  resetLedger()

  await runVerify(RED.id)

  const records = ledger()
  assert.equal(records.length, 1)
  assert.equal(records[0].ok, false)
  assert.equal(records[0].exitCode, 3)
})

// One run per project at a time. The ledger is append-only and the in-flight
// job registry is the only thing standing between a double-click and two
// racing writes for the same project.
test('a second run while one is already in flight does nothing', async () => {
  resetLedger()
  const jobId = startVerifyJob(GREEN.id, GREEN.name, 'exit 0')
  try {
    await runVerify(GREEN.id)
    assert.deepEqual(ledger(), [], 'the second caller must not spawn or record anything')
  } finally {
    endVerifyJob(jobId)
  }
})

test('an unregistered id and a project with no verify command both refuse', async () => {
  await assert.rejects(() => runVerify('no-such-project'), /No registered project with id/)
  await assert.rejects(() => runVerify(UNSET.id), /"unset" has no verifyCommand configured/)
})
