#!/usr/bin/env node
// Verify-run recorder for the floor-status dashboard (ranked gap 7).
// Runs a registered project's verifyCommand and appends the outcome to
// verify-ledger.jsonl at APP_ROOT (append-only, machine-local, gitignored).
//
// Manual mode:  node scripts/record-verify.mjs [projectPath]   (default: cwd)
//   Loud errors + nonzero exit on an unregistered/unconfigured project;
//   otherwise runs the chain, records, and exits with the underlying code.
//
// All mode (--all): runs every registered project that has a verifyCommand.
// This is what the daily "claude-hub floor verify" scheduled task runs, and
// it is the only thing that keeps the ledger fed. Without it the dashboard's
// floor numbers describe whenever somebody last remembered to press the
// button — which was, at one point, six weeks earlier.
//
// Hook mode (--hook): reads Stop-hook stdin JSON, derives the project from
// transcript_path, and fails open (exit 0) on every path — same discipline
// as curate-session.mjs. DORMANT by design: not enabled in any settings
// file; enabling it is roadmap gap 5's separate, deliberate decision.
//
// Security note: the command text shelled out below comes exclusively from
// registry.json — a local, user-edited config file — never from the
// renderer or from hook stdin. Hook stdin only selects WHICH registered
// entry runs; it cannot inject command text.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { listProjects } from '../electron/registry.ts'
import {
  appendVerifyRun,
  findEntryByTranscriptDirName,
  makeVerifyRunRecord,
} from '../electron/floor-core.ts'

// registry.ts and floor-core.ts read process.env.APP_ROOT lazily, but this
// script runs with whatever cwd invoked it (especially in hook mode) — so
// APP_ROOT must be derived from the script's own location.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.APP_ROOT = path.join(__dirname, '..')

// Hook mode discards stdout/stderr, so this logfile is the only way to
// tell "hook broken" from "hook found nothing" (the curate-session.mjs
// lesson). Logging must never itself break the hook.
const LOG_PATH = path.join(__dirname, 'record-verify.log')
function log(msg) {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [pid ${process.pid}] ${msg}\n`)
  } catch {
    /* logging must never break the run */
  }
}

// Verify chains are supposed to be fast (layer-1 floor: seconds, not
// minutes), but npm's startup tax is real — 10 minutes is a generous
// ceiling that still guarantees a hung chain can't wedge a Stop hook.
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000

function runAndRecord(entry) {
  const startedAt = Date.now()
  let ok = true
  let exitStatus = 0
  let output = ''
  try {
    output = execSync(entry.verifyCommand, {
      cwd: entry.path,
      encoding: 'utf-8',
      timeout: VERIFY_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    })
  } catch (err) {
    ok = false
    // execSync sets status=null on timeout/signal kills — the tested
    // builder normalizes that to exitCode: null.
    exitStatus = err.status
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
  const record = makeVerifyRunRecord({
    projectPath: entry.path,
    ok,
    exitStatus,
    durationMs: Date.now() - startedAt,
    command: entry.verifyCommand,
    timestamp: new Date().toISOString(),
  })
  appendVerifyRun(record)
  return { record, output }
}

function runAllMode() {
  const entries = listProjects().filter((p) => p.verifyCommand)
  if (entries.length === 0) {
    console.log('[record-verify] no registered project has a verifyCommand — nothing to run.')
    log('all: no configured projects')
    process.exit(0)
  }
  let red = 0
  for (const entry of entries) {
    // A project that isn't on disk has no floor to read. Running the command
    // anyway records a red run, which would state as a test failure what is
    // actually a missing checkout — the dashboard already reports missing
    // paths as their own finding.
    if (!fs.existsSync(entry.path)) {
      console.log(`[record-verify] ${entry.name}: SKIPPED — path is missing (${entry.path})`)
      log(`all skip: ${entry.name} path missing`)
      continue
    }
    const { record } = runAndRecord(entry)
    const secs = Math.round(record.durationMs / 1000)
    console.log(
      `[record-verify] ${entry.name}: ${record.ok ? 'GREEN' : `RED (exit ${record.exitCode})`} in ${secs}s — recorded.`,
    )
    log(`all done: ${entry.name} ok=${record.ok} exit=${record.exitCode} durationMs=${record.durationMs}`)
    if (!record.ok) red++
  }
  process.exit(red > 0 ? 1 : 0)
}

function runManualMode(rawPath) {
  const resolved = path.resolve(rawPath)
  const entry = listProjects().find((p) => p.path.toLowerCase() === resolved.toLowerCase())
  if (!entry) {
    console.error(`[record-verify] ERROR: "${resolved}" is not a registered project (see registry.json).`)
    process.exit(1)
  }
  if (!entry.verifyCommand) {
    console.error(
      `[record-verify] ERROR: project "${entry.name}" has no verifyCommand configured in registry.json.`,
    )
    process.exit(1)
  }

  console.log(`[record-verify] ${entry.name}: running "${entry.verifyCommand}" ...`)
  const { record, output } = runAndRecord(entry)
  log(`manual done: ${entry.name} ok=${record.ok} exit=${record.exitCode} durationMs=${record.durationMs}`)
  if (record.ok) {
    console.log(`[record-verify] ${entry.name}: GREEN in ${Math.round(record.durationMs / 1000)}s — recorded.`)
    process.exit(0)
  }
  console.error(output.slice(-4000))
  console.error(
    `[record-verify] ${entry.name}: RED (exit ${record.exitCode}) in ${Math.round(record.durationMs / 1000)}s — recorded.`,
  )
  process.exit(record.exitCode ?? 1)
}

function runHookMode() {
  const hookInput = JSON.parse(fs.readFileSync(0, 'utf-8'))
  const transcriptPath = hookInput.transcript_path
  if (!transcriptPath) {
    log('hook exit: no transcript_path in stdin')
    process.exit(0)
  }
  // transcript_path is ~/.claude/projects/<sanitized-dirname>/<id>.jsonl —
  // the dirname-to-entry match rule lives (tested) in floor-core.
  const dirName = path.basename(path.dirname(transcriptPath))
  const entry = findEntryByTranscriptDirName(dirName, listProjects())
  if (!entry) {
    log(`hook exit: no registered project matches ${dirName}`)
    process.exit(0)
  }
  if (!entry.verifyCommand) {
    log(`hook exit: ${entry.name} has no verifyCommand`)
    process.exit(0)
  }
  const { record } = runAndRecord(entry)
  log(`hook done: ${entry.name} ok=${record.ok} exit=${record.exitCode} durationMs=${record.durationMs}`)
  process.exit(0)
}

if (process.argv.includes('--hook')) {
  try {
    runHookMode()
  } catch (err) {
    // Fail open — a recorder that blocks the user's session ending is
    // worse than a missed ledger line.
    log(`hook exit: unexpected error: ${err}`)
    console.error('[record-verify] unexpected error:', err)
    process.exit(0)
  }
} else if (process.argv.includes('--all')) {
  runAllMode()
} else {
  runManualMode(process.argv[2] ?? process.cwd())
}
