import type { ReactNode } from 'react'
import './stat-card.css'

// KPI tile: uppercase letterspaced label (optional leading icon), a large
// tabular-nums value, and an optional sub line. `accent` tints it terracotta.
// With `onOpen` the tile becomes a button carrying a quiet deep-link arrow
// that lights on hover.
//
// `verdict` is the answer to "is that number good?" — the one thing a bare
// gauge never says. The app already had exactly one honest reading of a score
// ("53/100 — below the 80 baseline", in Needs attention) and no way to reuse
// the phrasing; this is that slot. Tone 'unknown' is deliberately available
// and deliberately not a synonym for 'bad': a tile that could not measure
// says so rather than rendering a smaller version of the claim.

export type VerdictTone = 'ok' | 'warn' | 'danger' | 'unknown'

export function StatCard({
  label,
  value,
  sub,
  verdict,
  accent,
  icon,
  onOpen,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  verdict?: { tone: VerdictTone; text: string }
  accent?: boolean
  icon?: ReactNode
  onOpen?: () => void
}) {
  const className = accent ? 'stat-card stat-card-accent' : 'stat-card'
  const body = (
    <>
      <div className="stat-card-label">
        {icon && <span className="stat-card-icon">{icon}</span>}
        {label}
      </div>
      {onOpen && (
        <span className="stat-card-go" aria-hidden="true">
          →
        </span>
      )}
      <div className="stat-card-value">{value}</div>
      {verdict != null && (
        <div className={`stat-card-verdict tone-${verdict.tone}`}>
          <span className="stat-card-verdict-dot" aria-hidden="true" />
          {verdict.text}
        </div>
      )}
      {sub != null && <div className="stat-card-sub">{sub}</div>}
    </>
  )
  if (onOpen) {
    return (
      <button type="button" className={`${className} stat-card-link`} onClick={onOpen}>
        {body}
      </button>
    )
  }
  return <div className={className}>{body}</div>
}
