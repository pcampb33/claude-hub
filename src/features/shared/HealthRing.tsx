import type { CSSProperties } from 'react'
import './health-ring.css'

// Circular SVG progress ring for a 0-100 health score. Color thresholds:
// >=85 ok, 60-84 warn, <60 danger. A null score renders a faint empty ring
// with an em-dash. The stroke draws in once on mount (CSS animation keyed to
// element mount — a later score change snaps, it does not re-animate).

function colorFor(score: number): string {
  if (score >= 85) return 'var(--ok)'
  if (score >= 60) return 'var(--warn)'
  return 'var(--danger)'
}

export function HealthRing({ score, size = 64 }: { score: number | null; size?: number }) {
  const stroke = Math.max(3, Math.round(size * 0.09))
  const center = size / 2
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r
  const empty = score == null
  const clamped = empty ? 0 : Math.max(0, Math.min(100, score))
  const offset = circumference * (1 - clamped / 100)

  return (
    <div
      className="health-ring"
      style={{ width: size, height: size }}
      role="img"
      aria-label={empty ? 'Health score unavailable' : `Health score ${Math.round(clamped)} of 100`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          className="health-ring-track"
          cx={center}
          cy={center}
          r={r}
          strokeWidth={stroke}
          fill="none"
        />
        {!empty && (
          <circle
            className="health-ring-value"
            cx={center}
            cy={center}
            r={r}
            strokeWidth={stroke}
            fill="none"
            stroke={colorFor(clamped)}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${center} ${center})`}
            style={{ '--ring-circumference': `${circumference}px` } as CSSProperties}
          />
        )}
      </svg>
      <span className="health-ring-label" style={{ fontSize: Math.round(size * 0.28) }}>
        {empty ? '—' : Math.round(clamped)}
      </span>
    </div>
  )
}
