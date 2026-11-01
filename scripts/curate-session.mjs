#!/usr/bin/env node
// Auto-curation Stop hook. Enabled for this project only (see
// C:\projects\claude-hub\.claude\settings.json, added 2026-07-02) — a
// live behavioral change to Claude Code itself, so it stayed dormant by
// design until end-to-end verified and explicitly turned on. Not enabled
// globally; that remains a separate, deliberate decision if ever wanted.
//
// To enable elsewhere: add a Stop hook entry (project-level
// .claude/settings.json, or global ~/.claude/settings.json) that pipes
// the hook's stdin JSON into this script, e.g.:
//   { "hooks": { "Stop": [{ "hooks": [{ "type": "command",
//       "command": "node C:/projects/claude-hub/scripts/curate-session.mjs" }] }] } }
// The path MUST use forward slashes: Claude Code on Windows runs hook
// commands through Git Bash, which strips lone backslashes — a
// backslash path arrives as C:projectsclaude-hub... and node exits 1
// before this script ever runs (the 2026-07-01 "hook inert" bug).
//
// Hook stdin schema (verified against a real Stop invocation, 2026-07-02):
// { session_id, transcript_path, hook_event_name, stop_hook_active }.
// Only readHookInput() below needs to change if the schema ever drifts.
//
// Design (see plan doc + git history for the full council-reviewed
// reasoning): NEVER auto-commits to the vault. Writes SAVE candidates to
// a review queue (_inbox.md) the user approves/rejects from the hub's
// Inbox view — nothing enters the graph without a human tap.
//
// TWO-TIER curation (2026-07-05): frequency is decoupled from model tier to
// keep quality high without burning usage. A cheap HAIKU triage runs on every
// Stop and answers only "is there plausibly anything here?"; most sessions
// stop there for ~nothing. Only when triage says yes does the expensive,
// skeptical SONNET extraction run — it dedups against the vault index and
// writes the note + a confidence the review card shows. Both calls use
// --output-format json so per-call cost is logged (the instrument-before-opus
// decision). The transcript is tail-bounded (curate-core MAX_TRANSCRIPT_CHARS).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTranscriptFile } from '../electron/sessions.ts'
import { listVaultNoteNames, queueVaultCandidate } from '../electron/vault-write-core.ts'
import { readRubric } from '../electron/rubric-core.ts'
import { listProjects } from '../electron/registry.ts'
import { callClaudeSync } from '../electron/call-claude-core.ts'

// Two sequential model calls under ONE harness budget: the SessionEnd hook is
// registered in ~/.claude/settings.json with `"timeout": 300`, and Claude Code
// kills this whole node process at that wall-clock deadline. call-claude-core's
// own 300s default therefore never binds here — it is per call, and two of them
// do not fit. That is why 304 of 1,681 runs (18.1%) reached the triage call and
// never logged an outcome: the harness reaped them mid-call, after
// recordTriagedSession had already banked the spend, so each was paid for,
// discarded, and then suppressed from retry.
//
// These sum to 270s, leaving ~30s for transcript parsing, the vault read and
// the queue write. A call that blows its budget now throws a named timeout this
// script can log, instead of the process vanishing silently.
const TRIAGE_TIMEOUT_MS = 60_000
const EXTRACT_TIMEOUT_MS = 210_000
import {
  MIN_TURNS_FOR_REVIEW,
  MIN_GROWTH_FOR_RETRIAGE,
  buildTranscriptText,
  evaluateReviewOutput,
  evaluateTriageOutput,
  buildExtractPrompt,
  TRIAGE_PROMPT,
  deriveProjectName,
  hasProjectScopedRegistration,
  listStoreTitles,
  shouldTriageSession,
  recordTriagedSession,
  curateStandDownReason,
} from '../electron/curate-core.ts'
// Shared with the recall hook rather than reimplemented — the two hooks must
// agree on what counts as a throwaway session.
import { isEphemeralSessionCwd } from '../electron/recall-core.ts'

// registry.ts reads process.env.APP_ROOT lazily inside its functions, but a
// hook invocation runs with whatever cwd the session that triggered it had
// — not claude-hub's own directory — so APP_ROOT must be derived from this
// script's own location, not left to default/inherit from the environment.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.APP_ROOT = path.join(__dirname, '..')

// Every fail-open path below exits 0 and only console.error()s — output a
// Stop hook discards — so "hook broken" and "hook found nothing" were
// indistinguishable from outside (cost a full forensic session to tell
// apart, 2026-07-01). This logfile is the difference detector; it must
// never itself become a reason the hook fails, hence the swallowed catch.
const LOG_PATH = path.join(__dirname, 'curate-session.log')
// One file per session holding the message count at its last paid triage, so a
// resumed session that ends again is not re-read for free (see
// curate-core.ts → per-session idempotency). Same shape as the recall hook's
// scripts/.vault-recall-state/.
const STATE_DIR = path.join(__dirname, '.curate-session-state')
function log(msg) {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [pid ${process.pid}] ${msg}\n`)
  } catch {
    /* logging must never break the hook */
  }
}

function fmtCost(costUsd) {
  return costUsd == null ? 'n/a' : `$${costUsd.toFixed(4)}`
}

// --- optional project-scoped overrides ---------------------------------------
// A project can aim its own SessionEnd hook at this same script with --rubric
// and/or --inbox, so its sessions are judged by a rubric that accepts what the
// vault's rejects (e.g. acquired domain knowledge) and queued to a store inside
// that project. With no flags the behavior is unchanged, so the global hook is
// unaffected. Flags rather than env vars: hook commands run through Git Bash on
// Windows, and argv survives that intact.
function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null
}
const RUBRIC_OVERRIDE = argValue('--rubric')
const INBOX_OVERRIDE = argValue('--inbox')

// Fall back to the vault rubric if the override is unreadable, but say so
// loudly: a silently-wrong rubric path would judge domain findings by criteria
// that reject them and log an ordinary "found nothing", which is exactly the
// indistinguishable-failure mode this script's logfile exists to prevent.
function readRubricOverride() {
  if (!RUBRIC_OVERRIDE) return null
  try {
    const text = fs.readFileSync(RUBRIC_OVERRIDE, 'utf-8').trim()
    if (text) return text
    log(`WARN rubric override ${RUBRIC_OVERRIDE} is empty — falling back to the vault rubric`)
  } catch (err) {
    log(`WARN rubric override ${RUBRIC_OVERRIDE} unreadable (${err.message}) — falling back to the vault rubric`)
  }
  return null
}

function readHookInput() {
  const raw = fs.readFileSync(0, 'utf-8')
  return JSON.parse(raw)
}

async function main() {
  const hookInput = readHookInput()
  const transcriptPath = hookInput.transcript_path
  const sessionId = hookInput.session_id ?? 'unknown'
  log(
    `start session=${sessionId} transcript=${transcriptPath}` +
      (RUBRIC_OVERRIDE || INBOX_OVERRIDE
        ? ` rubric=${RUBRIC_OVERRIDE ?? '(vault)'} inbox=${INBOX_OVERRIDE ?? '(vault)'}`
        : ''),
  )

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log('exit: no transcript path or file missing')
    process.exit(0)
  }

  const standDown = await curateStandDownReason(process.env, transcriptPath)
  if (standDown) {
    log(`exit: ${standDown}`)
    process.exit(0)
  }

  // Before the pre-filter, so a doubled session costs nothing at all.
  const cwd = hookInput.cwd ?? process.cwd()
  if (!INBOX_OVERRIDE && hasProjectScopedRegistration(cwd)) {
    log(`exit: project at ${cwd} registers its own scoped curate hook — standing down`)
    process.exit(0)
  }

  // A parallel-build worktree arm under the OS temp tree is a throwaway copy of
  // a repo whose work is reported back into — and curated from — the session
  // that spawned it, so triaging it pays to read the same finding twice from a
  // directory that no longer exists. The cheap recall hook already stands down
  // on these; the expensive one had no reason not to.
  if (isEphemeralSessionCwd(cwd)) {
    log(`exit: ephemeral cwd ${cwd} — throwaway worktree/temp session`)
    process.exit(0)
  }

  const messages = await parseTranscriptFile(transcriptPath)
  if (messages.length < MIN_TURNS_FOR_REVIEW) {
    log(`exit: ${messages.length} messages, below pre-filter`)
    process.exit(0) // below pre-filter, skip — no review call spent
  }

  // Idempotency, still before any paid call: SessionEnd fires again every time a
  // resumed session ends, and re-reading a transcript already paid for was 66%
  // of this hook's lifetime spend. Needs a REAL session id to key on — the
  // 'unknown' fallback above would pool every id-less run into one state entry
  // and skip all of them after the first.
  const stateKey = typeof hookInput.session_id === 'string' ? hookInput.session_id : null
  if (stateKey && !shouldTriageSession(STATE_DIR, stateKey, messages.length)) {
    log(`exit: already triaged, ${messages.length} messages is under +${MIN_GROWTH_FOR_RETRIAGE} since the last one`)
    process.exit(0)
  }

  const transcriptText = buildTranscriptText(messages)
  log(`parsed ${messages.length} messages, reviewing ${transcriptText.length} chars`)

  // Record before spending, not after: a call that fails or hangs has still cost
  // something, and marking only on success would let a session that keeps
  // failing re-pay on every end.
  if (stateKey) recordTriagedSession(STATE_DIR, stateKey, messages.length)

  // --- Tier 1: cheap haiku triage ------------------------------------------
  let triage
  try {
    triage = callClaudeSync('haiku', TRIAGE_PROMPT + transcriptText, { timeoutMs: TRIAGE_TIMEOUT_MS })
  } catch (err) {
    log(`exit: triage call failed: ${err.message} (status=${err.status ?? 'n/a'})`)
    console.error('[curate-session] triage call failed:', err.message)
    process.exit(0) // fail open — never block the user's session ending
  }
  if (!evaluateTriageOutput(triage.text)) {
    log(`done: triage=no-candidate (cost=${fmtCost(triage.costUsd)})`)
    process.exit(0) // the common path: nothing here, no expensive call spent
  }

  // --- Tier 2: skeptical sonnet extraction ---------------------------------
  // Both branches now read the store's directory. index.md is append-only
  // bookkeeping only vault-write-core maintains, so it drifts from the vault
  // whenever a note arrives another way — 12 of 201 were missing from it when
  // this was measured, and dedup could not see any of them.
  const existingTitles = INBOX_OVERRIDE ? listStoreTitles(path.dirname(INBOX_OVERRIDE)) : listVaultNoteNames()

  let extract
  try {
    extract = callClaudeSync('sonnet', buildExtractPrompt(existingTitles, readRubricOverride() ?? readRubric()) + transcriptText, { timeoutMs: EXTRACT_TIMEOUT_MS })
  } catch (err) {
    log(`exit: extract call failed: ${err.message} (status=${err.status ?? 'n/a'})`)
    console.error('[curate-session] extract call failed:', err.message)
    process.exit(0)
  }

  const totalCost = fmtCost((triage.costUsd ?? 0) + (extract.costUsd ?? 0))
  const outcome = evaluateReviewOutput(extract.text)
  if (outcome.kind === 'unparseable') {
    log(`exit: unparseable extract (${extract.text.length} chars, cost=${totalCost}): ${extract.text.slice(0, 300)}`)
    console.error('[curate-session] could not parse extract output:', extract.text)
    process.exit(0)
  }

  if (outcome.saves.length === 0) {
    log(`done: extract found nothing to save (cost=${totalCost})`)
    process.exit(0)
  }

  // One session can now yield several notes (SessionEnd runs once per session);
  // queue each. queueVaultCandidate dedups by title against the inbox, so a
  // finding already queued from an earlier session end is skipped here too.
  const projectName = deriveProjectName(transcriptPath, listProjects())
  let queued = 0
  let dupes = 0
  for (const save of outcome.saves) {
    const result = queueVaultCandidate(
      {
        title: save.title,
        content: save.content,
        justification: save.justification,
        confidence: save.confidence,
        sessionId,
        projectName,
      },
      // `?? undefined`, not `?? null`: the parameter's default only applies to
      // undefined, so a null here would write to the string "null".
      INBOX_OVERRIDE ?? undefined,
    )
    if (result.skippedDuplicate) dupes++
    else queued++
  }
  log(`done: queued ${queued} note(s)${dupes ? `, skipped ${dupes} duplicate(s)` : ''} (cost=${totalCost})`)

  process.exit(0)
}

main().catch((err) => {
  log(`exit: unexpected error: ${err}`)
  // readHookInput()'s stdin read/JSON.parse isn't covered by the try/catch
  // inside main() — this closes that gap so a malformed/empty hook stdin
  // still fails open (exit 0) instead of leaving main() unhandled-rejected,
  // which could make Claude Code treat a nonzero exit as a real failure
  // rather than "nothing to do here."
  console.error('[curate-session] unexpected error:', err)
  process.exit(0)
})
