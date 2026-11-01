import type { ComponentType } from 'react'

// The Home widget board's contract. A widget is a glance (its body on the
// board) plus a peek (a slide-over detail panel). Clicking the widget opens
// its peek; clicking a sub-element (a map dot, a job, a row) opens the peek
// scoped to that item through `ctx`. Every peek ends in real actions.

export type WidgetId = 'needs' | 'live' | 'projects' | 'automation' | 'inbox' | 'capture' | 'recall' | 'pace' | 'launch'

// Board columns out of 12: S 4 · M 6 · L 8 · XL 12, so Balanced's rows each
// fill (M+M, L+S, S+S+S). Below ~860px everything but S goes full width.
export type WidgetSize = 'S' | 'M' | 'L' | 'XL'

// Scopes a peek to one item, e.g. { project: '<registry id>' } or
// { entry: 2 }. JSON-serializable; null opens the widget's overview.
export type PeekCtx = Record<string, string | number> | null

export interface WidgetProps {
  size: WidgetSize
  // The selected mode when the def declares `modes` (e.g. Projects: Map /
  // Activity); undefined otherwise.
  mode: string | undefined
}

export interface DetailProps {
  ctx: PeekCtx
}

export interface WidgetDef {
  id: WidgetId
  title: string
  // One line for the Customize library: what the widget answers.
  blurb: string
  sizes: WidgetSize[]
  modes?: string[]
  // Human text for the when-relevant rule, shown in Customize and on a hidden
  // widget's ghost ("Shows when notes are waiting"). Absent = always shown.
  relevance?: string
  Widget: ComponentType<WidgetProps>
  // Renders the whole panel content via <PeekContent>.
  Detail: ComponentType<DetailProps>
}
