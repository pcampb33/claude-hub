import { useEffect, useMemo, useRef, useState } from 'react'
import type { VaultGraphData, VaultNote } from '../../../shared/ipc-types'
import { nodeDegree } from '../../../shared/community'
import { useTheme } from '../shared/theme'
import { isLightColor, parseColor, projectColorMap, tintCluster } from './community'
import { displayNoteTitle } from './note-title'
import { physicsStep, type SimEdge, type SimNode } from './graph-physics'

// The "living web": a continuous Canvas force-simulation of the vault. Alive at
// rest (gentle drift + particles flowing along the links), legible on focus
// (clicking a note freezes motion and dims everything but its own threads —
// crucially, NOTHING repositions, so the shape you were reading stays put). The
// sim sleeps its expensive physics once the layout settles and stops entirely
// when the tab is backgrounded or reduced-motion is on, to keep idle CPU down.

interface Derived {
  nodes: SimNode[]
  edges: SimEdge[]
}

const ALPHA_DECAY = 0.985
const ALPHA_SLEEP = 0.008 // below this the layout is "settled" — stop physics
const ALPHA_WAKE = 0.7

// How many nodes keep a label when nothing is hovered or focused. Enough to
// orient by, few enough that the labels don't become the texture.
const RESTING_LABEL_COUNT = 12

// Unprojected notes stay a muted neutral so the eye reads the real, multi-note
// projects as the colored structure — not a rainbow of one-off dots.
// A sentinel, resolved to the theme's --text-faint at draw time.
const NEUTRAL_NODE = 'neutral'

// Synthetic bucket for notes with no derivable project, so seeding and the
// same-bucket gravity can treat "unprojected" as a group without null checks.
const NO_PROJECT = '__none__'

// Theme tokens the canvas paints with, read from <html> (canvas can't use var()).
interface Ink {
  light: boolean
  text: string
  textSecondary: string
  faint: string
  surface: string
  accent: string
}

function readInk(): Ink {
  const cs = getComputedStyle(document.documentElement)
  const t = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  return {
    light: isLightColor(cs.getPropertyValue('--bg-base')),
    text: t('--text-primary', '#eceff4'),
    textSecondary: t('--text-secondary', '#d8dee9'),
    faint: t('--text-faint', '#97a2b5'),
    surface: t('--bg-surface', '#3b4252'),
    accent: t('--accent', '#88c0d0'),
  }
}

// Token colour at an alpha; a value we can't parse is used as-is.
function tokenAlpha(css: string, alpha: number): string {
  const c = parseColor(css)
  return c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})` : css
}

// Palette hex → rgba for the cluster auras, which need the project color at a
// low, fading alpha (canvas gradients want an rgba/rgb string, not bare hex).
function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Build the simulation model from the graph. Positions seed grouped (each
// project around its own arc of a ring) so the first frame is already legible
// and the sim only has to refine, never explode from a blob.
function derive(graph: VaultGraphData, width: number, height: number): Derived {
  const colorMap = projectColorMap(graph.notes.map((n) => n.project))

  // Bucket = the note's project, or NO_PROJECT. Sorted distinct buckets give
  // each project its own arc of the seed ring, deterministically.
  const bucketOf = (n: VaultNote): string => n.project ?? NO_PROJECT
  const buckets = [...new Set(graph.notes.map(bucketOf))].sort()
  const bucketIndex = new Map(buckets.map((b, i) => [b, i]))
  const bucketCount = Math.max(1, buckets.length)

  // Birth time, not mtime — the nightly linker rewrites `## Related` blocks and
  // would otherwise light up months-old notes as new.
  const times = graph.notes.map((n) => new Date(n.createdAt).getTime()).filter((t) => !Number.isNaN(t))
  const minT = times.length ? Math.min(...times) : 0
  const maxT = times.length ? Math.max(...times) : 1
  const span = Math.max(maxT - minT, 1)

  const cx = width / 2
  const cy = height / 2
  const ring = Math.min(width, height) * 0.32
  const perBucket = new Map<string, number>()

  const nodes: SimNode[] = graph.notes.map((n, i) => {
    const project = bucketOf(n)
    const degree = nodeDegree(n)
    const t = new Date(n.createdAt).getTime()
    const recency = Number.isNaN(t) ? 0 : (t - minT) / span
    // Seed: project centroid on a ring, node jittered around it deterministically.
    const bucketAngle = ((bucketIndex.get(project) ?? 0) / bucketCount) * Math.PI * 2
    const within = perBucket.get(project) ?? 0
    perBucket.set(project, within + 1)
    const jitter = 34
    return {
      id: n.id,
      label: displayNoteTitle(n.title || n.id),
      x: cx + Math.cos(bucketAngle) * ring + Math.cos(i * 2.4) * jitter,
      y: cy + Math.sin(bucketAngle) * ring + Math.sin(i * 2.4) * jitter,
      vx: 0,
      vy: 0,
      project,
      color: n.project ? (colorMap.get(n.project) ?? NEUTRAL_NODE) : NEUTRAL_NODE,
      degree,
      recency,
      radius: 5 + Math.sqrt(degree) * 3.2,
      fixed: false,
    }
  })

  // weight is the note's connection strength (0–1): authored [[wikilinks]] = 1,
  // LLM-computed edges carry their own. It drives edge thickness/opacity below.
  const edges = graph.edges.map((e) => ({
    source: e.source,
    target: e.target,
    weight: e.weight,
  }))

  return { nodes, edges }
}

interface LivingWebGraphProps {
  graph: VaultGraphData
  selectedNoteId: string | null
  onSelect: (id: string) => void
  focusProject: string | null
  // External hover (Browse rows): highlights a node + neighbors exactly like
  // an on-canvas hover. null = no external highlight.
  highlightNoteId: string | null
  // As-you-type search lens: matching node ids stay lit, everything else
  // dims. null = no active search (empty query).
  searchMatches: Set<string> | null
}

export function LivingWebGraph({
  graph,
  selectedNoteId,
  onSelect,
  focusProject,
  highlightNoteId,
  searchMatches,
}: LivingWebGraphProps) {
  const [theme] = useTheme()
  const inkRef = useRef<Ink | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 640, height: 520 })
  const reducedMotion = useMemo(
    () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  // Stable identity of the graph's shape — rebuild the sim only when it changes,
  // not when a note is selected.
  const layoutKey =
    graph.notes.map((n) => n.id).join(',') + '|' + graph.edges.map((e) => `${e.source}-${e.target}`).join(',')

  // Live-read refs so the animation loop sees the latest interaction state
  // without being torn down and restarted on every selection/hover change.
  const selectedRef = useRef(selectedNoteId)
  selectedRef.current = selectedNoteId
  const focusProjectRef = useRef(focusProject)
  focusProjectRef.current = focusProject
  const hoverRef = useRef<string | null>(null)
  const dragRef = useRef<{ id: string; moved: boolean; startX: number; startY: number } | null>(null)
  const simRef = useRef<Derived | null>(null)
  const layoutKeyRef = useRef<string>('')
  const wakeRef = useRef(false)
  const adjRef = useRef<Map<string, Set<string>>>(new Map())
  // External interaction state (Browse hover, search lens) rides refs like the
  // rest, plus a stored draw() so calm mode — which runs no animation loop —
  // still repaints when they change.
  const externalHoverRef = useRef<string | null>(null)
  const searchRef = useRef<Set<string> | null>(null)
  const drawRef = useRef<(() => void) | null>(null)
  // Re-read the tokens when the theme flips and repaint (calm mode has no loop).
  useEffect(() => {
    inkRef.current = readInk()
    drawRef.current?.()
  }, [theme])
  useEffect(() => {
    externalHoverRef.current = highlightNoteId
    drawRef.current?.()
  }, [highlightNoteId])
  useEffect(() => {
    searchRef.current = searchMatches
    drawRef.current?.()
  }, [searchMatches])

  // Track container size (canvas fills the pane, responsive).
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setSize({ width: Math.round(r.width), height: Math.round(r.height) })
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { width, height } = size
    // Phone-size canvases get the reduced-motion treatment: at this density a
    // continuous simulation + ambient particle drift reads as chaos rather
    // than life, and touch has no hover to make the motion meaningful. Settle
    // synchronously, hold still (spatial constancy), stay tappable.
    const calm = reducedMotion || Math.min(width, height) < 480
    const dpr = Math.min(typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1, 2)
    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`

    // Rebuild the sim when the graph SHAPE changes (layoutKey = ids + edges),
    // re-laying-out for the genuinely new structure. A size-only change keeps
    // existing positions so a resize doesn't re-explode the layout. (Keying off
    // node count alone would miss same-count edits — an added edge or a swapped
    // note — leaving the canvas showing stale structure.)
    if (!simRef.current || layoutKeyRef.current !== layoutKey) {
      simRef.current = derive(graph, width, height)
      layoutKeyRef.current = layoutKey
    }
    const sim = simRef.current
    const nodeById = new Map(sim.nodes.map((n) => [n.id, n]))
    const adj = new Map<string, Set<string>>()
    for (const n of sim.nodes) adj.set(n.id, new Set())
    for (const e of sim.edges) {
      adj.get(e.source)?.add(e.target)
      adj.get(e.target)?.add(e.source)
    }
    adjRef.current = adj

    // At rest a 200-note vault is 200 identical dots: label the busiest few so
    // the map has landmarks to navigate by. Ranked by drawn threads, not by
    // SimNode.degree — degree counts only authored [[wikilinks]], which almost
    // no note has, so the old `degree >= 3` rule labelled two nodes out of 200.
    const restingLabels = new Set(
      [...sim.nodes]
        .sort((a, b) => (adj.get(b.id)?.size ?? 0) - (adj.get(a.id)?.size ?? 0))
        .slice(0, RESTING_LABEL_COUNT)
        .map((n) => n.id),
    )

    let alpha = ALPHA_WAKE
    let time = 0
    let raf = 0
    let stopped = false
    let frameCount = 0

    const toSim = (evt: MouseEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect()
      return { x: evt.clientX - rect.left, y: evt.clientY - rect.top }
    }
    // Coarse pointers (touch) get a much fatter hit ring — a fingertip can't
    // land on an 11px node in a dense cluster; nearest-within-ring still
    // disambiguates neighbors.
    const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
    const hitSlop = coarse ? 16 : 6
    const hitFloor = coarse ? 22 : 12
    const hitTest = (x: number, y: number): SimNode | null => {
      let best: SimNode | null = null
      let bestD = Infinity
      for (const n of sim.nodes) {
        const d = (n.x - x) ** 2 + (n.y - y) ** 2
        const r = Math.max(n.radius + hitSlop, hitFloor)
        if (d <= r * r && d < bestD) {
          bestD = d
          best = n
        }
      }
      return best
    }

    const physics = () => {
      const energy = physicsStep(sim.nodes, sim.edges, nodeById, width, height, alpha)
      alpha *= ALPHA_DECAY
      return energy
    }

    const draw = () => {
      const ink = inkRef.current ?? readInk()
      const nodeColor = (n: SimNode) => (n.color === NEUTRAL_NODE ? ink.faint : tintCluster(n.color, ink.light))
      ctx.save()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)

      // Cluster auras: a soft radial glow behind each multi-note project, drawn
      // first so edges and nodes sit on top. Ambient depth that makes each
      // project read as a place, not a scatter — subtle, never neon.
      const auraBuckets = new Map<string, SimNode[]>()
      for (const n of sim.nodes) {
        if (n.project === NO_PROJECT) continue // the unprojected grab-bag isn't a place
        const list = auraBuckets.get(n.project)
        if (list) list.push(n)
        else auraBuckets.set(n.project, [n])
      }
      for (const [, group] of auraBuckets) {
        if (group.length < 2) continue
        let gx = 0
        let gy = 0
        for (const n of group) {
          gx += n.x
          gy += n.y
        }
        gx /= group.length
        gy /= group.length
        let maxD = 0
        for (const n of group) maxD = Math.max(maxD, Math.hypot(n.x - gx, n.y - gy))
        // Concentrate the glow near the core so a broad cluster still reads as
        // a place instead of an invisibly-diffuse wash (a bright center that
        // falls off fast beats a uniform faint circle over a large radius).
        const radius = maxD + 55
        const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, radius)
        grad.addColorStop(0, withAlpha(nodeColor(group[0]), 0.2))
        grad.addColorStop(0.5, withAlpha(nodeColor(group[0]), 0.07))
        grad.addColorStop(1, withAlpha(nodeColor(group[0]), 0))
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(gx, gy, radius, 0, Math.PI * 2)
        ctx.fill()
      }

      const focusId = selectedRef.current
      const focusProj = focusProjectRef.current
      // A Browse-row hover is the same lens as an on-canvas hover.
      const hoverId = hoverRef.current ?? externalHoverRef.current
      const searchSet = searchRef.current
      const focusNeighbors = focusId ? (adj.get(focusId) ?? new Set<string>()) : null
      const hoverNeighbors = hoverId ? (adj.get(hoverId) ?? new Set<string>()) : null

      // Search is the top lens (typing is the freshest intent), then note
      // focus, then cluster focus, then hover.
      const nodeActive = (id: string, project: string): boolean => {
        if (searchSet) return searchSet.has(id)
        if (focusId) return id === focusId || (focusNeighbors?.has(id) ?? false)
        if (focusProj !== null) return project === focusProj
        if (hoverId) return id === hoverId || (hoverNeighbors?.has(id) ?? false)
        return true
      }
      const anyFocus = focusId !== null || focusProj !== null || searchSet !== null

      // Edges.
      for (const e of sim.edges) {
        const a = nodeById.get(e.source)
        const b = nodeById.get(e.target)
        if (!a || !b) continue
        const lit =
          !searchSet &&
          ((focusId && (e.source === focusId || e.target === focusId)) ||
            (focusProj !== null && a.project === focusProj && b.project === focusProj) ||
            (hoverId && (e.source === hoverId || e.target === hoverId)))
        // Under the search lens an edge stays at base styling only when both
        // endpoints match; nothing glows — the lens lights nodes, not threads.
        const dim = searchSet ? !(searchSet.has(e.source) && searchSet.has(e.target)) : anyFocus && !lit
        // weight is 0–1: a near-zero edge stays a faint thread, a weight-1
        // (authored / strongly-connected) edge reads clearly thicker + brighter.
        const base = 0.06 + e.weight * 0.24
        ctx.strokeStyle = tokenAlpha(ink.textSecondary, dim ? 0.03 : lit ? 0.5 : base)
        ctx.lineWidth = (lit ? 1.6 : 0.7) + e.weight * 1.2
        if (lit) {
          ctx.shadowColor = nodeColor(a)
          ctx.shadowBlur = 8
        }
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
        ctx.shadowBlur = 0

        // Particles flowing along the edge (source → target). At rest a couple
        // drift on every edge; on focus they swarm the lit threads.
        if (!calm) {
          const count = lit ? 4 : dim ? 0 : 2
          const speed = lit ? 0.35 : 0.12
          for (let p = 0; p < count; p++) {
            const t = ((time * speed + p / count + (e.source.length % 7) * 0.11) % 1 + 1) % 1
            const px = a.x + (b.x - a.x) * t
            const py = a.y + (b.y - a.y) * t
            ctx.fillStyle = lit
              ? tokenAlpha(ink.text, 0.9 - Math.abs(t - 0.5))
              : tokenAlpha(ink.textSecondary, 0.25)
            ctx.beginPath()
            ctx.arc(px, py, lit ? 1.8 : 1.1, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      }

      // Names are collected here and painted in one pass AFTER every node —
      // drawn inline they were cropped by whichever circle happened to be
      // drawn later ("Sa[nd]box Workflow"), which made the graph's only
      // identity encoding unreadable.
      const labels: { node: SimNode; prominent: boolean }[] = []

      // Nodes.
      for (const n of sim.nodes) {
        const active = nodeActive(n.id, n.project)
        const color = nodeColor(n)
        const isFocus = n.id === focusId
        const isHover = n.id === hoverId
        ctx.globalAlpha = active ? 1 : 0.16

        // Recency ring — newer notes get a fuller, slightly brighter arc. Kept
        // faint so it reads as a subtle freshness cue, not a selection halo.
        if (n.recency > 0.06) {
          ctx.beginPath()
          ctx.arc(n.x, n.y, n.radius + 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * n.recency)
          ctx.strokeStyle = tokenAlpha(ink.textSecondary, 0.05 + n.recency * 0.16)
          ctx.lineWidth = 1.1
          ctx.stroke()
        }

        // Node body.
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2)
        ctx.fillStyle = color
        if (isFocus || isHover) {
          ctx.shadowColor = color
          ctx.shadowBlur = 16
        }
        ctx.fill()
        ctx.shadowBlur = 0
        if (isFocus) {
          ctx.strokeStyle = ink.accent
          ctx.lineWidth = 2
          ctx.stroke()
        }

        // Label — queued, not drawn: see the label pass below.
        const showLabel = active && (anyFocus || isHover || restingLabels.has(n.id) || sim.nodes.length <= 40)
        if (showLabel) labels.push({ node: n, prominent: isFocus || isHover })
        ctx.globalAlpha = 1
      }

      // Labels, on top of every mark and never on top of each other. Most
      // important first (focus/hover, then best-connected), and a name that
      // would land on one already written is simply dropped — at 200 nodes one
      // missing name costs far less than two mutually illegible ones, and
      // hovering still names anything this pass skipped.
      labels.sort(
        (a, b) =>
          Number(b.prominent) - Number(a.prominent) ||
          (adj.get(b.node.id)?.size ?? 0) - (adj.get(a.node.id)?.size ?? 0),
      )
      ctx.textAlign = 'center'
      const placed: { x0: number; y0: number; x1: number; y1: number }[] = []
      for (const { node: n, prominent } of labels) {
        const fontSize = prominent ? 12 : 11
        ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`
        const text = n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label
        const w = ctx.measureText(text).width
        // Above the mark it names (below only if the top edge would clip it),
        // and nudged inside the canvas so an edge node's name isn't half-cut.
        const lx = Math.min(Math.max(n.x, w / 2 + 6), width - w / 2 - 6)
        const above = n.y - n.radius - 8
        const baseline = above - fontSize < 4 ? n.y + n.radius + fontSize + 5 : above
        const box = { x0: lx - w / 2 - 5, y0: baseline - fontSize, x1: lx + w / 2 + 5, y1: baseline + 4 }
        if (placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) continue
        placed.push(box)
        // Knockout plate. A stroke halo alone still left pale 11px text sitting
        // in pale threads over a bright node fill; the plate is what makes the
        // name survive the web underneath it.
        ctx.fillStyle = tokenAlpha(ink.surface, 0.92)
        ctx.beginPath()
        ctx.roundRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, 4)
        ctx.fill()
        ctx.fillStyle = prominent ? ink.text : ink.textSecondary
        ctx.fillText(text, lx, baseline)
      }
      ctx.restore()
    }

    // Expose draw so the external-hover/search effects can repaint on demand
    // (calm mode runs no loop; the animated loop halves its idle rate).
    drawRef.current = draw

    const settled = () => alpha < ALPHA_SLEEP

    const frame = () => {
      if (stopped) return
      frameCount++
      // An interaction (e.g. releasing a focus) asked the layout to breathe
      // again — re-warm alpha so the nudge it queued actually integrates.
      if (wakeRef.current) {
        alpha = Math.max(alpha, 0.22)
        wakeRef.current = false
      }
      // Physics only while unsettled AND not frozen on a focused note — focus
      // must freeze the layout in place (the whole point: nothing repositions).
      const frozen = selectedRef.current !== null
      // Once settled with no interaction, halve the redraw rate — the ambient
      // particle flow stays alive but idle CPU drops (the spec's L concern).
      const idle = settled() && !frozen && !dragRef.current && hoverRef.current === null
      if (idle && frameCount % 2 === 0) {
        raf = requestAnimationFrame(frame)
        return
      }
      if (!calm && !frozen && !settled()) physics()
      if (!calm) time += 0.016
      draw()
      raf = requestAnimationFrame(frame)
    }

    // Interaction.
    const onMove = (evt: MouseEvent) => {
      const { x, y } = toSim(evt)
      const drag = dragRef.current
      if (drag) {
        const n = nodeById.get(drag.id)
        if (n) {
          // Below a small threshold it's still a click, not a drag — don't move
          // the node (and let onUp fire onSelect). Sub-pixel jitter on a normal
          // click must not be classified as a drag.
          if (!drag.moved && Math.hypot(x - drag.startX, y - drag.startY) < 4) return
          drag.moved = true
          n.x = x
          n.y = y
          n.vx = 0
          n.vy = 0
          // No animation loop in calm mode — repaint the drag directly.
          if (calm) draw()
        }
        return
      }
      const hit = hitTest(x, y)
      const id = hit?.id ?? null
      if (id !== hoverRef.current) {
        hoverRef.current = id
        canvas.style.cursor = id ? 'pointer' : 'default'
        if (calm) draw()
      }
    }
    const onDown = (evt: MouseEvent) => {
      const { x, y } = toSim(evt)
      const hit = hitTest(x, y)
      if (hit) {
        hit.fixed = true
        dragRef.current = { id: hit.id, moved: false, startX: x, startY: y }
      }
    }
    const onUp = () => {
      const drag = dragRef.current
      if (drag) {
        const n = nodeById.get(drag.id)
        if (n) n.fixed = false
        // A press without meaningful movement is a click → focus the note.
        if (!drag.moved) onSelect(drag.id)
        dragRef.current = null
      }
    }
    const onLeave = () => {
      if (hoverRef.current) {
        hoverRef.current = null
        if (calm) draw()
      }
    }
    const onVisibility = () => {
      if (document.hidden) {
        stopped = true
        cancelAnimationFrame(raf)
      } else if (stopped) {
        stopped = false
        // Calm mode never runs a loop — just repaint the static frame.
        if (calm) {
          draw()
          return
        }
        alpha = Math.max(alpha, ALPHA_SLEEP * 2)
        raf = requestAnimationFrame(frame)
      }
    }

    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mouseup', onUp)
    // A release outside the window (or an alt-tab mid-drag) would otherwise
    // leave a node pinned — treat losing the window as ending the drag.
    window.addEventListener('blur', onUp)
    canvas.addEventListener('mouseleave', onLeave)
    document.addEventListener('visibilitychange', onVisibility)

    if (calm) {
      // Settle synchronously to a static, still-interactive frame.
      for (let i = 0; i < 260; i++) physics()
      draw()
    } else {
      raf = requestAnimationFrame(frame)
    }

    return () => {
      stopped = true
      drawRef.current = null
      cancelAnimationFrame(raf)
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onUp)
      canvas.removeEventListener('mouseleave', onLeave)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, size.width, size.height, reducedMotion, onSelect])

  // When focus is released, breathe the graph back to life: a tiny velocity
  // nudge plus a wake flag the loop reads to re-warm alpha, so the nudge is
  // actually integrated even if the layout had already settled.
  useEffect(() => {
    if (selectedNoteId === null && simRef.current) {
      for (const n of simRef.current.nodes) {
        n.vx += Math.cos(n.x) * 0.4
        n.vy += Math.sin(n.y) * 0.4
      }
      wakeRef.current = true
    }
  }, [selectedNoteId])

  if (graph.notes.length === 0) return <p className="vault-empty">No notes yet.</p>

  return (
    <div className="living-web" ref={wrapRef}>
      <canvas ref={canvasRef} className="living-web-canvas" />
      {/* Without this the canvas is an unlabelled field of dots — the key has
          to sit on the canvas, because that is where the question is asked. */}
      <p className="living-web-key">
        Each dot is a note · colour = origin project · size = authored links · hover to name one, click to read it
      </p>
    </div>
  )
}
