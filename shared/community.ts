// Pure community/graph math over the vault's note graph. Lives in shared/ so
// both the renderer (Knowledge canvas) and the electron-side MOC generator
// (vault-moc-core via vault-linker-run.writeMocs) can use it — electron/ and
// scripts/ must not import from src/. Parameter types are structural minimums
// (id / source / target) so callers can pass a full VaultGraphData or a bare
// {notes, edges} alike. Rendering concerns (the cluster palette, project
// color maps) stay in src/features/knowledge/community.ts.

export interface CommunityGraph {
  notes: { id: string }[]
  edges: { source: string; target: string }[]
}

function buildAdjacency(graph: CommunityGraph): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()
  for (const n of graph.notes) adj.set(n.id, new Set())
  for (const e of graph.edges) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue
    adj.get(e.source)!.add(e.target)
    adj.get(e.target)!.add(e.source)
  }
  return adj
}

// Modularity of a partition: within-community edge density minus the density
// expected at random given the degree sequence. Standard Q = Σ_c [ e_c/m −
// (d_c/2m)² ], where e_c is edges inside community c and d_c the total degree
// there. Higher Q = crisper community structure.
function modularity(comm: Map<string, number>, adj: Map<string, Set<string>>, m: number): number {
  if (m === 0) return 0
  const twoM = 2 * m
  const members = new Map<number, string[]>()
  for (const [id, c] of comm) {
    const list = members.get(c)
    if (list) list.push(id)
    else members.set(c, [id])
  }
  let q = 0
  for (const [, group] of members) {
    const set = new Set(group)
    let internalEnds = 0 // each internal edge counted twice (once per endpoint)
    let degreeSum = 0
    for (const id of group) {
      const nbrs = adj.get(id)!
      degreeSum += nbrs.size
      for (const nb of nbrs) if (set.has(nb)) internalEnds++
    }
    q += internalEnds / twoM - (degreeSum / twoM) ** 2
  }
  return q
}

function densify(comm: Map<string, number>, graph: CommunityGraph): Map<string, number> {
  const dense = new Map<number, number>()
  const result = new Map<string, number>()
  for (const n of graph.notes) {
    const raw = comm.get(n.id)!
    if (!dense.has(raw)) dense.set(raw, dense.size)
    result.set(n.id, dense.get(raw)!)
  }
  return result
}

// Greedy modularity (agglomerative, Clauset–Newman–Moore in spirit): start
// every note in its own community, then repeatedly merge the edge-connected
// pair of communities whose merge most increases modularity, stopping when no
// merge helps. Deterministic, and unlike plain label propagation it doesn't
// collapse bridged clusters into one blob. Recomputes Q per candidate — O(n³)
// worst case, fine for a curated vault (dozens–low-hundreds of notes). Returns
// noteId → dense cluster index (0..k-1) in note order so colors stay stable.
export function detectCommunities(graph: CommunityGraph): Map<string, number> {
  const adj = buildAdjacency(graph)
  const comm = new Map<string, number>(graph.notes.map((n, i) => [n.id, i]))
  const m = graph.edges.filter((e) => adj.has(e.source) && adj.has(e.target)).length
  if (m === 0) return densify(comm, graph)

  let currentQ = modularity(comm, adj, m)
  for (;;) {
    // Only consider merging communities joined by at least one edge.
    const pairs = new Map<string, [number, number]>()
    for (const e of graph.edges) {
      const ca = comm.get(e.source)
      const cb = comm.get(e.target)
      if (ca === undefined || cb === undefined || ca === cb) continue
      const key = ca < cb ? `${ca}|${cb}` : `${cb}|${ca}`
      if (!pairs.has(key)) pairs.set(key, ca < cb ? [ca, cb] : [cb, ca])
    }
    let bestGain = 1e-9
    let bestPair: [number, number] | null = null
    for (const [, [ca, cb]] of pairs) {
      const trial = new Map(comm)
      for (const [id, c] of trial) if (c === cb) trial.set(id, ca)
      const q = modularity(trial, adj, m)
      if (q - currentQ > bestGain) {
        bestGain = q - currentQ
        bestPair = [ca, cb]
      }
    }
    if (!bestPair) break
    const [ca, cb] = bestPair
    for (const [id, c] of comm) if (c === cb) comm.set(id, ca)
    currentQ += bestGain
  }
  return densify(comm, graph)
}

// Total degree — backlinks + outgoing — drives node size (not backlinks-only
// as the old SVG graph did).
export function nodeDegree(note: { backlinks: string[]; outgoingLinks: string[] }): number {
  return note.backlinks.length + note.outgoingLinks.length
}
