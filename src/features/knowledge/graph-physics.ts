// One tick of the living-web force simulation (LivingWebGraph.tsx), kept out of
// the component so a test can replay a layout without a canvas.

export interface SimNode {
  id: string
  label: string
  x: number
  y: number
  vx: number
  vy: number
  project: string // grouping key: the note's project, or NO_PROJECT for unprojected
  color: string
  degree: number
  recency: number // 0..1, newest note = 1
  radius: number
  fixed: boolean // pinned while dragged
}

export interface SimEdge {
  source: string
  target: string
  weight: number
}

const REPULSION = 3000
const SPRING_LENGTH = 70
const SPRING_STRENGTH = 0.04
const CLUSTER_GRAVITY = 0.02
const CENTERING = 0.018
const DAMPING = 0.9
// Without a ceiling the first ticks explode: seeding puts a big project's notes
// ~1px apart, where 1/d² repulsion is enormous. Replayed on the real vault
// (2026-11-02, 354 notes), one node moved 4,753px on tick 1, and ~230 sat
// pinned on the canvas edge at the moment the view was looked at.
const MAX_SPEED = 10

// Repulsion sized so the settled spread fits the canvas. Centering balances
// N·k/R² at R³ = N·k/CENTERING; at a flat 3000 a 354-note vault settles at
// R≈390 against a ~300px half-height, and the clamp pins the overflow to the
// border. The target radius is 0.75 of the half-height: at 0.8 and above, a
// project seeded near an edge still grazed it while the layout spread out.
// Small vaults keep the flat 3000.
export function repulsionFor(count: number, width: number, height: number): number {
  const target = 0.75 * (Math.min(width, height) / 2)
  return Math.min(REPULSION, (CENTERING * target ** 3) / Math.max(count, 1))
}

// Advances every node one tick at strength `alpha`; returns the mean squared
// speed (the caller's "settled" signal). The caller decays alpha.
export function physicsStep(
  nodes: SimNode[],
  edges: SimEdge[],
  nodeById: Map<string, SimNode>,
  width: number,
  height: number,
  alpha: number,
): number {
  const cx = width / 2
  const cy = height / 2
  const repulsion = repulsionFor(nodes.length, width, height)
  // Project centroids for gentle same-project gravity.
  const centroids = new Map<string, { x: number; y: number; n: number }>()
  for (const n of nodes) {
    const c = centroids.get(n.project) ?? { x: 0, y: 0, n: 0 }
    c.x += n.x
    c.y += n.y
    c.n++
    centroids.set(n.project, c)
  }
  for (const [, c] of centroids) {
    c.x /= c.n
    c.y /= c.n
  }

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]
      let dx = a.x - b.x
      let dy = a.y - b.y
      let distSq = dx * dx + dy * dy
      if (distSq < 1) {
        distSq = 1
        dx = Math.cos(i * 12.9898 + j)
        dy = Math.sin(i * 78.233 + j)
      }
      const force = repulsion / distSq
      const dist = Math.sqrt(distSq)
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      a.vx += fx * alpha
      a.vy += fy * alpha
      b.vx -= fx * alpha
      b.vy -= fy * alpha
    }
  }
  for (const e of edges) {
    const a = nodeById.get(e.source)
    const b = nodeById.get(e.target)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.max(Math.hypot(dx, dy), 1)
    const force = (dist - SPRING_LENGTH) * SPRING_STRENGTH
    const fx = (dx / dist) * force
    const fy = (dy / dist) * force
    a.vx += fx * alpha
    a.vy += fy * alpha
    b.vx -= fx * alpha
    b.vy -= fy * alpha
  }
  for (const n of nodes) {
    const c = centroids.get(n.project)!
    n.vx += (c.x - n.x) * CLUSTER_GRAVITY * alpha
    n.vy += (c.y - n.y) * CLUSTER_GRAVITY * alpha
    n.vx += (cx - n.x) * CENTERING * alpha
    n.vy += (cy - n.y) * CENTERING * alpha
  }
  let energy = 0
  for (const n of nodes) {
    if (n.fixed) {
      n.vx = 0
      n.vy = 0
      continue
    }
    n.vx *= DAMPING
    n.vy *= DAMPING
    const speed = Math.hypot(n.vx, n.vy)
    if (speed > MAX_SPEED) {
      n.vx *= MAX_SPEED / speed
      n.vy *= MAX_SPEED / speed
    }
    n.x += n.vx
    n.y += n.vy
    n.x = Math.max(n.radius + 4, Math.min(width - n.radius - 4, n.x))
    n.y = Math.max(n.radius + 4, Math.min(height - n.radius - 4, n.y))
    energy += n.vx * n.vx + n.vy * n.vy
  }
  return energy / nodes.length
}
