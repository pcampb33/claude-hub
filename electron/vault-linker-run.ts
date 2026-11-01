// Incremental vault-linker runner: the async, side-effecting layer over
// vault-linker-core's pure logic. Links one note (or every stale note)
// against the corpus index with a per-note sonnet call and rewrites the
// _links.jsonl sidecar. Electron-free — the same module serves ipc-handlers
// and scripts/link-vault.mjs --incremental.
import fs from 'node:fs'
import path from 'node:path'
import { VAULT_PATH } from './vault-core.ts'
import { parseFrontmatter } from './vault-project.ts'
import { callClaudeAsync } from './call-claude-core.ts'
import { stripCodeFence } from './curate-core.ts'
import { buildIncrementalLinkPrompt, parseIncrementalLinkOutput, parseLinksFile, replaceNoteLinks } from './vault-linker-core.ts'
import { stripRelatedBlock, neighborsOf, buildRelatedBlock, upsertRelatedBlock, wouldWipeRelatedBlocks } from './vault-related-core.ts'
import { buildTopicMoc, buildOriginMoc, mocExcerpt } from './vault-moc-core.ts'
import { detectCommunities } from '../shared/community.ts'
import type { RecomputeLinksResult } from '../shared/ipc-types.ts'

const LINKS_PATH = path.join(VAULT_PATH, '_links.jsonl')
// mtime-per-note map so a recompute only re-links changed/new notes (the
// floor-core ledger / skill-usage cache pattern). Dotfile: invisible to the
// graph's *.md scan.
const STATE_PATH = path.join(VAULT_PATH, '.link-vault-state.json')
// Same non-note exclusions as vault-graph.ts / link-vault.mjs.
const EXCLUDED = new Set(['index.md', '_inbox.md', 'RUBRIC.md'])
const EXCERPT_CHARS = 240
const LINK_MODEL = 'sonnet'

interface NoteFile {
  id: string
  file: string
  mtimeMs: number
  body: string
}

function readNoteFiles(): NoteFile[] {
  return fs
    .readdirSync(VAULT_PATH)
    .filter((f) => f.endsWith('.md') && !EXCLUDED.has(f))
    .map((f) => {
      const file = path.join(VAULT_PATH, f)
      return {
        id: f.slice(0, -'.md'.length),
        file,
        mtimeMs: fs.statSync(file).mtimeMs,
        // Strip the materialized "## Related" block before the body reaches a
        // link prompt — otherwise the model reads its own prior output.
        body: stripRelatedBlock(parseFrontmatter(fs.readFileSync(file, 'utf-8')).body).trim(),
      }
    })
}

function readState(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as Record<string, number>
  } catch {
    return {}
  }
}

// All linker work in this process funnels through one promise chain — a
// background post-approve link and a user-triggered recompute must never
// interleave their read-modify-write of the sidecar. (The desktop app and the
// daily link-vault job are separate processes and could still race each
// other; that window is accepted rather than locked around.)
let chain: Promise<unknown> = Promise.resolve()
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = chain.then(job)
  chain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

// The one model call linkOne makes, taken as a parameter so tests can drive a
// sweep without spawning claude. Structural rather than `typeof
// callClaudeAsync`: a fake only has to answer with text.
type LinkModelCall = (model: string, prompt: string) => Promise<{ text: string }>

// Did the model answer with an edge list at all? parseIncrementalLinkOutput
// returns [] both for "the model proposed no edges" and for "the reply wasn't
// JSON", and this path must never act on the second as if it were the first.
// The shape check duplicates the parser's own JSON.parse; its durable home is
// a parse-failure signal out of parseIncrementalLinkOutput itself.
function isEdgeReply(raw: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(raw))
  } catch {
    return false
  }
  return !!parsed && typeof parsed === 'object' && Array.isArray((parsed as { edges?: unknown }).edges)
}

// Outcome of linking one note. An unparseable reply is its own state, not a
// count of zero edges — the caller must be able to tell "the model said none"
// from "nobody found out", and only the first is a result worth recording.
type LinkOutcome = { parsed: true; edges: number } | { parsed: false }

async function linkOne(note: NoteFile, all: NoteFile[], call: LinkModelCall): Promise<LinkOutcome> {
  const index = all
    .filter((n) => n.id !== note.id)
    .map((n) => ({ id: n.id, excerpt: n.body.slice(0, EXCERPT_CHARS).replace(/\s+/g, ' ') }))
  const raw = (await call(LINK_MODEL, buildIncrementalLinkPrompt({ id: note.id, content: note.body }, index))).text
  // Writing an unparseable reply through would delete every edge touching this
  // note (replaceNoteLinks keeps only everyone else's) and then record the note
  // as done, so nothing would ever rebuild them — and the vault is not under
  // version control. Refuse the write AND the state advance, so the next run
  // retries. Same refusal the whole-corpus backfill makes in link-vault.mjs.
  if (!isEdgeReply(raw)) {
    console.error(`[vault-linker] unparseable reply for "${note.id}" — keeping its edges and leaving it due for the next run`)
    return { parsed: false }
  }
  const edges = parseIncrementalLinkOutput(
    raw,
    note.id,
    all.map((n) => n.id),
  )
  const sidecar = fs.existsSync(LINKS_PATH) ? fs.readFileSync(LINKS_PATH, 'utf-8') : ''
  fs.writeFileSync(LINKS_PATH, replaceNoteLinks(sidecar, note.id, edges))
  const state = readState()
  state[note.id] = note.mtimeMs
  fs.writeFileSync(STATE_PATH, JSON.stringify(state))
  return { parsed: true, edges: edges.length }
}

// Rewrite every note's materialized "## Related" block from the current
// sidecar edge set (writes a file only when its content actually changes).
// Shared by the linker runs below and scripts/materialize-links.mjs. State
// invariants — checked against the PRE-write mtime, written AFTER the body
// upserts: a note that was in sync (or just linked, so its state entry equals
// its on-disk mtime) gets its entry advanced to the post-write mtime so our
// own rewrite doesn't read as a user edit next run; an already-dirty note's
// entry is left alone so it stays due for a re-link. (fs.utimes can't
// round-trip mtimeMs floats on Windows, hence fixing state, not mtime.)
export function materializeRelatedBlocks(): { touched: number; skipped: number; edges: number; aborted?: string } {
  const files = fs
    .readdirSync(VAULT_PATH)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && !EXCLUDED.has(f))
  const ids = files.map((f) => f.slice(0, -'.md'.length))
  const sidecarRaw = fs.existsSync(LINKS_PATH) ? fs.readFileSync(LINKS_PATH, 'utf-8') : ''
  const links = parseLinksFile(sidecarRaw, ids)
  // Read each note once — shared by the corruption guard and the upsert loop.
  const notes = files.map((f) => {
    const file = path.join(VAULT_PATH, f)
    return { id: f.slice(0, -'.md'.length), file, raw: fs.readFileSync(file, 'utf-8') }
  })
  // Refuse to strip every block on the basis of an empty edge set while blocks
  // are present — a corrupt/truncated/clobbered sidecar would otherwise wipe
  // the whole graph permanently (see wouldWipeRelatedBlocks). Report the
  // parse gap so the failure is loud, not silent, and skip the write.
  if (wouldWipeRelatedBlocks(links.length, notes.map((n) => n.raw))) {
    const rawLines = sidecarRaw.split('\n').filter((l) => l.trim()).length
    const aborted = `refusing to materialize: _links.jsonl has ${rawLines} non-empty line(s) but 0 usable edges while notes still carry Related blocks — likely a truncated/clobbered sidecar. Skipping the strip; the next good linker run heals it.`
    console.error(`[vault-linker] ${aborted}`)
    return { touched: 0, skipped: notes.length, edges: 0, aborted }
  }
  const state = readState()
  let touched = 0
  let skipped = 0
  let edges = 0
  let stateChanged = false
  for (const { id, file, raw } of notes) {
    const neighbors = neighborsOf(links, id)
    const next = upsertRelatedBlock(raw, buildRelatedBlock(neighbors))
    if (next === raw) {
      skipped++
      continue
    }
    const wasInSync = state[id] === fs.statSync(file).mtimeMs
    fs.writeFileSync(file, next)
    touched++
    edges += neighbors.length
    if (wasInSync) {
      state[id] = fs.statSync(file).mtimeMs
      stateChanged = true
    }
  }
  if (stateChanged) fs.writeFileSync(STATE_PATH, JSON.stringify(state))
  return { touched, skipped, edges }
}

export interface MocFileStatus {
  name: string
  changed: boolean
  content: string
}

// Regenerate the two Map-of-Content pages from the current top-level notes +
// sidecar edges, writing into the MOCs/ subfolder only when content changed.
// The subfolder is load-bearing: every hub vault reader (vault-graph's
// listNoteFiles, readNoteFiles above, drain-inbox's readVaultNotes) scans
// top-level *.md only, so the generated pages are invisible to the graph, the
// linker, and drain — but Obsidian resolves their wikilinks across folders.
// No linker-state interaction: STATE_PATH is keyed by top-level note ids, and
// MOC files are never in that scan, so these writes can't read as note edits.
// dryRun builds and diffs but writes nothing (scripts/materialize-links.mjs).
export function writeMocs(dryRun = false): MocFileStatus[] {
  const files = fs
    .readdirSync(VAULT_PATH)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && !EXCLUDED.has(f))
  const notes = files.map((f) => {
    const { frontmatter, body } = parseFrontmatter(fs.readFileSync(path.join(VAULT_PATH, f), 'utf-8'))
    return {
      id: f.slice(0, -'.md'.length),
      // Strip the materialized Related block before excerpting so a computed
      // wikilink bullet never leaks into a MOC bullet.
      excerpt: mocExcerpt(stripRelatedBlock(body), f.slice(0, -'.md'.length)),
      project: frontmatter.project ?? null,
    }
  })
  const links = fs.existsSync(LINKS_PATH)
    ? parseLinksFile(
        fs.readFileSync(LINKS_PATH, 'utf-8'),
        notes.map((n) => n.id),
      )
    : []
  const edges = links.map((l) => ({ source: l.from, target: l.to }))
  const results: MocFileStatus[] = [
    { name: 'Map of Content.md', changed: false, content: buildTopicMoc(notes, edges, detectCommunities({ notes, edges })) },
    { name: 'By origin.md', changed: false, content: buildOriginMoc(notes) },
  ]
  const mocDir = path.join(VAULT_PATH, 'MOCs')
  for (const r of results) {
    const file = path.join(mocDir, r.name)
    r.changed = !fs.existsSync(file) || fs.readFileSync(file, 'utf-8') !== r.content
    if (r.changed && !dryRun) {
      fs.mkdirSync(mocDir, { recursive: true })
      fs.writeFileSync(file, r.content)
    }
  }
  return results
}

function countSidecarEdges(): number {
  if (!fs.existsSync(LINKS_PATH)) return 0
  return fs
    .readFileSync(LINKS_PATH, 'utf-8')
    .split('\n')
    .filter((l) => l.trim()).length
}

// Link every note whose mtime differs from the recorded state (new notes
// included). Serial on purpose: one in-flight claude call, one sidecar writer.
export function recomputeLinks(): Promise<RecomputeLinksResult> {
  return recomputeLinksWith(callClaudeAsync)
}

// The sweep with its model call injected — exported for tests only.
// recomputeLinks() above keeps a zero-arg signature because it is registered
// straight onto the IPC/HTTP surface (hub-service.ts), where a parameter would
// be filled from the request body.
export function recomputeLinksWith(call: LinkModelCall): Promise<RecomputeLinksResult> {
  return enqueue(async () => {
    const all = readNoteFiles()
    let state = readState()
    // First run after the whole-corpus backfill: no state yet, but the
    // sidecar exists. Adopt current mtimes for every note the backfill
    // mentions rather than re-linking the world — only notes absent from the
    // sidecar (added since, or zero-edge) get a call. Zero-edge notes are
    // indistinguishable from never-linked ones, so they cost one re-link
    // here; after that the state file remembers them.
    if (Object.keys(state).length === 0 && fs.existsSync(LINKS_PATH)) {
      const mentioned = new Set<string>()
      for (const line of fs.readFileSync(LINKS_PATH, 'utf-8').split('\n')) {
        try {
          const e = JSON.parse(line) as { from?: string; to?: string }
          if (typeof e.from === 'string') mentioned.add(e.from)
          if (typeof e.to === 'string') mentioned.add(e.to)
        } catch {
          continue
        }
      }
      state = Object.fromEntries(all.filter((n) => mentioned.has(n.id)).map((n) => [n.id, n.mtimeMs]))
      fs.writeFileSync(STATE_PATH, JSON.stringify(state))
    }
    const pending = all.filter((n) => state[n.id] !== n.mtimeMs)
    let linked = 0
    let unparsed = 0
    for (const note of pending) {
      if ((await linkOne(note, all, call)).parsed) linked++
      else unparsed++
    }
    // Refresh the materialized Related blocks even when nothing was re-linked
    // (a fresh edge touches BOTH endpoints' blocks, and a no-op sweep is the
    // self-heal path after a note deletion or a hand-mangled block) — it only
    // writes files whose content actually changed. Then the MOC pages, which
    // are derived from the same edge set.
    // A corrupt-sidecar abort also means the MOC pages would rebuild from a
    // degenerate edge set — skip them too and let the next good run heal both.
    if (!materializeRelatedBlocks().aborted) writeMocs()
    // linkedNotes counts notes actually linked, not notes attempted. Say what
    // was skipped instead of letting the count quietly shrink — 3 of 5 with no
    // explanation is a smaller version of a claim nobody verified.
    const result: RecomputeLinksResult = { ok: true, linkedNotes: linked, edgeCount: countSidecarEdges() }
    if (unparsed > 0)
      result.message = `${unparsed} note(s) skipped: the model reply did not parse. Their links are untouched and they stay due for the next run.`
    return result
  }).catch((err: unknown) => ({
    ok: false,
    linkedNotes: 0,
    edgeCount: countSidecarEdges(),
    message: err instanceof Error ? err.message : String(err),
  }))
}

// Fire-and-forget hook for the vault-write paths (inbox approve, quick
// capture): link the just-written note without blocking the caller. Failures
// log and stay silent — the daily --incremental sweep is the catch-all.
export function linkNoteInBackground(notePath: string): void {
  const id = path.basename(notePath).replace(/\.md$/, '')
  void enqueue(async () => {
    const all = readNoteFiles()
    const note = all.find((n) => n.id === id)
    if (!note) return
    const outcome = await linkOne(note, all, callClaudeAsync)
    if (!materializeRelatedBlocks().aborted) writeMocs()
    // linkOne logs the unparseable case itself; don't claim a link that the
    // sidecar never received.
    if (outcome.parsed) console.log(`[vault-linker] linked "${id}" — ${outcome.edges} edge(s)`)
  }).catch((err: unknown) => console.error(`[vault-linker] background link of "${id}" failed:`, err))
}
