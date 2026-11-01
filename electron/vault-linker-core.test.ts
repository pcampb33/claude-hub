import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLinkPrompt,
  buildIncrementalLinkPrompt,
  parseLinkOutput,
  parseIncrementalLinkOutput,
  replaceNoteLinks,
  parseLinksFile,
  mergeVaultEdges,
} from './vault-linker-core.ts'
import type { VaultEdge } from '../shared/ipc-types.ts'

const IDS = ['alpha', 'beta', 'gamma']

test('buildLinkPrompt embeds every note id + content and asks for the edges JSON', () => {
  const prompt = buildLinkPrompt([
    { id: 'alpha', content: 'first note body' },
    { id: 'beta', content: 'second note body' },
  ])
  assert.ok(prompt.includes('### alpha'))
  assert.ok(prompt.includes('first note body'))
  assert.ok(prompt.includes('### beta'))
  assert.ok(/do NOT force density/i.test(prompt)) // anti-density instruction present
  assert.ok(prompt.includes('{"edges":'))
})

test('buildIncrementalLinkPrompt embeds the note, the index lines, and the endpoint rule', () => {
  const prompt = buildIncrementalLinkPrompt({ id: 'alpha', content: 'fresh note body' }, [
    { id: 'beta', excerpt: 'second note gist' },
    { id: 'gamma', excerpt: 'third note gist' },
  ])
  assert.ok(prompt.includes('fresh note body'))
  assert.ok(prompt.includes('- beta: second note gist'))
  assert.ok(prompt.includes('- gamma: third note gist'))
  assert.ok(prompt.includes('"alpha" as one endpoint'))
  assert.ok(/do NOT force density/i.test(prompt))
  assert.ok(prompt.includes('{"edges":'))
})

test('parseIncrementalLinkOutput drops edges that do not touch the linked note', () => {
  const raw =
    '{"edges": [{"from": "alpha", "to": "beta", "weight": 0.7, "kind": "causal"},' +
    ' {"from": "beta", "to": "gamma", "weight": 0.9, "kind": "see-also"}]}'
  const edges = parseIncrementalLinkOutput(raw, 'alpha', IDS)
  assert.deepEqual(edges, [{ from: 'alpha', to: 'beta', weight: 0.7, kind: 'causal' }])
})

test('replaceNoteLinks swaps a note\'s edges, keeps everyone else\'s, drops garbage', () => {
  const sidecar =
    '{"from":"alpha","to":"beta","weight":0.5,"kind":"see-also"}\n' +
    '{"from":"beta","to":"gamma","weight":0.9,"kind":"causal"}\n' +
    'not json\n'
  const next = replaceNoteLinks(sidecar, 'alpha', [{ from: 'alpha', to: 'gamma', weight: 0.6, kind: 'see-also' }])
  const lines = next.trim().split('\n')
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes('"from":"beta"')) // untouched edge survives
  assert.ok(lines[1].includes('"to":"gamma"') && lines[1].includes('"from":"alpha"'))
})

test('replaceNoteLinks is idempotent — relinking the same note twice yields one edge set', () => {
  const fresh = [{ from: 'alpha', to: 'beta', weight: 0.4, kind: 'see-also' as const }]
  const once = replaceNoteLinks('', 'alpha', fresh)
  const twice = replaceNoteLinks(once, 'alpha', fresh)
  assert.equal(once, twice)
})

test('replaceNoteLinks with no fresh edges empties a lone note\'s links', () => {
  const sidecar = '{"from":"alpha","to":"beta","weight":0.5,"kind":"see-also"}\n'
  assert.equal(replaceNoteLinks(sidecar, 'alpha', []), '')
})

test('parseLinkOutput keeps valid edges and reads weight + kind', () => {
  const edges = parseLinkOutput(
    '{"edges": [{"from": "alpha", "to": "beta", "weight": 0.8, "kind": "causal"}]}',
    IDS,
  )
  assert.deepEqual(edges, [{ from: 'alpha', to: 'beta', weight: 0.8, kind: 'causal' }])
})

test('parseLinkOutput strips a ```json fence (observed model behavior)', () => {
  const edges = parseLinkOutput(
    '```json\n{"edges": [{"from": "alpha", "to": "gamma", "weight": 0.5, "kind": "see-also"}]}\n```',
    IDS,
  )
  assert.equal(edges.length, 1)
  assert.equal(edges[0].kind, 'see-also')
})

test('parseLinkOutput drops edges to unknown ids and self-loops', () => {
  const edges = parseLinkOutput(
    '{"edges": [{"from": "alpha", "to": "unknown", "weight": 0.9, "kind": "causal"}, {"from": "beta", "to": "beta", "weight": 0.9, "kind": "causal"}]}',
    IDS,
  )
  assert.deepEqual(edges, [])
})

test('parseLinkOutput clamps weight to [0,1] and defaults an unknown kind to see-also', () => {
  const edges = parseLinkOutput(
    '{"edges": [{"from": "alpha", "to": "beta", "weight": 1.7, "kind": "bogus"}]}',
    IDS,
  )
  assert.deepEqual(edges, [{ from: 'alpha', to: 'beta', weight: 1, kind: 'see-also' }])
})

test('parseLinkOutput dedups the same pair to the max-weight edge regardless of direction', () => {
  const edges = parseLinkOutput(
    '{"edges": [{"from": "alpha", "to": "beta", "weight": 0.3, "kind": "see-also"}, {"from": "beta", "to": "alpha", "weight": 0.7, "kind": "causal"}]}',
    IDS,
  )
  assert.deepEqual(edges, [{ from: 'beta', to: 'alpha', weight: 0.7, kind: 'causal' }])
})

test('parseLinkOutput returns [] for non-JSON and for JSON without an edges array', () => {
  assert.deepEqual(parseLinkOutput('sorry, no edges', IDS), [])
  assert.deepEqual(parseLinkOutput('{"notes": []}', IDS), [])
  assert.deepEqual(parseLinkOutput('', IDS), [])
})

test('parseLinksFile reads one JSON edge per line and skips blank/garbled lines', () => {
  const jsonl = [
    '{"from": "alpha", "to": "beta", "weight": 0.6, "kind": "generalization"}',
    '',
    'not json',
    '{"from": "beta", "to": "gamma", "weight": 0.4, "kind": "see-also"}',
  ].join('\n')
  const edges = parseLinksFile(jsonl, IDS)
  assert.equal(edges.length, 2)
  assert.ok(edges.some((e) => e.from === 'alpha' && e.to === 'beta'))
})

test('parseLinksFile drops edges whose ids no longer exist in the vault', () => {
  const jsonl = '{"from": "alpha", "to": "deleted-note", "weight": 0.9, "kind": "causal"}'
  assert.deepEqual(parseLinksFile(jsonl, IDS), [])
})

test('mergeVaultEdges: an authored link beats a computed edge on the same pair', () => {
  const authored: VaultEdge[] = [{ source: 'alpha', target: 'beta', weight: 1, kind: 'authored' }]
  const merged = mergeVaultEdges(authored, [{ from: 'beta', to: 'alpha', weight: 0.9, kind: 'causal' }])
  assert.deepEqual(merged, [{ source: 'alpha', target: 'beta', weight: 1, kind: 'authored' }])
})

test('mergeVaultEdges: a computed-only pair passes through as its own edge', () => {
  const merged = mergeVaultEdges([], [{ from: 'alpha', to: 'gamma', weight: 0.5, kind: 'see-also' }])
  assert.deepEqual(merged, [{ source: 'alpha', target: 'gamma', weight: 0.5, kind: 'see-also' }])
})

test('mergeVaultEdges: between two computed edges on a pair, the stronger wins', () => {
  const merged = mergeVaultEdges(
    [],
    [
      { from: 'alpha', to: 'beta', weight: 0.3, kind: 'see-also' },
      { from: 'alpha', to: 'beta', weight: 0.8, kind: 'causal' },
    ],
  )
  assert.deepEqual(merged, [{ source: 'alpha', target: 'beta', weight: 0.8, kind: 'causal' }])
})
