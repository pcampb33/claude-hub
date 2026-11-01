import type { CSSProperties } from 'react'

// Shimmer loading placeholder — a sized .skeleton block (see index.css).

export function Skeleton({ width, height = 14, style }: { width?: number | string; height?: number | string; style?: CSSProperties }) {
  return <div className="skeleton" style={{ width, height, ...style }} aria-hidden />
}

/** A stack of skeleton rows approximating a list of cards. */
export function SkeletonList({ rows = 3, rowHeight = 72 }: { rows?: number; rowHeight?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', maxWidth: 'var(--content-width)' }}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={rowHeight} />
      ))}
    </div>
  )
}
