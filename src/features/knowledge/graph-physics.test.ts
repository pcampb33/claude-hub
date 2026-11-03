import test from 'node:test'
import assert from 'node:assert/strict'
import { physicsStep, repulsionFor, type SimEdge, type SimNode } from './graph-physics.ts'

// A vault shaped like the real one on 2026-11-02 (354 notes, ~900 links, one
// project holding 132), seeded the way LivingWebGraph's derive() seeds it:
// each project's notes on a radius-34 circle around its point on a ring.
const W = 897
const H = 608
const SIZES = [132, 42, 31, 27, 21, 10, 10, 9, 8, 8, 5, 4, 4, 4, 2, 2, 35]

function vault(): { nodes: SimNode[]; edges: SimEdge[] } {
  const nodes: SimNode[] = []
  const ring = Math.min(W, H) * 0.32
  let i = 0
  SIZES.forEach((size, b) => {
    const angle = (b / SIZES.length) * Math.PI * 2
    for (let k = 0; k < size; k++, i++) {
      nodes.push({
        id: `n${i}`,
        label: '',
        x: W / 2 + Math.cos(angle) * ring + Math.cos(i * 2.4) * 34,
        y: H / 2 + Math.sin(angle) * ring + Math.sin(i * 2.4) * 34,
        vx: 0,
        vy: 0,
        project: `p${b}`,
        color: '',
        degree: 0,
        recency: 0,
        radius: 5,
        fixed: false,
      })
    }
  })
  // Deterministic links, mostly within a project.
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const edges: SimEdge[] = []
  while (edges.length < 900) {
    const a = nodes[Math.floor(rand() * nodes.length)]
    const pool = rand() < 0.8 ? nodes.filter((n) => n.project === a.project) : nodes
    const b = pool[Math.floor(rand() * pool.length)]
    if (a !== b) edges.push({ source: a.id, target: b.id, weight: 1 })
  }
  return { nodes, edges }
}

const onBorder = (n: SimNode) => n.x <= n.radius + 4.5 || n.x >= W - n.radius - 4.5 || n.y <= n.radius + 4.5 || n.y >= H - n.radius - 4.5

test('a vault-sized layout never pins notes to the canvas border, from the first tick to settled', () => {
  const { nodes, edges } = vault()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  let alpha = 0.7 // ALPHA_WAKE
  let worst = 0
  let tick = 0
  for (; alpha >= 0.008; tick++) {
    physicsStep(nodes, edges, byId, W, H, alpha)
    alpha *= 0.985
    worst = Math.max(worst, nodes.filter(onBorder).length)
  }
  assert.ok(tick > 200, 'the replay ran to the settle threshold')
  assert.equal(worst, 0, `at worst ${worst} notes sat on the border`)
})

test('repulsion shrinks with a big vault and keeps the flat 3000 for a small one', () => {
  assert.equal(repulsionFor(20, W, H), 3000)
  assert.ok(repulsionFor(354, W, H) < 1000)
})
