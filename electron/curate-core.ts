// Pure decision logic for the auto-curation Stop hook, extracted from
// scripts/curate-session.mjs so it sits under lint + tsc + tests — the
// hook runs headless on every turn end with more autonomy than anything
// else in the system (docs/leverage-architecture.md, ranked gap 4). The
// script keeps only I/O: stdin, transcript parsing, the claude -p call,
// queueing, logging.
import fs from 'node:fs'
import path from 'node:path'
import { sanitize } from './status.ts'
import { isHeadlessSession } from './sessions.ts'
import type { SessionMessage } from '../shared/ipc-types.ts'

// Why the hook must not curate this session, or null to go ahead. Two cases:
// - CLAUDE_HUB_HEADLESS=1: the session is one of the hub's own `claude -p`
//   calls (call-claude-core sets it), and the hook process inherits it.
// - entrypoint 'sdk-cli': any headless run, including other tools' scheduled
//   jobs (the trading bot's analyst legs, ~20 a weekday).
// The hook used to rely on MIN_TURNS_FOR_REVIEW alone to skip its own calls.
// From 2026-10-14 those transcripts parsed as 4 messages, passed it, and the
// hook began curating its own triage/extract calls: 851 of October's 1,375
// paid runs, and 258 sonnet extracts in a row that found nothing.
export async function curateStandDownReason(env: Record<string, string | undefined>, transcriptPath: string): Promise<string | null> {
  if (env.CLAUDE_HUB_HEADLESS === '1') return 'hub-spawned headless call (CLAUDE_HUB_HEADLESS)'
  if (await isHeadlessSession(transcriptPath)) return 'headless transcript (entrypoint sdk-cli)'
  return null
}

// Biased toward running the review rather than skipping it — a candidate
// that never gets generated is worse than one the user discards.
export const MIN_TURNS_FOR_REVIEW = 4

// The hook runs once per session (SessionEnd), so send as much of the
// transcript as a review call comfortably fits rather than a small tail —
// otherwise a long session's early findings scroll out of view and are
// never curated. Still tail-bounded for the rare session that exceeds even
// this (model context / hook time budget); the tail holds the resolutions
// and confirmed findings the SAVE criteria ask about, the head is mostly
// setup. ~500K chars is ~130K tokens — well under the model window, with
// room for the prompt and reply.
export const MAX_TRANSCRIPT_CHARS = 500_000

export function buildTranscriptText(
  messages: Array<Pick<SessionMessage, 'role' | 'text'>>,
  maxChars: number = MAX_TRANSCRIPT_CHARS,
): string {
  return messages
    .map((m) => `[${m.role}] ${m.text}`)
    .join('\n\n')
    .slice(-maxChars)
}

// Haiku wraps its response in a ```json ... ``` markdown fence despite
// REVIEW_PROMPT saying "ONLY a JSON object, no other text" — a real,
// observed model-behavior difference from whatever model this was
// originally tested against. Strip a fence if present rather than
// tightening the prompt further, since the model isn't guaranteed to
// comply either way and this is cheap to handle defensively.
export function stripCodeFence(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/)
  return match ? match[1] : text.trim()
}

export type Confidence = 'high' | 'medium' | 'low'

export interface SaveNote {
  title: string
  content: string
  justification: string
  confidence: Confidence
}

export type ReviewOutcome =
  | { kind: 'saves'; saves: SaveNote[] } // possibly empty — nothing worth keeping
  | { kind: 'unparseable' }

// Classify the extraction model's raw stdout into the (zero or more) notes to
// queue. It runs once per session (SessionEnd), so it may return SEVERAL
// findings — a rich session can hold more than one keeper. Non-JSON is
// 'unparseable' (logged distinctly); valid JSON with no usable findings is an
// empty saves list. Malformed individual findings (missing title/content) are
// dropped, not failed. Every "what counts as a SAVE" rule lives (and is
// tested) here; the caller only queues what it's handed.
export function evaluateReviewOutput(raw: string): ReviewOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(raw))
  } catch {
    return { kind: 'unparseable' }
  }
  // JSON.parse('null') succeeds but reading .findings off null throws — treat
  // any non-object (null, number, string) as unparseable, same as a syntax error.
  if (!parsed || typeof parsed !== 'object') return { kind: 'unparseable' }

  const findings = Array.isArray((parsed as { findings?: unknown }).findings)
    ? ((parsed as { findings: unknown[] }).findings)
    : []
  const saves: SaveNote[] = []
  for (const f of findings) {
    const note = f as { title?: unknown; content?: unknown; justification?: unknown; confidence?: unknown }
    // A finding needs a title AND content to be a real note; drop malformed
    // entries rather than queueing an empty card.
    if (typeof note.title !== 'string' || !note.title || typeof note.content !== 'string' || !note.content) {
      continue
    }
    saves.push({
      title: note.title,
      content: note.content,
      justification:
        typeof note.justification === 'string' && note.justification ? note.justification : '(no justification given)',
      // Anything but the two non-default levels falls back to 'medium' — a
      // missing/garbled confidence shouldn't over- or under-state the
      // recommendation on the review card.
      confidence: note.confidence === 'high' || note.confidence === 'low' ? note.confidence : 'medium',
    })
  }
  return { kind: 'saves', saves }
}

// Cheap first pass (haiku): does this session even plausibly contain a
// vault-worthy finding? A "yes" only triggers the expensive extraction call
// below — it saves nothing — so the prompt is deliberately liberal.
export const TRIAGE_PROMPT = `Does this Claude Code session transcript plausibly contain a durable, reusable, non-obvious finding worth saving to a personal knowledge vault — a hard-won bug or gotcha, a technique that generalizes beyond this one task, a surprising API/library behavior, or a decision worth remembering?

Be liberal: a "yes" only triggers a closer second look, it does not save anything. Answer "no" only if the session was clearly routine, trivial, abandoned, or produced nothing reusable.

Respond with ONLY a JSON object, no other text: {"hasCandidate": true or false}

TRANSCRIPT:
`

// Parse the triage model's output. Unparseable → false: a garbled cheap-pass
// result should not spend the expensive extraction call.
export function evaluateTriageOutput(raw: string): boolean {
  try {
    const parsed = JSON.parse(stripCodeFence(raw))
    return parsed?.hasCandidate === true
  } catch {
    return false
  }
}

// Pull the [[note names]] out of the vault index so the extraction prompt can
// tell the model what already exists and must not be duplicated.
export function parseIndexTitles(indexText: string): string[] {
  const titles: string[] = []
  for (const line of indexText.split('\n')) {
    const m = line.match(/\[\[([^\]]+)\]\]/)
    if (m) titles.push(m[1].trim())
  }
  return titles
}

// The expensive pass (sonnet). Skeptical by construction: default to saving
// nothing, dedup against the existing vault, and forced to argue against each
// candidate before it commits — the write-side half of keeping slop out of the
// graph. Returns EVERY distinct keeper (usually zero, occasionally a few) since
// it runs once per session at SessionEnd, not per turn.
//
// `rubric` is the user-editable save/reject criteria (electron/rubric-core.ts →
// vault RUBRIC.md), injected verbatim so the standard the extractor applies is
// the same one the user reads and tunes in the Rubric settings view. The fixed
// scaffolding around it (skeptical framing, per-note splitting, dedup against
// existing titles, JSON output) stays here.
export function buildExtractPrompt(existingTitles: string[], rubric: string): string {
  const existing = existingTitles.length ? existingTitles.map((t) => `- ${t}`).join('\n') : '(none yet)'
  return `You are curating a personal knowledge vault. A cheap pre-filter flagged this session as possibly worth saving; your job is to decide — skeptically — which durable findings it truly holds (if any) and write a note for each.

Default to saving nothing. Most sessions, even flagged ones, yield zero.

Apply this rubric — it defines exactly what earns a note and what to reject:

${rubric}

Save each DISTINCT finding as its own note — usually zero, sometimes one, occasionally a few (2-3) for a rich session. Do NOT split one finding across several notes, and do NOT pad: a thin session returns an empty list.

Before saving each, argue against it using the rubric's reject rules. If it fails any, drop it.

Existing vault notes — do NOT duplicate these; drop any finding that overlaps one:
${existing}

Respond with ONLY a JSON object, no other text — an empty findings array if nothing is worth keeping:
{"findings": [{"title": "short specific searchable title", "content": "the note, written for someone with no memory of this session, including the concrete fix/pattern", "justification": "one sentence: what the finding is and which rubric criterion it meets", "confidence": "high" or "medium" or "low"}]}

TRANSCRIPT:
`
}

// `claude -p --output-format json` wraps the model's answer in a metadata
// envelope ({ result, total_cost_usd, ... }). Unwrap it to the model's text
// plus the per-call cost for logging; fall back to treating raw as the text
// (cost unknown) if it isn't the envelope shape.
export function extractResultFromJsonOutput(raw: string): { text: string; costUsd: number | null } {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.result === 'string') {
      return { text: parsed.result, costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null }
    }
  } catch {
    /* not the json envelope — treat raw as plain text */
  }
  return { text: raw, costUsd: null }
}

// transcript_path looks like ~/.claude/projects/<sanitized-dirname>/<id>.jsonl
// — match that dirname against every registered project's own sanitize()d
// path (same case-insensitive matching rule status.ts already established)
// to recover a real project name for the queued candidate, instead of
// leaving the reviewer with only an opaque sessionId to judge relevance by.
// Falls back to the raw sanitized dirname if the project isn't registered.
//
// A session run BELOW a registered project — a sandbox experiment in
// claude-hub-sandbox/<experiment>, a worktree — has no exact match, and the raw
// dirname it fell back to became the note's durable `project:` frontmatter. The
// vault ended up grouping one project under several keys (3 notes filed under
// "C--projects-claude-hub-sandbox-<experiment>" rather than "sandbox"), which
// splits it in the by-origin MOC and in any grouping built on that key. So fall
// back to the longest registered project the dirname sits inside, and only then
// to the raw name. Longest wins so a nested registration beats its parent.
export function deriveProjectName(
  transcriptPath: string,
  projects: Array<{ name: string; path: string }>,
): string {
  const dirName = path.basename(path.dirname(transcriptPath)).toLowerCase()
  const exact = projects.find((p) => sanitize(p.path).toLowerCase() === dirName)
  if (exact) return exact.name

  let best: { name: string; length: number } | null = null
  for (const project of projects) {
    const prefix = sanitize(project.path).toLowerCase()
    // The '-' guard keeps "…-sandbox" from swallowing a sibling "…-sandbox2".
    if (!dirName.startsWith(`${prefix}-`)) continue
    if (!best || prefix.length > best.length) best = { name: project.name, length: prefix.length }
  }
  return best ? best.name : path.basename(path.dirname(transcriptPath))
}

// Claude Code MERGES global and project hooks rather than letting the project
// override — so a project that aims the curate script at its own rubric/inbox
// gets BOTH registrations firing on the same SessionEnd. Measured 2026-08-17:
// 45 double-run sessions, each paying twice to triage one transcript and
// queueing the same finding into two different stores. The scoped run is the
// one the project asked for, so the global run stands down when it sees one.
//
// cwd, not the transcript path: a hook runs with the session's project as its
// working directory, while the transcript path is a lossy dash-encoded name
// that cannot be decoded back to a real path. Fails open — an unreadable or
// absent settings file just means no scoped registration to defer to.
// Parsed, not regexed: the command lives in a JSON string, so its own quotes
// arrive escaped as \" and any pattern matching across them has to reason about
// that. Walking the parsed structure sidesteps it.
export function hasProjectScopedRegistration(cwd: string): boolean {
  for (const file of ['settings.json', 'settings.local.json']) {
    let settings: { hooks?: { SessionEnd?: Array<{ hooks?: Array<{ command?: unknown }> }> } }
    try {
      settings = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', file), 'utf-8'))
    } catch {
      continue // absent or unparseable — nothing to defer to
    }
    for (const entry of settings?.hooks?.SessionEnd ?? []) {
      for (const hook of entry?.hooks ?? []) {
        const command = typeof hook?.command === 'string' ? hook.command : ''
        if (command.includes('curate-session.mjs') && command.includes('--inbox')) return true
      }
    }
  }
  return false
}

// The dedup list for a project store is its own entries: one file per finding,
// no central index to parse. `_`-prefixed files are the store's own machinery
// (_inbox.md, _rubric.md), not findings.
export function listStoreTitles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
  } catch {
    return []
  }
}

// ---- per-session idempotency -------------------------------------------------
//
// SessionEnd fires every time a session ends, and a RESUMED session ends again.
// With no per-session state the same transcript was re-read, and re-paid for, on
// every end: measured over the log's first 7 weeks, 1090 of 3039 sessions were
// triaged more than once (one of them 40 times) and the repeat runs cost $165.10
// of $250.59 lifetime spend. The only dedup was a title match AFTER the sonnet
// call had been paid for, and it did not even catch these — one session queued
// the same WinDbg-vs-event-log finding six times under six rephrased titles.
//
// So key on the session id plus a growth measure taken without an LLM call,
// mirroring what the read-side recall hook already keeps in
// scripts/.vault-recall-state/: one small file per session, holding the message
// count at the last PAID triage.

// How much new material makes a resumed session worth re-reading. The unit is a
// parseTranscriptFile message (tool results included), so ~10 is a couple of
// real exchanges rather than one round trip.
//
// Measured against the log's 824 repeat paid runs: 10 suppresses 443 of them
// (54%), and re-triage yield below that line is both low and duplicative (8% of
// zero-growth runs queued a note — a note that by definition re-derived what the
// previous run had already read). Suppressing is not losing: growth accumulates
// against the last PAID run, so a session that keeps working crosses the line
// and is re-read with the new turns still in the transcript. Only the tail after
// a session's FINAL end can go unread, and this constant bounds it — over the
// whole history that would be 19 of 857 sessions and 104 messages, worst case 9.
// Raising it to 20 saves a further 8% of runs and triples that unread tail.
export const MIN_GROWTH_FOR_RETRIAGE = 10

// Entries older than this are swept on the next paid run (the sweep rides the
// path that is about to spend ~$0.23, never the cheap exits). A session resumed
// after a month pays one more triage — the failure direction that does the work
// rather than skipping it — and the directory stays bounded by roughly a month
// of sessions instead of growing forever.
const STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

// Session ids are uuids; anything else is not something to build a path from.
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/

// Message count at the last paid triage, or null when there isn't a usable one.
// EVERY failure — absent, unreadable, garbled, negative — reads as null, and
// null means "triage it". A corrupt state file must never be able to answer
// "already done" for every session and silently switch the hook off.
function readTriagedCount(stateDir: string, sessionId: string): number | null {
  try {
    const value = Number(fs.readFileSync(path.join(stateDir, sessionId), 'utf-8').trim())
    return Number.isFinite(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}

export function shouldTriageSession(
  stateDir: string,
  sessionId: string,
  messageCount: number,
  minGrowth: number = MIN_GROWTH_FOR_RETRIAGE,
): boolean {
  if (!SAFE_SESSION_ID.test(sessionId)) return true
  const previous = readTriagedCount(stateDir, sessionId)
  if (previous === null) return true // never triaged, or the state could not be read
  // Shorter than what was recorded: the state is describing something other than
  // this transcript, so trust the transcript.
  if (messageCount < previous) return true
  return messageCount - previous >= minGrowth
}

export function recordTriagedSession(stateDir: string, sessionId: string, messageCount: number): void {
  if (!SAFE_SESSION_ID.test(sessionId)) return
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(path.join(stateDir, sessionId), String(messageCount))
    pruneSessionState(stateDir, Date.now())
  } catch {
    /* state only saves money; a failure to write it must never break the hook */
  }
}

// `now` is a parameter so this is testable without waiting a month.
export function pruneSessionState(stateDir: string, now: number): void {
  for (const entry of fs.readdirSync(stateDir)) {
    const p = path.join(stateDir, entry)
    try {
      if (now - fs.statSync(p).mtimeMs > STATE_RETENTION_MS) fs.unlinkSync(p)
    } catch {
      /* vanished between readdir and stat, or another run won the race */
    }
  }
}
