#!/usr/bin/env node
// Vault recall-injection UserPromptSubmit hook — the read-side mirror of
// curate-session.mjs. Registered globally in ~/.claude/settings.json
// (forward-slash path, same Git Bash gotcha as the curate hook).
//
// THREE-PHASE, because UserPromptSubmit BLOCKS the user's prompt and a
// `claude -p` haiku call measures ~13-16s even warm (CLI startup dominates
// — measured 2026-08-09), while the hook's own no-op path is ~120ms:
//  - SEEN: the first substantive prompt of a session only records that it
//    happened. Nothing is spent. (Was: this phase paid. 31 of 86 measured
//    sessions never sent a second prompt, so those calls bought an answer
//    that had nowhere to land — see decideRecallAction.)
//  - REQUEST: on the SECOND substantive prompt, spawn a DETACHED worker
//    (this same script, --worker) that runs the match call off the critical
//    path, then exit silently at once. By now the session has demonstrated
//    it will keep talking, so a delivery prompt is likely to exist.
//  - DELIVER: on a later prompt (any prompt, even "continue"), if the
//    worker left a confident-match result, print it to stdout — which
//    Claude Code injects into the session's context — exactly once.
// Sessions of one or two prompts never get an injection; acceptable for the
// experiment, and the log still records what the matcher would have said.
//
// On anything else — trivial prompt, no confident match, any error — the
// hook stays silent and exits 0 (a hook that blocks or chats on every
// prompt would be worse than no hook).
//
// Recursion safety, in depth order:
//  1. CLAUDE_HUB_HEADLESS env var — set centrally by call-claude-core.ts,
//     which every hub automation claude -p call goes through, and checked
//     first thing, so hub machinery can never trigger a match call. This is
//     the reliable guard: a curate triage of a SMALL transcript produces a
//     prompt under the size ceiling below (observed live, 2026-08-09).
//  2. MAX_PROMPT_CHARS — belt-and-suspenders for headless prompts that
//     embed transcripts/notes, and for third-party agent loops.
//  3. MAX_ATTEMPTS_PER_DAY across all sessions — spend backstop against
//     agent loops that mint sessions in bulk.
//
// Measurement is built in: every offer is logged here (the denominator)
// and carries RECALL_MARKER in the transcript, so the hit-rate question —
// do offered notes actually get read? — is answerable by the same
// transcript scan that produced the 2026-08-09 evidence report.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

if (process.env.CLAUDE_HUB_HEADLESS === '1') process.exit(0)

const { deriveProjectName } = await import('../electron/curate-core.ts')
// The note list comes from the vault directory, not index.md: the index was
// missing 12 of 201 notes when measured, and recall could never offer one of
// them. It also makes formatInjection's `read: <vault>\<title>.md` path exact,
// since the filename IS the title.
const { listVaultNoteNames } = await import('../electron/vault-write-core.ts')
const { callClaudeSync } = await import('../electron/call-claude-core.ts')
const {
  shouldAttemptRecall,
  isEphemeralSessionCwd,
  decideRecallAction,
  composeTaskContext,
  buildMatchPrompt,
  evaluateMatchOutput,
  formatInjection,
  pruneAndCountToday,
  MAX_ATTEMPTS_PER_DAY,
} = await import('../electron/recall-core.ts')
const { listProjects } = await import('../electron/registry.ts')
const { hookScope, inHookScope, OUT_OF_SCOPE } = await import('../electron/hook-scope.ts')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
// registry.ts reads APP_ROOT lazily; hook cwd is the triggering session's
// project, not claude-hub — same pinning the curate hook needs.
process.env.APP_ROOT = path.join(__dirname, '..')

const STATE_DIR = path.join(__dirname, '.vault-recall-state')
const LOG_PATH = path.join(__dirname, 'vault-recall.log')

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

// Attempt markers are bare session ids; job/result files add an extension.
// The daily cap counts only the markers.
const markerPath = (sessionId) => path.join(STATE_DIR, sessionId)
const jobPath = (sessionId) => `${markerPath(sessionId)}.job`
const resultPath = (sessionId) => `${markerPath(sessionId)}.result`
// "this session sent one substantive prompt" — deliberately dotted so the daily
// cap, which counts bare markers, does not see it. Seeing a prompt is free.
const seenPath = (sessionId) => `${markerPath(sessionId)}.seen`

// --- worker: the slow half, detached from any prompt -----------------------

function runWorker(job) {
  const titles = listVaultNoteNames()
  if (titles.length === 0) {
    log(`worker exit: vault empty (session=${job.sessionId})`)
    return
  }
  let result
  try {
    result = callClaudeSync('haiku', buildMatchPrompt(job.prompt, job.projectName, titles), { timeoutMs: 60_000 })
  } catch (err) {
    log(`worker exit: match call failed: ${err.message} (session=${job.sessionId})`)
    return
  }
  const { text, costUsd } = result
  const matches = evaluateMatchOutput(text, titles)
  if (matches.length === 0) {
    log(`worker done: no-match (session=${job.sessionId} cost=${fmtCost(costUsd)})`)
    return
  }
  // Written atomically via rename so the deliver phase can never read a
  // half-written block.
  const tmp = `${resultPath(job.sessionId)}.tmp`
  fs.writeFileSync(tmp, formatInjection(matches))
  fs.renameSync(tmp, resultPath(job.sessionId))
  log(
    `worker done: matched ${matches.length} ${JSON.stringify(matches.map((m) => m.title))} (session=${job.sessionId} cost=${fmtCost(costUsd)})`,
  )
}

// --- hook: the fast half, runs on every prompt -----------------------------

function runHook() {
  const hookInput = JSON.parse(fs.readFileSync(0, 'utf-8'))
  const sessionId = hookInput.session_id ?? 'unknown'
  const prompt = typeof hookInput.prompt === 'string' ? hookInput.prompt : ''
  // First: registered globally, this runs on every prompt in every session,
  // but it only acts in claude-hub's workspace and registered projects
  // (electron/hook-scope.ts). Logged once per task-like prompt, not per turn.
  const cwd = hookInput.cwd ?? process.cwd()
  const scope = hookScope(process.env.APP_ROOT)
  if (scope.error) log(`warn: ${scope.error}; scope narrowed to the workspace and sandbox`)
  if (!inHookScope(cwd, scope.roots)) {
    if (shouldAttemptRecall(prompt)) log(`exit: ${OUT_OF_SCOPE} (session=${sessionId})`)
    return
  }
  fs.mkdirSync(STATE_DIR, { recursive: true })

  const pending = resultPath(sessionId)
  const action = decideRecallAction({
    hasResult: fs.existsSync(pending),
    hasAttempted: fs.existsSync(markerPath(sessionId)),
    hasSeen: fs.existsSync(seenPath(sessionId)),
    promptIsSubstantive: shouldAttemptRecall(prompt),
    ephemeralCwd: isEphemeralSessionCwd(cwd),
  })

  // DELIVER: a pending result gets injected on any prompt, once. Rename before
  // printing so a crash can never deliver twice.
  if (action === 'deliver') {
    const delivered = `${pending}.delivered`
    try {
      fs.renameSync(pending, delivered)
      console.log(fs.readFileSync(delivered, 'utf-8'))
      log(`done: delivered (session=${sessionId})`)
    } catch (err) {
      log(`exit: deliver failed: ${err.message} (session=${sessionId})`)
    }
    return
  }

  // SEEN: the first substantive prompt only records that it happened. Spending
  // here would be spending before the session has shown it will send a second
  // prompt to deliver on — and 31 of 86 measured sessions never did.
  // It records the prompt ITSELF, not just the fact of it: this is the task
  // statement, and the paid call one turn later used to read only the
  // follow-up. Free — the prompt is already in hand.
  if (action === 'mark-seen') {
    fs.writeFileSync(seenPath(sessionId), prompt)
    return // silent, and nothing consumed: .seen is not a bare marker, so the cap ignores it
  }
  if (action === 'skip') return

  // ATTEMPT: second substantive prompt — the session is still talking, so an
  // injection has somewhere to land.
  if (pruneAndCountToday(STATE_DIR, Date.now()) >= MAX_ATTEMPTS_PER_DAY) {
    log(`exit: daily attempt cap reached, skipping session=${sessionId}`)
    return
  }
  if (listVaultNoteNames().length === 0) {
    log('exit: vault empty')
    return
  }

  const projectName = deriveProjectName(hookInput.transcript_path ?? '', listProjects())
  // The task statement recorded a turn ago, plus this prompt. A .seen written
  // by the previous build holds '' — composeTaskContext then falls back to
  // this prompt alone, which is exactly the old behaviour.
  let firstPrompt = ''
  try {
    firstPrompt = fs.readFileSync(seenPath(sessionId), 'utf-8')
  } catch {
    /* no .seen (pruned, or a delivered result arrived first) — this prompt stands alone */
  }
  const task = composeTaskContext(firstPrompt, prompt)
  fs.writeFileSync(markerPath(sessionId), '') // mark before spawning: a crashed worker still counts as the attempt
  fs.writeFileSync(jobPath(sessionId), JSON.stringify({ sessionId, prompt: task, projectName }))
  spawn(process.execPath, [__filename, '--worker', jobPath(sessionId)], {
    detached: true,
    stdio: 'ignore',
    // On Windows a detached console process gets its own visible console
    // window — this flashed a cmd window at the user on every request
    // phase until hidden (observed live, 2026-08-09).
    windowsHide: true,
  }).unref()
  // promptChars stays the length of THIS prompt — it is what locates the turn
  // in a transcript after the fact (that is how the wrong-input loss above was
  // found). taskChars is what the matcher was actually paid to read.
  log(
    `start session=${sessionId} project=${projectName} promptChars=${prompt.trim().length} taskChars=${task.length} (worker spawned)`,
  )
}

try {
  if (process.argv[2] === '--worker') {
    const job = JSON.parse(fs.readFileSync(process.argv[3], 'utf-8'))
    runWorker(job)
  } else {
    runHook()
  }
} catch (err) {
  log(`exit: unexpected error: ${err}`)
  console.error('[vault-recall] unexpected error:', err)
}
process.exit(0)
