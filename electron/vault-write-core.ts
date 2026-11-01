import fs from 'node:fs'
import path from 'node:path'
import { matchesNoteName, vaultNoteNameFor } from '../shared/vault-note-name.ts'
import { commitVault } from './vault-git.ts'
import { VAULT_PATH } from './vault-core.ts'
// Imported, never redeclared: a structurally identical local copy compiled
// fine and would have silently dropped any field added to the shared one —
// the same drift-between-twins shape this round spent a slice fixing.
export type { VaultWriteResult } from '../shared/ipc-types.ts'
import type { VaultWriteResult } from '../shared/ipc-types.ts'


export interface QueueCandidate {
  title: string
  content: string
  justification: string // one-line, quoting the SAVE criterion + the specific transcript moment
  sessionId: string
  projectName?: string // derived from the hook's transcript_path, if resolvable
  confidence?: 'high' | 'medium' | 'low' // curator's strength-of-recommendation, shown on the review card
}

const INDEX_PATH = path.join(VAULT_PATH, 'index.md')
const INBOX_PATH = path.join(VAULT_PATH, '_inbox.md')

// Resolve a note's on-disk path, or null if `noteName` would land anywhere but
// directly in the vault root. writeVaultNote only ever writes top-level notes,
// but `noteName` can also be derived from a caller-supplied title: a `../secret`
// traversal would escape the vault entirely, and a folder-qualified
// `MOCs/Map of Content` would clobber a generated MOC page. Requiring
// dirname === vault root rejects both.
//
// Kept as a check even though writeVaultNote now runs every derived name
// through vaultNoteNameFor() first, which strips `\` and `/` and so cannot
// produce either shape: this function is also reachable with a name that never
// went through the sanitiser (a [[wikilink]] stem read back out of index.md),
// and a containment guard that only holds when its caller already sanitised is
// not a guard.
//
// vaultPath is injectable for tests only; production callers use the default.
export function resolveVaultNotePath(noteName: string, vaultPath: string = VAULT_PATH): string | null {
  const notePath = path.resolve(vaultPath, `${noteName}.md`)
  return path.dirname(notePath) === path.resolve(vaultPath) ? notePath : null
}

// Small title-match "dedup" — a curated, small vault doesn't need
// embeddings for this. Real merge/similarity logic can grow here later
// without changing the CLI surface that calls it.
//
// Matched against the notes on disk, NOT against index.md. index.md is
// append-only bookkeeping that only this module maintains, so it drifts from
// the vault whenever a note arrives another way — hand-authored, edited in
// Obsidian, or written straight to the file by an agent. Measured 2026-08-17:
// 13 of 202 notes had no index line and 1 index line named a deleted note, and
// both directions broke this dedup. An unindexed note was invisible, so a
// re-capture wrote a duplicate file instead of appending; a ghost line matched
// a file that no longer existed, so the append created a note with no heading
// and no frontmatter. The directory is the ground truth every other vault
// reader (graph, linker, MOC) already scans.
//
// The comparison goes through matchesNoteName, NOT a raw string compare,
// because `noteNames` are filename stems and a title is not a filename. This
// used to compare the raw title against the already-sanitised stems while
// writeVaultNote sanitised before writing, so the two halves disagreed for any
// title containing one of `\ / : * ? " < > |`: the match could never succeed,
// the writer took its "this note is new" branch, and fs.writeFileSync
// TRUNCATED the note it should have appended to. Measured 2026-08-22: 64 of 205
// notes in the live vault (31%) carry an H1 that can never match its own file,
// and the daily unattended promote writes through this path. Both halves now
// call the same module (shared/vault-note-name.ts) — do not reintroduce a
// second copy of the regex here, the duplication WAS the defect.
//
// Known limitation, quiet not loud: title drift still silently fragments
// notes. "Vite Extension Resolution" vs. an existing "Vite import extension
// quirks" won't match, so it creates a near-duplicate instead of appending —
// no error, no signal, just a slightly worse vault over time. Acceptable given
// the human-in-the-loop design (the user reviews the inbox and can merge
// manually), but worth knowing this isn't silent-safe.
export function matchExistingTitle(title: string, noteNames: string[]): string | null {
  return noteNames.find((name) => matchesNoteName(title, name)) ?? null
}

// Mirrors the exclusion set the linker and graph scanners use, so "what counts
// as a note" doesn't fork a third time.
const NON_NOTE_FILES = new Set(['index.md', '_inbox.md', 'RUBRIC.md'])

// Exported because the curate and recall hooks need the same list: both used to
// read index.md, which made them blind to the notes it was missing — recall in
// particular could never offer one, while its own hit-rate experiment was being
// measured against it.
// vaultPath is injectable for tests only; production callers use the default.
export function listVaultNoteNames(vaultPath: string = VAULT_PATH): string[] {
  if (!fs.existsSync(vaultPath)) return []
  return fs
    .readdirSync(vaultPath)
    .filter((file) => file.endsWith('.md') && !NON_NOTE_FILES.has(file))
    .map((file) => file.slice(0, -'.md'.length))
}

function appendIndexEntryIfNew(noteName: string, indexPath: string = INDEX_PATH): void {
  const indexLine = `- [[${noteName}]]\n`
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, `# Knowledge Vault Index\n\n${indexLine}`)
    return
  }
  // Checked against the index itself rather than trusting an "is this note
  // new?" flag: an already-existing note may still be one of the unindexed
  // ones above, and appending to it is the chance to heal its missing line
  // instead of skipping it forever.
  const normalized = noteName.toLowerCase().trim()
  const listed = fs
    .readFileSync(indexPath, 'utf-8')
    .split('\n')
    .some((line) => line.match(/\[\[([^\]]+)\]\]/)?.[1].toLowerCase().trim() === normalized)
  if (!listed) fs.appendFileSync(indexPath, indexLine)
}

// Direct write — for explicit, human-driven "put this in the vault now"
// actions (e.g. a manual promote of a LEARNINGS.md entry). NOT used by the
// auto-curation Stop hook, which queues candidates instead (see
// queueVaultCandidate below) — the council's resolution was that nothing
// auto-commits to the vault without a human reviewing it first.
//
// vaultPath is injectable for tests only; production callers use the default.
export function writeVaultNote(
  title: string,
  content: string,
  project?: string,
  vaultPath: string = VAULT_PATH,
): VaultWriteResult {
  if (!fs.existsSync(vaultPath)) fs.mkdirSync(vaultPath, { recursive: true })

  const existing = matchExistingTitle(title, listVaultNoteNames(vaultPath))
  // Both halves of the title→filename mapping come from shared/vault-note-name.ts.
  // They used not to — this line inlined the sanitising regex while the match
  // above compared the raw title — and the disagreement silently truncated
  // notes (see matchExistingTitle). Deriving the name from the same function
  // that the match uses is what makes the append branch below reachable.
  const noteName = existing ?? vaultNoteNameFor(title)
  const notePath = resolveVaultNotePath(noteName, vaultPath)
  if (!notePath) {
    return { ok: false, message: `refusing to write outside the vault root: "${noteName}"` }
  }

  if (existing) {
    // Appending a fresh contribution — never touch the existing note's own
    // frontmatter; the project tag belongs to the note as a whole, set once.
    fs.appendFileSync(notePath, `\n\n---\n\n${content}\n`)
  } else {
    // New note: persist the originating project as `project:` frontmatter so the
    // graph can group by it durably, without re-inferring from text every read.
    const front = project && project.trim() ? `---\nproject: ${project.trim()}\n---\n\n` : ''
    fs.writeFileSync(notePath, `${front}# ${title}\n\n${content}\n`)
  }
  appendIndexEntryIfNew(noteName, path.join(vaultPath, 'index.md'))

  // Commit here because this is where the vault's only unattended writer lands
  // (drain-inbox's nightly auto-promote calls straight through). The vault repo
  // held one baseline commit and nothing has ever committed since, so until now
  // a bad write at 12:00 was simply gone. `git revert` is the recovery path for
  // exactly the bug this function just stopped having.
  //
  // A commit outcome never flips `ok`: the note IS written, and failing the
  // caller over a bookkeeping step would send an inbox approve back to the
  // queue for a note already in the vault. But `failed` must not vanish either
  // — it means the safety net is not holding — so it travels as a typed field
  // a caller can branch on, with prose in `message` only for display.
  const commit = commitVault(vaultPath, `${existing ? 'append' : 'add'}: ${noteName}`)
  const message =
    commit.kind === 'committed'
      ? `committed ${commit.sha}`
      : commit.kind === 'failed'
        ? `note written, but the vault commit FAILED: ${commit.message}`
        : commit.kind

  return { ok: true, notePath, message, commit }
}

// The Stop hook fires at every turn end, not once per session, so a
// multi-turn session re-offers its finding each turn (observed 2026-07-01:
// identical candidate queued twice, 2 minutes apart). Same exact-title
// matching rule as findExistingNoteTitle — quiet on title drift, acceptable
// because a human reviews the inbox anyway.
//
// A '## ' line only counts as a queued entry title when the line two below
// is the metadata line queueVaultCandidate writes (starts with '_', names
// the session) — candidate bodies are unsanitized markdown, so an H2 inside
// a queued body must not block a genuinely new candidate with that title.
export function hasQueuedTitle(inboxText: string, title: string): boolean {
  const normalized = title.toLowerCase().trim()
  const lines = inboxText.split('\n')
  return lines.some(
    (line, i) =>
      line.startsWith('## ') &&
      line.slice(3).toLowerCase().trim() === normalized &&
      (lines[i + 2] ?? '').startsWith('_') &&
      (lines[i + 2] ?? '').includes(' — session '),
  )
}

// Queue outcome carries a typed discriminant instead of overloading the
// free-form `message` field — the hook branches on this machine-checked
// flag, and prose belongs in prose fields.
export interface QueueResult {
  ok: boolean
  notePath: string
  skippedDuplicate?: boolean
}

// Collapse newlines/whitespace runs to single spaces. The entry format is
// strictly one '## title' line and one '_…session…_' metadata line, detected
// by parseInbox/removeInboxEntry via exact line matching. A model-authored
// title or justification carrying a '\n' would split those lines, so the entry
// matched nothing on read — invisible in the Inbox view, un-drainable, and
// unremovable, accumulating in _inbox.md forever and corrupting the offset-
// based parse of everything after it. Sanitize the header/metadata fields
// (content stays free-form; it sits after the metadata line and is reviewed).
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

// The auto-curation Stop hook calls this, never writeVaultNote() directly.
// Appends to a single running inbox file the user reviews and promotes
// from by hand — over-capture costs one keystroke to reject, under-capture
// is visible because every candidate's reasoning is logged, not silent.
// inboxPath is injectable for tests only; production callers use the default.
export function queueVaultCandidate(candidate: QueueCandidate, inboxPath: string = INBOX_PATH): QueueResult {
  if (!fs.existsSync(VAULT_PATH)) fs.mkdirSync(VAULT_PATH, { recursive: true })
  const existingInbox = fs.existsSync(inboxPath) ? fs.readFileSync(inboxPath, 'utf-8') : ''
  const title = oneLine(candidate.title)
  // Dedup against the sanitized title so a re-queued newline-title still matches.
  if (hasQueuedTitle(existingInbox, title)) {
    return { ok: true, notePath: inboxPath, skippedDuplicate: true }
  }
  const timestamp = new Date().toISOString()
  const projectLabel = candidate.projectName ? ` — ${oneLine(candidate.projectName)}` : ''
  // Confidence sits as its own ` — {level} — ` segment between the session id
  // and the justification, so parseInbox can split it off without disturbing
  // the older no-confidence format (which parses with confidence = null).
  const confidenceTag = candidate.confidence ? `${candidate.confidence} — ` : ''
  const entry = `\n## ${title}\n\n_${timestamp}${projectLabel} — session ${candidate.sessionId} — ${confidenceTag}${oneLine(candidate.justification)}_\n\n${candidate.content}\n`
  fs.appendFileSync(inboxPath, entry)
  return { ok: true, notePath: inboxPath }
}

export interface RemoveResult {
  text: string // the inbox text with the entry's block removed
  content: string | null // the removed entry's content body, for promotion; null if not found
}

// Removes one queued entry (matched by title + sessionId, the keys a parsed
// VaultInboxEntry carries) and returns the new inbox text plus the removed
// entry's content body. Uses the same '## ' + metadata-at-i+2 entry-detection
// rule as parseInbox/hasQueuedTitle, so an H2 inside a body is never mistaken
// for an entry boundary. content is null (and text unchanged) if no match.
export function removeInboxEntry(inboxText: string, title: string, sessionId: string): RemoveResult {
  const lines = inboxText.split('\n')
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const meta = lines[i + 2] ?? ''
    if (lines[i].startsWith('## ') && meta.startsWith('_') && meta.includes(' — session ')) starts.push(i)
  }
  const normTitle = title.toLowerCase().trim()
  const targetIdx = starts.findIndex(
    (s) =>
      lines[s].slice(3).toLowerCase().trim() === normTitle &&
      (lines[s + 2] ?? '').includes(` — session ${sessionId} `),
  )
  if (targetIdx === -1) return { text: inboxText, content: null }

  const start = starts[targetIdx]
  const end = targetIdx + 1 < starts.length ? starts[targetIdx + 1] : lines.length
  // Body is everything after the metadata line (start+2) to the next entry.
  const content = lines.slice(start + 3, end).join('\n').trim()
  const remaining = [...lines.slice(0, start), ...lines.slice(end)]
  return { text: remaining.join('\n'), content: content || null }
}
