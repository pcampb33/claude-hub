import { useEffect, useState } from 'react'

// The rendered width of a chart's container, so an SVG can be laid out at 1:1
// (text stays at its real size at M, L and XL instead of scaling with the
// viewBox). A callback ref, because the measured element changes when the
// widget moves from its loading placeholder to the chart.
export function useWidth(fallback: number) {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width)
      if (w > 0) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, width] as const
}
