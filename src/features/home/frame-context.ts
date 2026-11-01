import { createContext, useContext, useEffect } from 'react'

interface FrameApi {
  setMeta: (meta: string | null) => void
  setRelevant: (relevant: boolean | null) => void
}

export const FrameContext = createContext<FrameApi | null>(null)

// Short right-aligned text in the widget head ("3 waiting", "2 live").
export function useWidgetMeta(meta: string | null): void {
  const api = useContext(FrameContext)
  useEffect(() => {
    api?.setMeta(meta)
  }, [api, meta])
}

// Report whether the widget has anything to say right now. `false` lets the
// board hide it when its when-relevant rule is on. Pass `null` while loading
// AND on error: a widget whose source failed must stay visible and say so —
// hiding it would render a failure as an absence.
export function useRelevance(relevant: boolean | null): void {
  const api = useContext(FrameContext)
  useEffect(() => {
    api?.setRelevant(relevant)
  }, [api, relevant])
}
