import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { readFirstLineExcerpt } from './text-excerpt.ts'
import { resolveKnownPath } from './resolve-known-path.ts'
import { childEnv } from './launch-core.ts'
import { headlessEnv } from './call-claude-core.ts'
import { findSessionFiles, isHeadlessSessionCached, parseTranscriptFile } from './sessions.ts'
import { queueVaultCandidate } from './vault-write-core.ts'
import { VAULT_PATH } from './vault-core.ts'
import { endJob, findJobByPath, setJobKiller, setJobPhase, startJob, wasCancelled } from './sandbox-jobs.ts'
import type { DraftLearningsResult, ExperimentEntry, QueueToInboxResult } from '../shared/ipc-types'

const SANDBOX_PATH = 'C:\\projects\\claude-hub-sandbox'
const VAULT_INDEX_PATH = path.join(VAULT_PATH, 'index.md')

// Sync, cheap enumeration of experiment folders — kept synchronous because
// promote.ts and resolveExperimentPath validate renderer-supplied paths
// against it inline. The full async listExperiments below layers on the
// per-experiment metadata the UI needs.
export function listExperimentPaths(): string[] {
  if (!fs.existsSync(SANDBOX_PATH)) return []
  return fs
    // Dotfolders generally, not just .git — `.claude` is sandbox-wide config
    // and was being listed (and counted) as if it were someone's experiment.
    .readdirSync(SANDBOX_PATH)
    .filter((name) => !name.startsWith('.'))
    .map((name) => path.join(SANDBOX_PATH, name))
    .filter((experimentPath) => fs.statSync(experimentPath).isDirectory())
}

// A draft is stale when a real (non-headless) session progressed after
// LEARNINGS.md was written. Headless files must be excluded here: the
// summarize call's own transcript always finishes *after* the LEARNINGS.md
// write, so counting it would flag every fresh draft as stale.
async function isLearningsStale(experimentPath: string, learningsPath: string): Promise<boolean> {
  const learningsMtimeMs = fs.statSync(learningsPath).mtimeMs
  const files = findSessionFiles(experimentPath)
  const headless = await Promise.all(files.map((f) => isHeadlessSessionCached(f.filePath)))
  return files.some((f, i) => !headless[i] && fs.statSync(f.filePath).mtimeMs > learningsMtimeMs)
}

// Lists what exists — doesn't create experiment folders. Those come from
// Claude Code itself git-initializing a subfolder when the user starts
// sandbox work, per the plan's "sandbox learnings capture is a
// content/prompt-design question, decoupled from the app's architecture."
export async function listExperiments(): Promise<ExperimentEntry[]> {
  const entries: ExperimentEntry[] = []
  for (const experimentPath of listExperimentPaths()) {
    const learningsPath = path.join(experimentPath, 'LEARNINGS.md')
    const learningsExcerpt = readFirstLineExcerpt(learningsPath)
    const hasLearnings = learningsExcerpt !== null
    // Full content eagerly here rather than via a lazy read IPC: the sandbox
    // holds a handful of short LLM-drafted files, so the list payload stays
    // small and the detail pane can show the whole document on selection.
    const learningsContent = hasLearnings ? fs.readFileSync(learningsPath, 'utf-8') : null

    entries.push({
      name: path.basename(experimentPath),
      path: experimentPath,
      hasLearnings,
      learningsExcerpt,
      learningsContent,
      learningsStale: hasLearnings && (await isLearningsStale(experimentPath, learningsPath)),
      lastModified: fs.statSync(experimentPath).mtime.toISOString(),
    })
  }

  return entries.sort((a, b) => b.lastModified.localeCompare(a.lastModified))
}

// Only characters that have no business in a folder name — deliberately not
// reusing launch.ts's cmd-shim blocklist, since this never touches a shell
// command line (fs.mkdirSync takes it as a plain path segment).
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|]/

function assertSafeExperimentName(name: string): void {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Experiment name cannot be empty')
  if (trimmed === '.' || trimmed === '..') throw new Error(`Invalid experiment name: ${name}`)
  if (UNSAFE_NAME_CHARS.test(trimmed)) throw new Error(`Experiment name contains characters unsafe for a folder name: ${name}`)
}

// Same "only operate on known-good paths" discipline as launch.ts's
// resolvePath — never spawn/write against a raw renderer-supplied path.
function resolveExperimentPath(experimentPath: string): string {
  return resolveKnownPath(experimentPath, listExperimentPaths(), 'sandbox experiment')
}

function seedExperimentClaudeMd(experimentPath: string, name: string): void {
  // Pointers, not inlined content — the same lesson config-health exists to
  // enforce: unconditional-load context should point somewhere to check,
  // not dump the catalog/vault contents inline into every session's context.
  const content = `# Sandbox Experiment: ${name}

Before building something new here, check whether it already exists:
- Skills catalog: the claude-hub app's Skills Library (or scan \`.claude/skills/\`
  and \`.agents/skills/\` in registered projects directly).
- Knowledge vault index: ${VAULT_INDEX_PATH} — check for prior findings before
  re-researching something.

If something built here proves reusable, promote it via the claude-hub app's
Promote action rather than copying it manually — it refuses on name conflicts.

LEARNINGS.md in this folder is drafted on demand via the app's "Draft
Learnings" button, not automatically — rough notes here are fine too.
`
  fs.writeFileSync(path.join(experimentPath, 'CLAUDE.md'), content)
}

export function createExperiment(name: string): ExperimentEntry {
  assertSafeExperimentName(name)
  ensureSandboxExists()

  const trimmed = name.trim()
  const experimentPath = path.join(SANDBOX_PATH, trimmed)
  if (fs.existsSync(experimentPath)) throw new Error(`An experiment named "${trimmed}" already exists`)

  fs.mkdirSync(experimentPath, { recursive: true })
  try {
    execFileSync('git', ['init'], { cwd: experimentPath, windowsHide: true })
    seedExperimentClaudeMd(experimentPath, trimmed)
  } catch (err) {
    // Don't leave a half-initialized, un-deletable-from-UI folder behind —
    // fail cleanly rather than littering the sandbox with broken entries
    // that keep showing up in listExperiments().
    fs.rmSync(experimentPath, { recursive: true, force: true })
    throw err
  }

  const stat = fs.statSync(experimentPath)
  return {
    name: trimmed,
    path: experimentPath,
    hasLearnings: false,
    learningsExcerpt: null,
    learningsContent: null,
    learningsStale: false,
    lastModified: stat.mtime.toISOString(),
  }
}

function ensureSandboxExists(): void {
  if (!fs.existsSync(SANDBOX_PATH)) fs.mkdirSync(SANDBOX_PATH, { recursive: true })
}

function logSpawnFailure(label: string) {
  return (err: Error) => console.error(`[sandbox] ${label} failed:`, err)
}

export function openExperimentTerminal(experimentPath: string): void {
  const resolved = resolveExperimentPath(experimentPath)
  // cmd.exe is a native executable, not a .cmd/.bat shim — no shell:true
  // needed, cwd sets the window's starting directory structurally, same
  // pattern as launch.ts's openTerminal. `/k claude` launches straight into
  // a Claude Code session instead of a bare shell — 'claude' is a hardcoded
  // literal here, never derived from experimentPath, so there's no
  // injection surface even though it's a .cmd shim on Windows.
  const child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', 'claude'], {
    cwd: resolved,
    detached: true,
    stdio: 'ignore',
    // Same reason as launch-core's terminals: don't hand a long-lived shell
    // this process's VITE_DEV_SERVER_URL, or an Electron app started from it
    // loads the dev server instead of its own renderer.
    env: childEnv(),
  })
  child.on('error', logSpawnFailure('openExperimentTerminal'))
  child.unref()
}

// Content-only — no format constraints here. Asking one call to both write
// a good freeform document AND obey a rigid machine-parseable structure
// pulls in two directions; in practice the model prioritized being
// thorough over the structure and the format was silently ignored. Split
// into two single-purpose calls instead: this one just writes the file.
const LEARNINGS_PROMPT_PREFIX = `Based on the material below from a Claude Code sandbox experiment folder, draft LEARNINGS.md content: what was tried, what worked, what to carry forward. Write it for someone with no memory of this session. The conversation (if present) is the primary source — it shows what was actually attempted and decided, not just what got committed. If everything below is too sparse to say anything meaningful, write a short note saying so instead of inventing detail.

Respond with ONLY the markdown content for LEARNINGS.md, no other text.

`

// Second call, single narrow job: summarize the just-written LEARNINGS.md
// in plain language. Nothing competing with this instruction (no "also
// write a good document" pull), so the format is much more likely to
// actually be followed.
const SUMMARIZE_PROMPT_PREFIX = `Summarize the LEARNINGS.md content below for someone who wants the gist without reading the whole thing. Avoid jargon and technical detail where you can — focus on what happened and what to do next, in plain language a non-technical reader could follow.

Respond with ONLY lines in this exact format, nothing else:
TITLE: one plain-language sentence summarizing what happened
BULLET: a plain-language point expanding on it
BULLET: another point
(3 to 5 BULLET lines total)
CRITICAL: anything a reader must not miss — a blocker, an unresolved risk, a decision that must not be silently reversed
(zero or more CRITICAL lines — omit entirely if nothing is critical)

LEARNINGS.md:
`

// Parses the TITLE:/BULLET:/CRITICAL: line format above. Any response that
// doesn't produce a TITLE: line just yields no summary — draftLearnings
// still succeeds either way, since LEARNINGS.md itself was already written
// by the first call before this one even runs.
export function parseSummaryResponse(raw: string): { title: string | null; bullets: string[]; critical: string[] } {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const titleLine = lines.find((line) => /^TITLE:\s*/i.test(line))
  const title = titleLine ? titleLine.replace(/^TITLE:\s*/i, '').trim() : null
  const bullets = lines.filter((line) => /^BULLET:\s*/i.test(line)).map((line) => line.replace(/^BULLET:\s*/i, '').trim())
  const critical = lines
    .filter((line) => /^CRITICAL:\s*/i.test(line))
    .map((line) => line.replace(/^CRITICAL:\s*/i, '').trim())

  return { title, bullets, critical }
}

// Sandbox experiments never commit as granularly as regular project work —
// git log alone was too sparse to draft anything useful from. Every
// experiment folder is itself a Claude Code working directory though, so
// its real sessions already land under ~/.claude/projects/ same as any
// registered project — reuse the app's own session parser instead of
// relying on commit messages as the only signal.
const MAX_TRANSCRIPT_CHARS = 40_000 // prompt-size budget; sandbox sessions are short-lived, rarely hit this

interface GatheredTranscripts {
  text: string
  sessions: number // real sessions included, after the headless filter
  truncated: boolean
}

async function gatherTranscriptText(experimentPath: string): Promise<GatheredTranscripts> {
  // Draft Learnings' own `claude -p` calls run with this experiment as cwd,
  // so their sdk-cli transcripts land in the same session dir this reads.
  // Without the headless filter (which every other consumer applies — see
  // status.ts, latest-sessions.ts, activity-core.ts) each draft feeds on the
  // previous draft's output, and because those transcripts are the newest
  // files, the tail-keep below eventually starves out the real session.
  const files = findSessionFiles(experimentPath)
  const headless = await Promise.all(files.map((f) => isHeadlessSessionCached(f.filePath)))
  const real = files.filter((_, i) => !headless[i])
  if (real.length === 0) return { text: '', sessions: 0, truncated: false }

  // Oldest to newest so the draft reads as a narrative.
  const sorted = real
    .map((f) => ({ ...f, mtimeMs: fs.statSync(f.filePath).mtimeMs }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)

  const turns: string[] = []
  for (const file of sorted) {
    const messages = await parseTranscriptFile(file.filePath)
    for (const m of messages) turns.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
  }

  const full = turns.join('\n\n')
  // If it's too large, keep the tail — the end of the conversation is more
  // likely to reflect what was actually concluded than the opening.
  const truncated = full.length > MAX_TRANSCRIPT_CHARS
  return { text: truncated ? full.slice(-MAX_TRANSCRIPT_CHARS) : full, sessions: sorted.length, truncated }
}

// Manual, user-triggered action — deliberately not tied to any "session
// ended" detection. Without an embedded terminal there's no reliable signal
// for that short of hooking Claude Code's Stop event, which stays an
// explicit opt-in decision (see curate-session.mjs) rather than something
// this feature activates as a side effect.
// spawn(), not execFileSync — the sync call blocked Electron's single-
// threaded main process for the whole LLM call (tens of seconds), freezing
// IPC/UI in every window, not just this action. execFile's async form has
// no `input` option (that's sync-only per Node's docs), so this writes the
// prompt to the child's stdin directly instead.
function runClaudeReview(cwd: string, prompt: string, onSpawn?: (kill: () => void) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    // Same shell:true/stdin-only-input reasoning as curate-session.mjs's
    // review call: claude is a .cmd shim on Windows, but the only argv is
    // the fixed literal '-p' — no user/git-controlled data ever enters the
    // command line, so there's no CVE-2024-27980-style injection surface.
    // Not routed through call-claude-core (no JSON envelope, per-experiment
    // cwd, taskkill cancellation below), but the CLAUDE_HUB_HEADLESS guard
    // still applies: it marks the child as hub automation so the global
    // vault-recall UserPromptSubmit hook skips it.
    const child = spawn('claude', ['-p'], { shell: true, windowsHide: true, cwd, env: headlessEnv() })
    // shell:true means child.pid is the cmd.exe wrapper — child.kill() would
    // orphan the node process underneath, so cancellation tree-kills via
    // taskkill (Windows-only, like the rest of this app's hardcoded paths).
    onSpawn?.(() => {
      if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `claude exited with code ${code}`))
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

export async function draftLearnings(experimentPath: string): Promise<DraftLearningsResult> {
  const resolved = resolveExperimentPath(experimentPath)

  // One draft per experiment at a time — with jobs now visible and
  // cancellable, a second concurrent run would race the same LEARNINGS.md.
  if (findJobByPath(resolved)) {
    return { ok: false, message: 'A draft is already running for this experiment.' }
  }

  const jobId = startJob(resolved, path.basename(resolved))
  try {
    const gathered = await gatherTranscriptText(resolved)
    // Cancel is a no-op while no child is registered (before the first spawn,
    // and between the two calls) — cancelJob just flips the flag. Re-check it
    // after each such window so a cancel during the multi-second gather / LLM
    // call actually stops the job instead of running both calls to completion
    // and overwriting LEARNINGS.md anyway.
    if (wasCancelled(jobId)) return { ok: false, message: 'Draft cancelled.' }

    let gitLog = ''
    try {
      gitLog = execFileSync('git', ['log', '--stat', '-20'], { cwd: resolved, encoding: 'utf-8', windowsHide: true })
    } catch {
      // No git history — fine, the transcript is the primary signal now.
    }

    if (!gathered.text.trim() && !gitLog.trim()) {
      return { ok: false, message: 'No sessions or commits found in this experiment yet — nothing to summarize.' }
    }

    const material =
      (gathered.text.trim() ? `CONVERSATION:\n${gathered.text}\n\n` : '') +
      (gitLog.trim() ? `GIT HISTORY:\n${gitLog}` : '')
    const stats = { sessions: gathered.sessions, chars: gathered.text.length, truncated: gathered.truncated }

    let content: string
    try {
      content = (
        await runClaudeReview(resolved, LEARNINGS_PROMPT_PREFIX + material, (kill) => setJobKiller(jobId, kill))
      ).trim()
    } catch (err) {
      if (wasCancelled(jobId)) return { ok: false, message: 'Draft cancelled.' }
      return { ok: false, message: `Draft failed: ${(err as Error).message}` }
    }
    // A cancel that landed while the review was resolving (killer pointed at
    // the now-dead child1) must not still overwrite LEARNINGS.md.
    if (wasCancelled(jobId)) return { ok: false, message: 'Draft cancelled.' }
    fs.writeFileSync(path.join(resolved, 'LEARNINGS.md'), content + '\n')

    // The summary is a nice-to-have on top of an already-successful write —
    // if this second call fails (or is cancelled), still report success
    // (LEARNINGS.md is real and saved), just without a summary to show.
    setJobPhase(jobId, 'summarizing')
    try {
      const summaryRaw = await runClaudeReview(resolved, SUMMARIZE_PROMPT_PREFIX + content, (kill) =>
        setJobKiller(jobId, kill),
      )
      const { title, bullets, critical } = parseSummaryResponse(summaryRaw)
      return { ok: true, title: title ?? undefined, bullets, critical, stats }
    } catch (err) {
      if (!wasCancelled(jobId)) {
        console.error('[sandbox] draftLearnings: summary call failed, LEARNINGS.md was still written:', err)
      }
      return { ok: true, stats }
    }
  } finally {
    endJob(jobId)
  }
}

// The sandbox's only output is learnings → vault, and nothing reaches the
// vault without a human reviewing it first (the council's resolution behind
// the curate hook). So this queues the experiment's LEARNINGS.md to the same
// _inbox.md the hook writes to — via the shared queueVaultCandidate() writer,
// not a direct vault write — tagged as coming from this experiment. Requires
// LEARNINGS.md to already exist (via Draft Learnings or hand-written).
export function queueExperimentToInbox(experimentPath: string): QueueToInboxResult {
  const resolved = resolveExperimentPath(experimentPath)
  const learningsPath = path.join(resolved, 'LEARNINGS.md')
  if (!fs.existsSync(learningsPath)) {
    return { ok: false, message: 'No LEARNINGS.md yet — draft learnings first.' }
  }
  const name = path.basename(resolved)
  const content = fs.readFileSync(learningsPath, 'utf-8')
  const justification = readFirstLineExcerpt(learningsPath) ?? 'Sandbox experiment learnings.'
  const result = queueVaultCandidate({
    title: name,
    content,
    justification,
    sessionId: `sandbox:${name}`,
    projectName: `sandbox:${name}`,
  })
  return { ok: true, skippedDuplicate: result.skippedDuplicate }
}
