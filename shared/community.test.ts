import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectCommunities, nodeDegree } from './community.ts'
import type { CommunityGraph } from './community.ts'

function graph(ids: string[], pairs: Array<[string, string]>): CommunityGraph {
  return {
    notes: ids.map((id) => ({ id })),
    edges: pairs.map(([source, target]) => ({ source, target })),
  }
}

test('detectCommunities separates two bridged triangles into two clusters', () => {
  // {a,b,c} triangle and {d,e,f} triangle joined by a single bridge c-d.
  const g = graph(
    ['a', 'b', 'c', 'd', 'e', 'f'],
    [
      ['a', 'b'],
      ['b', 'c'],
      ['a', 'c'],
      ['d', 'e'],
      ['e', 'f'],
      ['d', 'f'],
      ['c', 'd'],
    ],
  )
  const c = detectCommunities(g)
  assert.equal(c.get('a'), c.get('b'))
  assert.equal(c.get('b'), c.get('c'))
  assert.equal(c.get('d'), c.get('e'))
  assert.equal(c.get('e'), c.get('f'))
  assert.notEqual(c.get('a'), c.get('d'))
})

test('detectCommunities gives an isolated node its own cluster and dense indices from 0', () => {
  const g = graph(['x', 'y', 'lonely'], [['x', 'y']])
  const c = detectCommunities(g)
  assert.equal(c.get('x'), c.get('y'))
  assert.notEqual(c.get('x'), c.get('lonely'))
  // Indices are dense (0..k-1), assigned in note order → x's cluster is 0.
  assert.equal(c.get('x'), 0)
  assert.equal(c.get('lonely'), 1)
})

test('nodeDegree is total degree: backlinks + outgoing', () => {
  assert.equal(nodeDegree({ outgoingLinks: ['a', 'b'], backlinks: ['c'] }), 3)
  assert.equal(nodeDegree({ outgoingLinks: [], backlinks: [] }), 0)
})
