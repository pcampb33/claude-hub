import fs from 'node:fs'
import path from 'node:path'
import { VAULT_PATH } from './vault-core.ts'
import { resolveKnownPath } from './resolve-known-path.ts'
import { parseFrontmatter, deriveProject } from './vault-project.ts'
import { listProjects } from './registry.ts'
import { mergeVaultEdges, parseLinksFile } from './vault-linker-core.ts'
import { stripRelatedBlock } from './vault-related-core.ts'
import type { VaultGraphData, VaultNote, VaultEdge } from '../shared/ipc-types'

// index.md is the vault's landing page, not a note; _inbox.md is the
// auto-curation queue (see vault-write-core.ts), not a reviewed note yet —
// both excluded so they don't pollute the graph. (_links.jsonl, the computed
// edge sidecar, is already skipped: listNoteFiles only reads *.md.)
// RUBRIC.md is the user-editable curation criteria at the vault root, not a
// knowledge note — every other vault reader excludes it (vault-linker-run,
// drain-inbox); the graph must too, or it renders a stray "RUBRIC" node.
const EXCLUDED_FILES = new Set(['index.md', '_inbox.md', 'RUBRIC.md'])

// LLM-computed weighted edges live in a sidecar next to the notes (written by
// scripts/link-vault.mjs) so the notes stay clean, Obsidian-compatible
// markdown. Absent until the first backfill runs — then the graph merges it in.
const LINKS_FILE = path.join(VAULT_PATH, '_links.jsonl')

function readComputedLinks(validIds: string[]) {
  if (!fs.existsSync(LINKS_FILE)) return []
  return parseLinksFile(fs.readFileSync(LINKS_FILE, 'utf-8'), validIds)
}

function listNoteFiles(): string[] {
  if (!fs.existsSync(VAULT_PATH)) return []
  return fs
    .readdirSync(VAULT_PATH)
    .filter((f) => f.endsWith('.md') && !EXCLUDED_FILES.has(f))
}

function noteIdFromFilename(filename: string): string {
  return filename.slice(0, -'.md'.length)
}

// First non-empty line of the body, heading markers stripped — the same shape
// readFirstLineExcerpt gives, but on the frontmatter-stripped body string so a
// `project:` block can never leak into the excerpt (the shared helper only
// reads by path and would see the raw file, frontmatter and all). Exported for
// vault-linker-run.writeMocs, which builds the same excerpts for MOC bullets.
function firstLineExcerpt(body: string): string | null {
  const firstLine = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return firstLine?.replace(/^#+\s*/, '') ?? null
}

// Same [[link]] regex vault-write-core.ts's findExistingNoteTitle uses.
// Exported for the vault-related-core tests: they assert the production
// strip+parse composition never reads a materialized block's wikilinks.
// (getVaultGraph itself is covered end-to-end in vault-graph.test.ts now that
// both roots it reads — CLAUDE_HUB_VAULT and APP_ROOT — can point at tmpdirs.)
export function parseOutgoingLinks(content: string): string[] {
  const links = new Set<string>()
  for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    links.add(match[1].trim())
  }
  return [...links]
}

export function getVaultGraph(): VaultGraphData {
  const files = listNoteFiles()
  const idByLowerTitle = new Map(files.map((f) => [noteIdFromFilename(f).toLowerCase(), noteIdFromFilename(f)]))
  const projectNames = listProjects().map((p) => p.name)

  const rawNotes = files.map((filename) => {
    const id = noteIdFromFilename(filename)
    const filePath = path.join(VAULT_PATH, filename)
    const content = fs.readFileSync(filePath, 'utf-8')
    const stat = fs.statSync(filePath)
    // Split off any `project:` frontmatter first: excerpt, links, and project
    // inference all work on the body so the block never leaks into the graph.
    const { frontmatter, body: rawBody } = parseFrontmatter(content)
    // Then drop the materialized "## Related" block (computed edges rendered
    // for Obsidian) — its wikilinks must never count as authored: authored
    // edges win merges at weight 1 and are what backlink counts are built
    // from. readVaultNote deliberately does NOT strip it — humans should see
    // the Related section in the reading pane.
    const body = stripRelatedBlock(rawBody)
    // Resolve link titles against known note ids case-insensitively; a
    // dangling link to a note that doesn't exist is dropped rather than
    // shown as a ghost node — keeps the graph clean (see design notes).
    const outgoingLinks = parseOutgoingLinks(body)
      .map((title) => idByLowerTitle.get(title.toLowerCase()))
      .filter((resolvedId): resolvedId is string => resolvedId !== undefined && resolvedId !== id)
    // Prefer the durable frontmatter tag; fall back to inferring from the body
    // for legacy notes that predate curation-time tagging.
    const project = frontmatter.project ?? deriveProject(body, projectNames) ?? null
    return {
      id,
      excerpt: firstLineExcerpt(body),
      outgoingLinks,
      mtime: stat.mtime.toISOString(),
      createdAt: stat.birthtime.toISOString(),
      project,
    }
  })

  // Authored edges: every resolved [[wikilink]], the strongest (human) signal —
  // weight 1, kind 'authored'.
  const authoredEdges: VaultEdge[] = rawNotes.flatMap((note) =>
    note.outgoingLinks.map((target) => ({ source: note.id, target, weight: 1, kind: 'authored' as const })),
  )

  const notes: VaultNote[] = rawNotes.map((note) => ({
    id: note.id,
    title: note.id,
    excerpt: note.excerpt,
    outgoingLinks: note.outgoingLinks,
    // Backlinks stay authored-only — they mean "notes that explicitly link
    // here" and drive node size; computed edges must not inflate them.
    backlinks: authoredEdges.filter((e) => e.target === note.id).map((e) => e.source),
    mtime: note.mtime,
    createdAt: note.createdAt,
    project: note.project,
  }))

  // The rendered edge web merges the authored links with the LLM-computed,
  // weighted edges from the sidecar (dropped silently when it doesn't exist).
  const edges = mergeVaultEdges(authoredEdges, readComputedLinks(files.map(noteIdFromFilename)))

  return { notes, edges }
}

export function readVaultNote(id: string): string {
  const knownIds = listNoteFiles().map(noteIdFromFilename)
  resolveKnownPath(id, knownIds, 'vault note')
  // Strip the frontmatter block so the reading pane shows the note body only,
  // never the raw `---\nproject: …\n---` metadata.
  return parseFrontmatter(fs.readFileSync(path.join(VAULT_PATH, `${id}.md`), 'utf-8')).body
}
