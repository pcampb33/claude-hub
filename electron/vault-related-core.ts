// Materialized "## Related" blocks: pure helpers that render the computed
// _links.jsonl edges into a note's markdown body as [[wikilinks]] between
// HTML-comment markers, so Obsidian (pointed at the vault) gets a real
// graph/backlinks. claude-hub's own parsers strip the block before reading a
// body (vault-graph, vault-linker-run, link-vault.mjs, drain-inbox.mjs) so a
// materialized wikilink never counts as authored — authored edges win merges
// at weight 1 and are the only thing backlink counts (node size) are built
// from, so an unstripped block would flip computed edges to authored and
// balloon the graph. Electron-free; fs/side effects live in vault-linker-run.
import type { ComputedLink, ComputedLinkKind } from './vault-linker-core.ts'

export const RELATED_BEGIN = '<!-- computed-links:begin -->'
export const RELATED_END = '<!-- computed-links:end -->'

export interface RelatedNeighbor {
  id: string
  kind: ComputedLinkKind
  weight: number
}

// Remove the marked block (plus the blank-line padding around it) wherever it
// sits; body without markers passes through unchanged. A begin marker with no
// end marker strips to end-of-body — over-stripping a corrupt block is safer
// than feeding it back to the linker model (self-feed) or the graph parser.
export function stripRelatedBlock(body: string): string {
  const begin = body.indexOf(RELATED_BEGIN)
  if (begin === -1) return body
  const endMark = body.indexOf(RELATED_END, begin)
  const end = endMark === -1 ? body.length : endMark + RELATED_END.length
  const before = body.slice(0, begin).replace(/\n+$/, '\n')
  const after = body.slice(end).replace(/^\n+/, '')
  const joined = before === '' || after === '' ? `${before}${after}` : `${before}\n${after}`
  // Defensive: collapse stray extra blocks too (upsert only ever writes one).
  return joined.includes(RELATED_BEGIN) ? stripRelatedBlock(joined) : joined
}

// A note's computed neighbors: the union of edges naming it as EITHER endpoint
// (edges are stored once per unordered pair, so one-sided reads would miss
// half the graph), deduped per neighbor keeping the strongest edge, sorted
// weight desc then id for a stable, deterministic block.
export function neighborsOf(links: ComputedLink[], id: string): RelatedNeighbor[] {
  const byNeighbor = new Map<string, RelatedNeighbor>()
  for (const link of links) {
    const neighbor = link.from === id ? link.to : link.to === id ? link.from : null
    if (neighbor === null) continue
    const existing = byNeighbor.get(neighbor)
    if (!existing || link.weight > existing.weight) {
      byNeighbor.set(neighbor, { id: neighbor, kind: link.kind, weight: link.weight })
    }
  }
  return [...byNeighbor.values()].sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// Corruption guard for the bulk materialize pass. True when re-materializing
// would strip EVERY note's Related block on the basis of an empty edge set
// while blocks are actually present — the signature of a truncated, clobbered,
// or deleted _links.jsonl (the auditor's repro). Left unguarded this is a
// permanent, silent, unbacked graph wipe: materialize strips all blocks, then
// advances the linker state so nothing re-links and the sidecar never rebuilds.
// A genuinely link-less vault carries no blocks, so the legitimate empty case
// never trips this. The caller refuses the pass; the next good linker run heals.
export function wouldWipeRelatedBlocks(edgeCount: number, noteBodies: string[]): boolean {
  return edgeCount === 0 && noteBodies.some((body) => body.includes(RELATED_BEGIN))
}

// The block text itself (no surrounding padding — upsert owns spacing).
// Null for a neighborless note: no block is better than an empty heading.
export function buildRelatedBlock(neighbors: RelatedNeighbor[]): string | null {
  if (neighbors.length === 0) return null
  const bullets = neighbors.map((n) => `- [[${n.id}]] *(${n.kind})*`)
  return [RELATED_BEGIN, '## Related', ...bullets, RELATED_END].join('\n')
}

// Replace an existing marked block in place, append at end-of-file (one blank
// line before, trailing newline after) when absent, or remove it when block is
// null. Idempotent. Callers pass full raw file content — frontmatter and every
// other byte outside the markers stay untouched (append only ever normalizes
// trailing whitespace at EOF).
export function upsertRelatedBlock(body: string, block: string | null): string {
  const begin = body.indexOf(RELATED_BEGIN)
  if (begin !== -1) {
    if (block === null) return stripRelatedBlock(body)
    const endMark = body.indexOf(RELATED_END, begin)
    const end = endMark === -1 ? body.length : endMark + RELATED_END.length
    return body.slice(0, begin) + block + body.slice(end)
  }
  if (block === null) return body
  const base = body.replace(/\s+$/, '')
  return base === '' ? `${block}\n` : `${base}\n\n${block}\n`
}
