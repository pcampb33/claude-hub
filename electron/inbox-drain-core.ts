import { stripCodeFence } from './curate-core.ts'

// Batch inbox drain — the automation behind "notes get into the vault without
// hand-tapping 130 review cards." The curate hook's dedup is title-exact only,
// so multi-session investigations re-queue the same finding under drifting
// titles; the inbox bloats with semantic duplicates. This module runs one
// whole-inbox LLM pass that clusters same-finding entries (semantic, not title
// match), flags entries already captured by an existing vault note, and — under
// a deterministic policy applied in code, NOT trusted to the model — decides
// which cluster representatives auto-promote to the vault vs. stay queued.
//
// Electron-free (a `*-core.ts` per project convention) so scripts/drain-inbox.mjs
// can import it under plain `node`. The LLM call and all filesystem writes live
// in that script; everything here is pure and unit-tested.

export interface DrainInboxEntry {
  index: number // stable position in the inbox, 0-based in document order
  title: string
  sessionId: string
  project: string | null
  confidence: 'high' | 'medium' | 'low' | null
  content: string
}

export interface DrainVaultNote {
  title: string
  excerpt: string // opening of the existing note, for semantic dedup vs the vault
}

// One cluster of inbox entries the model judged to be the same finding. The
// model returns ONLY structure (which entries group together, which is the
// fullest, whether it's already in the vault) — never a promote/keep verdict
// and never author-generated content. Policy and note bodies stay deterministic.
export interface DrainGroup {
  members: number[] // entry indices; every entry lands in exactly one group
  representative: number // the member whose title + body to use as canonical
  duplicatesVaultNote: string | null // title of an existing vault note this repeats, else null
}

const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 }
function rank(c: string | null): number {
  return c ? (CONFIDENCE_RANK[c] ?? 0) : 0
}

// Truncate a body for the prompt — enough to judge sameness without paying for
// full bodies × 130 entries. The full body is used verbatim at promote time.
function truncate(text: string, max: number): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

export function buildDrainPrompt(entries: DrainInboxEntry[], vaultNotes: DrainVaultNote[]): string {
  const vaultBlock = vaultNotes.length
    ? vaultNotes.map((n) => `- ${n.title}: ${truncate(n.excerpt, 400)}`).join('\n')
    : '(the vault is empty)'

  const entriesBlock = entries
    .map(
      (e) =>
        `[${e.index}] (confidence: ${e.confidence ?? 'unknown'}) ${e.title}\n${truncate(e.content, 600)}`,
    )
    .join('\n\n')

  return `You are de-duplicating a review queue of knowledge-vault candidate notes.

Each candidate below was auto-extracted at the end of a Claude Code session. The
same underlying finding is often queued MANY times across sessions under slightly
different titles. Your job is to group candidates that describe the SAME finding,
and flag any group whose finding is ALREADY fully captured by an existing vault note.

Judge sameness by MEANING, not by title wording. Two entries are the same finding
when acting on one makes the other redundant — same root cause, same fix, same
gotcha — even if the titles share no words. Do NOT merge merely related or
same-topic findings that a reader would still want as separate notes.

EXISTING VAULT NOTES (title: opening excerpt):
${vaultBlock}

CANDIDATE ENTRIES (index, confidence, title, then body excerpt):
${entriesBlock}

Return ONLY a JSON object, no prose, no code fence:
{
  "groups": [
    { "members": [<indices>], "representative": <index>, "duplicatesVaultNote": <"vault note title" or null> }
  ]
}

Rules:
- EVERY candidate index from 0 to ${entries.length - 1} must appear in EXACTLY ONE group. A unique finding is a group of one.
- "representative" must be one of that group's members — pick the entry with the most complete, self-contained body.
- Set "duplicatesVaultNote" to the exact title of an existing vault note ONLY when that note already fully covers the finding; otherwise null.
- Return the JSON and nothing else.`
}

export interface DrainParseResult {
  ok: boolean
  groups?: DrainGroup[]
  error?: string
}

// Parse + STRICTLY validate the model's plan. The validation is the integrity
// guarantee: it confirms the groups form an exact partition of [0, entryCount)
// — no entry dropped, none double-counted — so the executor can trust that
// removing every non-kept entry never loses a candidate it didn't account for.
// Any deviation returns { ok:false }, and the caller does nothing (fails safe).
export function parseDrainPlan(raw: string, entryCount: number): DrainParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(raw))
  } catch {
    return { ok: false, error: 'not valid JSON' }
  }
  // JSON.parse('null') / '42' succeed but aren't objects — reading .groups off
  // them throws. drain-inbox.mjs calls this outside a try, so an unguarded
  // throw kills the scheduled task and writes nothing to the log. Fail safe.
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'not a JSON object' }
  const groupsRaw = (parsed as { groups?: unknown }).groups
  if (!Array.isArray(groupsRaw)) return { ok: false, error: 'missing groups array' }

  const seen = new Set<number>()
  const groups: DrainGroup[] = []
  for (const g of groupsRaw) {
    const members = (g as { members?: unknown }).members
    const representative = (g as { representative?: unknown }).representative
    const dup = (g as { duplicatesVaultNote?: unknown }).duplicatesVaultNote
    if (!Array.isArray(members) || members.length === 0) return { ok: false, error: 'group has no members' }
    for (const m of members) {
      if (!Number.isInteger(m) || m < 0 || m >= entryCount) return { ok: false, error: `member out of range: ${m}` }
      if (seen.has(m)) return { ok: false, error: `member in two groups: ${m}` }
      seen.add(m)
    }
    if (!members.includes(representative)) return { ok: false, error: 'representative not a member' }
    if (dup !== null && typeof dup !== 'string') return { ok: false, error: 'duplicatesVaultNote must be a string or null' }
    groups.push({
      members: members as number[],
      representative: representative as number,
      duplicatesVaultNote: dup === null ? null : (dup as string),
    })
  }
  if (seen.size !== entryCount) return { ok: false, error: `partition incomplete: ${seen.size}/${entryCount} entries covered` }
  return { ok: true, groups }
}

export interface EntryKey {
  title: string
  sessionId: string
}

// The concrete plan the executor runs. Keyed by (title, sessionId) — the pair
// removeInboxEntry matches on — never by index, since removals shift positions.
export interface DrainPlan {
  promote: EntryKey[] // representative → write to vault, then remove from inbox
  drop: EntryKey[] // already-in-vault entries + merged-away siblings → remove, do NOT vault
  keep: EntryKey[] // representatives that stay queued (below the auto-promote bar)
}

// Turn the model's clusters into actions under a fixed policy. The model never
// decides promote-vs-keep; this does, deterministically:
//   - group already covered by a vault note  → drop ALL members (nothing to add)
//   - else the group collapses to its representative; siblings are dropped, and
//     the representative promotes iff the cluster's STRONGEST confidence clears
//     the bar (default 'high'), otherwise it stays queued for the human gate.
// Confidence is taken from the entries themselves (max over members), not from
// the model — the curator's tag is the source of truth, the model only clusters.
export function planDrain(
  entries: DrainInboxEntry[],
  groups: DrainGroup[],
  promoteAtOrAbove: 'high' | 'medium' | 'low' = 'high',
  vaultNotes: DrainVaultNote[] = [],
): DrainPlan {
  const byIndex = new Map(entries.map((e) => [e.index, e]))
  const key = (i: number): EntryKey => {
    const e = byIndex.get(i)!
    return { title: e.title, sessionId: e.sessionId }
  }
  const bar = rank(promoteAtOrAbove)
  // Only honor a "already covered by an existing vault note" claim when the
  // named title actually exists. The model over-tags duplicates and can name a
  // note that isn't there; an unchecked claim dropped EVERY member of the
  // cluster from _inbox.md and never vaulted them — silent data loss that ran
  // even in the scheduled --dedup-only mode. An unmatched claim falls through
  // to the normal promote/keep-the-representative path instead.
  const knownTitles = new Set(vaultNotes.map((n) => n.title.toLowerCase().trim()))
  const plan: DrainPlan = { promote: [], drop: [], keep: [] }

  for (const g of groups) {
    if (g.duplicatesVaultNote !== null && knownTitles.has(g.duplicatesVaultNote.toLowerCase().trim())) {
      for (const m of g.members) plan.drop.push(key(m))
      continue
    }
    for (const m of g.members) if (m !== g.representative) plan.drop.push(key(m))
    const groupConfidence = Math.max(...g.members.map((m) => rank(byIndex.get(m)!.confidence)))
    if (groupConfidence >= bar) plan.promote.push(key(g.representative))
    else plan.keep.push(key(g.representative))
  }
  return plan
}
