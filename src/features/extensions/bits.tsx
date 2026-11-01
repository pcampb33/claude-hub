import type { ReactNode } from 'react'
import type { ExtensionItem } from '../../../shared/ipc-types'
import { statusGlyph, statusLabel, statusTone } from './model'

// A source that could not be read. Never an empty state.
export function Unreachable({ what, error, onRetry }: { what: string; error: string; onRetry?: () => void }) {
  return (
    <div className="ext-unreachable" role="status">
      <span>
        Couldn’t read {what}: {error}
      </span>
      {onRetry && (
        <button type="button" className="btn-ghost" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}

export function StatusPill({ item }: { item: ExtensionItem }) {
  return (
    <span className="ext-pill" data-tone={statusTone(item)}>
      <i aria-hidden="true" />
      {statusLabel(item)}
    </span>
  )
}

export function Glyph({ item }: { item: ExtensionItem }) {
  return (
    <span className="ext-glyph" data-tone={statusTone(item)} aria-hidden="true">
      {statusGlyph(item)}
    </span>
  )
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="ext-card">
      {title && <h5>{title}</h5>}
      {children}
    </section>
  )
}

// Single-hue bars with direct labels: one row per tool, longest first.
export function TopBars({ rows, label }: { rows: { tool: string; count: number }[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <div className="ext-bars" role="list" aria-label={label}>
      {rows.map((r) => (
        <div className="ext-bar-row" role="listitem" key={r.tool}>
          <span className="ext-bar-label" title={r.tool}>
            {r.tool}
          </span>
          <span className="ext-bar-track" aria-hidden="true">
            <i style={{ width: `${(r.count / max) * 100}%` }} />
          </span>
          <em>{r.count.toLocaleString()}</em>
        </div>
      ))}
    </div>
  )
}
