import { createContext, useCallback, useContext, type KeyboardEvent } from 'react'
import type { PeekCtx, WidgetId } from './types'

// Glance → peek → act. One slide-over panel for the whole board; any widget
// or sub-element opens it, and a peek can open another (chaining), e.g. an
// activity day → the project that was busy that day.

interface PeekState {
  widget: WidgetId
  ctx: PeekCtx
}

export interface PeekApi {
  state: PeekState | null
  open: (widget: WidgetId, ctx?: PeekCtx) => void
  close: () => void
}

export const PeekContext = createContext<PeekApi | null>(null)

export function usePeek(): PeekApi {
  const api = useContext(PeekContext)
  if (!api) throw new Error('usePeek outside PeekProvider')
  return api
}

// Props that make any element (a div row, an SVG <g>, a chip) open a scoped
// peek on click or Enter/Space, with an accessible name. Spread them:
//   <g {...peekTarget('projects', { project: p.id }, `${p.name} details`)}>
export function usePeekTarget() {
  const { open } = usePeek()
  return useCallback(
    (widget: WidgetId, ctx: PeekCtx, label: string) => ({
      role: 'button' as const,
      tabIndex: 0,
      'aria-label': label,
      'data-peek': '',
      onClick: (e: { stopPropagation: () => void }) => {
        e.stopPropagation()
        open(widget, ctx)
      },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          open(widget, ctx)
        }
      },
    }),
    [open],
  )
}

