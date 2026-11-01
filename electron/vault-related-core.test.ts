import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RELATED_BEGIN,
  RELATED_END,
  stripRelatedBlock,
  neighborsOf,
  buildRelatedBlock,
  upsertRelatedBlock,
  wouldWipeRelatedBlocks,
} from './vault-related-core.ts'
import { parseOutgoingLinks } from './vault-graph.ts'
import type { ComputedLink } from './vault-linker-core.ts'

const BLOCK = buildRelatedBlock([
  { id: 'beta', kind: 'causal', weight: 0.8 },
  { id: 'gamma', kind: 'see-also', weight: 0.4 },
])!

test('buildRelatedBlock renders markers, heading, and one kind-annotated bullet per neighbor', () => {
  assert.equal(
    BLOCK,
    `${RELATED_BEGIN}\n## Related\n- [[beta]] *(causal)*\n- [[gamma]] *(see-also)*\n${RELATED_END}`,
  )
})

test('buildRelatedBlock returns null for a neighborless note', () => {
  assert.equal(buildRelatedBlock([]), null)
})

test('upsert appends with one blank line + trailing newline, and strip round-trips it', () => {
  const body = '# Title\n\nprose line\n'
  const withBlock = upsertRelatedBlock(body, BLOCK)
  assert.equal(withBlock, `# Title\n\nprose line\n\n${BLOCK}\n`)
  assert.equal(stripRelatedBlock(withBlock), body)
})

test('upsert is idempotent — applying the same block twice equals once', () => {
  const once = upsertRelatedBlock('# Title\n\nprose\n', BLOCK)
  assert.equal(upsertRelatedBlock(once, BLOCK), once)
})

test('upsert replaces an existing block in place, leaving text on both sides untouched', () => {
  const midFile = `intro\n\n${BLOCK}\n\noutro\n`
  const fresh = buildRelatedBlock([{ id: 'delta', kind: 'generalization', weight: 0.9 }])!
  assert.equal(upsertRelatedBlock(midFile, fresh), `intro\n\n${fresh}\n\noutro\n`)
})

test('upsert with null removes an existing block and is a no-op without one', () => {
  const body = '# Title\n\nprose\n'
  assert.equal(upsertRelatedBlock(upsertRelatedBlock(body, BLOCK), null), body)
  assert.equal(upsertRelatedBlock(body, null), body)
})

test('upsert onto an empty body yields just the block', () => {
  assert.equal(upsertRelatedBlock('', BLOCK), `${BLOCK}\n`)
})

test('upsert never touches frontmatter — callers pass full raw file content', () => {
  const raw = `---\nproject: claude-hub\n---\n\n# Title\n\nprose\n`
  const withBlock = upsertRelatedBlock(raw, BLOCK)
  assert.ok(withBlock.startsWith('---\nproject: claude-hub\n---\n\n# Title\n'))
  assert.equal(stripRelatedBlock(withBlock), raw)
})

test('stripRelatedBlock is a no-op on a body without markers', () => {
  const body = '# Title\n\nprose with [[an authored link]]\n'
  assert.equal(stripRelatedBlock(body), body)
})

test('stripRelatedBlock removes a mid-body block and its blank-line padding', () => {
  assert.equal(stripRelatedBlock(`intro\n\n${BLOCK}\n\noutro\n`), 'intro\n\noutro\n')
})

// The load-bearing regression: getVaultGraph composes exactly
// parseOutgoingLinks(stripRelatedBlock(body)) — a materialized block's
// wikilinks must never register as authored edges (they'd win merges at
// weight 1 and inflate backlink counts), while authored links are unchanged.
test('materialized wikilinks are invisible to the authored-link parse; authored links survive', () => {
  const body = `# Title\n\nSee [[Authored Target]] for context.\n`
  const withBlock = upsertRelatedBlock(body, BLOCK)
  assert.deepEqual(parseOutgoingLinks(stripRelatedBlock(withBlock)), ['Authored Target'])
  assert.deepEqual(parseOutgoingLinks(stripRelatedBlock(body)), ['Authored Target'])
  // Without the strip the computed neighbors WOULD leak in — the guard matters.
  assert.deepEqual(parseOutgoingLinks(withBlock), ['Authored Target', 'beta', 'gamma'])
})

// Direction-asymmetric pairing bugs hide behind one-sided fixtures (see the
// vault note of that name) — every neighborsOf case exercises BOTH endpoints.
test('neighborsOf unions both directions: each endpoint of an edge sees the other', () => {
  const links: ComputedLink[] = [{ from: 'alpha', to: 'beta', weight: 0.7, kind: 'causal' }]
  assert.deepEqual(neighborsOf(links, 'alpha'), [{ id: 'beta', kind: 'causal', weight: 0.7 }])
  assert.deepEqual(neighborsOf(links, 'beta'), [{ id: 'alpha', kind: 'causal', weight: 0.7 }])
  assert.deepEqual(neighborsOf(links, 'gamma'), [])
})

test('neighborsOf dedupes a neighbor listed in both directions, keeping the max weight', () => {
  const links: ComputedLink[] = [
    { from: 'alpha', to: 'beta', weight: 0.3, kind: 'see-also' },
    { from: 'beta', to: 'alpha', weight: 0.8, kind: 'causal' },
  ]
  assert.deepEqual(neighborsOf(links, 'alpha'), [{ id: 'beta', kind: 'causal', weight: 0.8 }])
  assert.deepEqual(neighborsOf(links, 'beta'), [{ id: 'alpha', kind: 'causal', weight: 0.8 }])
})

test('neighborsOf sorts by weight desc, then id for a stable tie-break', () => {
  const links: ComputedLink[] = [
    { from: 'alpha', to: 'zeta', weight: 0.5, kind: 'see-also' },
    { from: 'beta', to: 'alpha', weight: 0.5, kind: 'see-also' },
    { from: 'alpha', to: 'gamma', weight: 0.9, kind: 'causal' },
  ]
  assert.deepEqual(
    neighborsOf(links, 'alpha').map((n) => n.id),
    ['gamma', 'beta', 'zeta'],
  )
})

// The corruption guard that turns a permanent, silent graph wipe into a heal-
// able no-op. Fires only when an empty edge set meets present blocks.
test('wouldWipeRelatedBlocks fires when 0 edges meet notes that still carry blocks', () => {
  const bodies = ['# a\n\nbody', `# b\n\n${BLOCK}\n`]
  assert.equal(wouldWipeRelatedBlocks(0, bodies), true)
})

test('wouldWipeRelatedBlocks stays quiet on a genuinely link-less vault (0 edges, no blocks)', () => {
  assert.equal(wouldWipeRelatedBlocks(0, ['# a\n\nbody', '# b\n\nother']), false)
})

test('wouldWipeRelatedBlocks stays quiet whenever real edges exist, blocks or not', () => {
  assert.equal(wouldWipeRelatedBlocks(3, [`# b\n\n${BLOCK}\n`]), false)
  assert.equal(wouldWipeRelatedBlocks(1, ['# a\n\nbody']), false)
})

test('wouldWipeRelatedBlocks handles an empty corpus', () => {
  assert.equal(wouldWipeRelatedBlocks(0, []), false)
})
