// Pure decision logic for the vault recall-injection hook (the read-side
// mirror of curate-core.ts), extracted so it sits under lint + tsc + tests.
// scripts/vault-recall.mjs keeps only I/O: stdin, state, the claude -p call,
// logging. Design constraint (2026-08-09 evidence-of-use verdict): inject
// only on a confident match and stay completely silent otherwise — a hook
// that surfaces two relevant notes a week is valuable; one that dumps
// semi-relevant titles into every session trains everyone to ignore it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stripCodeFence } from './curate-core.ts'
import { VAULT_PATH } from './vault-core.ts'

// Marker prefixing every injected block. Load-bearing for measurement: the
// experiment's hit-rate scan greps transcripts for this marker and then for
// subsequent Reads of the offered notes — keep it stable.
export const RECALL_MARKER = '[vault-recall]'

// Bounds on which prompts are worth a match call. Below the floor are bare
// continuations ("continue", "sure go ahead"); above the ceiling are pasted
// dumps and most headless `claude -p` automation prompts. The ceiling is
// belt-and-suspenders only: hub automation is reliably excluded by the
// CLAUDE_HUB_HEADLESS env var its spawn sites set (a curate triage of a
// small transcript fits under this ceiling — observed live, 2026-08-09).
export const MIN_PROMPT_CHARS = 40
export const MAX_PROMPT_CHARS = 4000

// One match call per session (state-marked), and a daily ceiling across all
// sessions as a spend backstop against agent loops that mint sessions in
// bulk (skyrim-agent produced ~2,900 in July alone).
export const MAX_ATTEMPTS_PER_DAY = 25

// How many attempt markers were laid down today, pruning anything older than
// the retention window on the way past. This is the spend cap's counter: a
// recall attempt costs a haiku call, and the cap is what stops a chatty day
// from turning into 200 of them.
//
// Only BARE markers count. The same directory holds `<id>.job` and
// `<id>.result` files for the detached worker, and counting those would treat
// one attempt as three — the cap would bite at eight prompts a day instead of
// twenty-five, silently, and recall would just stop offering anything.
//
// `now` is a parameter so this is testable without waiting a day.
const MARKER_RETENTION_MS = 3 * 24 * 60 * 60 * 1000

export function pruneAndCountToday(stateDir: string, now: number): number {
  let today = 0
  for (const entry of fs.readdirSync(stateDir)) {
    const p = path.join(stateDir, entry)
    let mtime: number
    try {
      mtime = fs.statSync(p).mtimeMs
    } catch {
      continue // vanished between readdir and stat
    }
    if (now - mtime > MARKER_RETENTION_MS) {
      try {
        fs.unlinkSync(p)
      } catch {
        /* another instance won the race */
      }
    } else if (!entry.includes('.') && new Date(mtime).toDateString() === new Date(now).toDateString()) {
      today++
    }
  }
  return today
}

// Sessions whose working directory sits under the OS temp tree — parallel-build
// worktree arms, throwaway shells — receive one prompt, do the work and exit.
// The two-phase design needs a SECOND prompt to deliver, so a match call for one
// of these can never reach anybody. Measured over the log's first 8.4 days:
// 18 of 79 attempts and 18% of spend, with ZERO delivered.
//
// Deliberately NOT "anything sandbox-ish", which is how this started life on the
// board. The sandbox EXPERIMENT directories are ordinary interactive sessions
// under a real path, and they produced 4 of the 11 injections ever delivered —
// a /sandbox/ rule would have destroyed a third of the experiment's entire
// output to save a further 11% of spend. The worktree arms live under
// %TEMP% and merely have "sandbox" in their path, which is what made the
// coarser rule look safe.
export function isEphemeralSessionCwd(cwd: string, tmpDir: string = os.tmpdir()): boolean {
  if (!cwd || !tmpDir) return false
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  return `${norm(cwd)}/`.startsWith(`${norm(tmpDir)}/`)
}

// Turns the harness writes into the conversation as if they were the user's.
// They pass every other test here — long enough, no slash, no command record —
// and 9 of the first 100 paid match calls were spent reading one. A completed
// background task's summary states no task to recall against.
const HARNESS_TURN_PREFIXES = ['<task-notification>', '<local-command-stdout>', '[Request interrupted']

export function shouldAttemptRecall(prompt: string): boolean {
  const p = prompt.trim()
  if (p.length < MIN_PROMPT_CHARS || p.length > MAX_PROMPT_CHARS) return false
  if (p.startsWith('/')) return false // slash command, not a task statement
  if (p.includes('<command-name>')) return false // harness-expanded command record
  if (HARNESS_TURN_PREFIXES.some((prefix) => p.startsWith(prefix))) return false
  return true
}

export type RecallAction =
  | 'deliver' // a result is waiting; inject it
  | 'mark-seen' // first substantive prompt: record it, spend nothing
  | 'attempt' // second substantive prompt: the session has proven it will keep talking
  | 'skip'

// Which phase of the hook this prompt is in.
//
// The match call used to fire on the FIRST substantive prompt and deliver on
// the second — which pays before knowing a second prompt is ever coming.
// Measured over the log's 86 sessions: 31 of them never sent a second prompt,
// so 31 calls bought an answer nobody could receive, while only 7 sessions
// stopped at exactly two. Waiting one prompt before spending trades those 31
// wasted calls for 7 (net -24, ~31% of all attempts) and still serves the 48
// sessions that go on talking, one prompt later than before.
export function decideRecallAction(s: {
  hasResult: boolean
  hasAttempted: boolean
  hasSeen: boolean
  promptIsSubstantive: boolean
  ephemeralCwd: boolean
}): RecallAction {
  if (s.hasResult) return 'deliver' // free, and the whole point — never gated
  if (!s.promptIsSubstantive) return 'skip' // a later substantive prompt may still qualify
  if (s.hasAttempted) return 'skip' // one paid attempt per session, hit or miss
  if (s.ephemeralCwd) return 'skip' // nothing here can ever receive an injection
  return s.hasSeen ? 'attempt' : 'mark-seen'
}

// What the matcher reads. Paying on the second prompt (above) had a
// consequence nobody costed at the time: the second prompt was also the ONLY
// thing the matcher saw, and the task statement is almost always the first.
// What it was actually being paid to match against reads like
// "should we go with your recommendation now?" and "i mainly want the markdown
// to render instead of seeing the plaintext" — follow-ups that no vault note
// can be relevant to, whatever the notes are represented by. That is the
// dominant loss in this experiment: 65 of the 75 no-match calls read a real
// prompt, and it was the wrong one.
//
// Replayed over 14 real no-match sessions (2026-08-23), same model, same
// vault, same single call: the shipped input matched 1, the first prompt
// alone 5, the two together 7. Both, not just the first — the follow-up is
// what killed a false positive the first prompt raised on its own (a
// bedroom-furniture task matching a note about doc pointers). The first
// prompt is free: mark-seen already reads it a turn earlier and threw it away.
export const FIRST_PROMPT_CHARS = 1000
export const LATEST_PROMPT_CHARS = 500
const SEPARATOR = '\n\nLatest message: '
export const TASK_EXCERPT_CHARS = FIRST_PROMPT_CHARS + LATEST_PROMPT_CHARS + SEPARATOR.length

// The task statement plus the turn that steers it, each with its own budget so
// a long opener cannot crowd out the follow-up.
export function composeTaskContext(firstPrompt: string, latestPrompt: string): string {
  const first = firstPrompt.trim().slice(0, FIRST_PROMPT_CHARS)
  const latest = latestPrompt.trim().slice(0, LATEST_PROMPT_CHARS)
  if (!first) return latest
  if (!latest || latest === first) return first
  return `${first}${SEPARATOR}${latest}`
}

export function buildMatchPrompt(taskPrompt: string, projectName: string, titles: string[]): string {
  const list = titles.map((t) => `- ${t}`).join('\n')
  return `You are a recall gate for a personal engineering knowledge vault. A new Claude Code session just started with the task below. From the vault's note titles, pick AT MOST 3 notes a competent engineer would actually open before starting this task — notes likely to hold directly applicable prior findings (a solved bug, a known gotcha, a decided approach).

The correct answer is usually an empty list. Only include a note when its title clearly overlaps the task's specific technology or problem — never on generic thematic similarity. "high" confidence means: an engineer who skips this note would plausibly re-derive or re-hit something already recorded in it.

Task (project: ${projectName}):
${taskPrompt.trim().slice(0, TASK_EXCERPT_CHARS)}

Vault note titles:
${list}

Respond with ONLY a JSON object, no other text — an empty matches array is the normal answer:
{"matches": [{"title": "exact title copied from the list", "confidence": "high" or "medium" or "low", "reason": "one short sentence: what the note likely answers for this task"}]}
`
}

export interface RecallMatch {
  title: string
  reason: string
}

// Parse the matcher's output down to the notes worth injecting: high
// confidence only, titles validated against the real index (the model can
// hallucinate or paraphrase a title — an offer pointing at a file that
// doesn't exist would burn trust in the whole mechanism), deduped, capped.
// null when the reply is not the requested shape: that is a failed call, not
// "the vault has nothing relevant", and the scorecard must not count it as one.
export function evaluateMatchOutput(raw: string, knownTitles: string[]): RecallMatch[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(raw))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const matches = (parsed as { matches?: unknown }).matches
  if (!Array.isArray(matches)) return null

  const byLower = new Map(knownTitles.map((t) => [t.trim().toLowerCase(), t]))
  const out: RecallMatch[] = []
  const seen = new Set<string>()
  for (const m of matches) {
    const entry = m as { title?: unknown; confidence?: unknown; reason?: unknown }
    if (entry.confidence !== 'high' || typeof entry.title !== 'string') continue
    const canonical = byLower.get(entry.title.trim().toLowerCase())
    if (!canonical || seen.has(canonical)) continue
    seen.add(canonical)
    out.push({
      title: canonical,
      reason: typeof entry.reason === 'string' && entry.reason ? entry.reason : 'prior finding on this topic',
    })
    if (out.length === 3) break
  }
  return out
}

export const VAULT_DIR = VAULT_PATH

// The block written to the hook's stdout, which Claude Code adds to the
// session's context. Note filenames are the titles verbatim (the vault's
// write path already guarantees that mapping).
export function formatInjection(matches: RecallMatch[], vaultDir: string = VAULT_DIR): string {
  const lines = matches.map((m) => `- "${m.title}" — ${m.reason} (read: ${vaultDir}\\${m.title}.md)`)
  return `${RECALL_MARKER} The personal knowledge vault has prior findings that look directly relevant to this task:\n${lines.join('\n')}\nConsult a note before re-deriving what it covers; ignore any that turn out irrelevant.`
}
