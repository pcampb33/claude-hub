import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { PeekContext, usePeek } from './peek-context'
import type { PeekCtx, WidgetId } from './types'

export function PeekProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ widget: WidgetId; ctx: PeekCtx } | null>(null)
  // Focus returns to whatever opened the FIRST peek of a chain — a chained
  // peek's opener is inside the panel, which is gone once it closes.
  const returnFocus = useRef<HTMLElement | null>(null)
  const isOpen = useRef(false)

  const open = useCallback((widget: WidgetId, ctx: PeekCtx = null) => {
    if (!isOpen.current) returnFocus.current = document.activeElement as HTMLElement | null
    isOpen.current = true
    setState({ widget, ctx })
  }, [])

  const close = useCallback(() => {
    isOpen.current = false
    setState(null)
    const el = returnFocus.current
    returnFocus.current = null
    if (el && document.contains(el)) requestAnimationFrame(() => el.focus())
  }, [])

  const api = useMemo(() => ({ state, open, close }), [state, open, close])
  return <PeekContext.Provider value={api}>{children}</PeekContext.Provider>
}

// The panel's content: a crumb (the widget), a title (the item), then
// sections. Every Detail renders exactly one of these.
export function PeekContent({ crumb, title, children }: { crumb: string; title: ReactNode; children: ReactNode }) {
  const { close } = usePeek()
  return (
    <>
      <div className="peek-top">
        <div>
          <div className="peek-crumb">{crumb}</div>
          <h3 className="peek-title" id="peek-title">
            {title}
          </h3>
        </div>
        <button type="button" className="peek-close" onClick={close} aria-label="Close details" data-autofocus>
          ×
        </button>
      </div>
      <div className="peek-body">{children}</div>
    </>
  )
}
