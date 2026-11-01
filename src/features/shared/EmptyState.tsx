import type { ReactNode } from 'react'

// Redesigned empty state: centered faint glyph, one-line headline, one-line
// hint, optional action button slot. Styles in index.css (.empty-state).

export function EmptyState({
  glyph,
  title,
  hint,
  action,
}: {
  glyph?: ReactNode
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      {glyph && <div className="empty-state-glyph">{glyph}</div>}
      <div className="empty-state-title">{title}</div>
      {hint && <div className="empty-state-hint">{hint}</div>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  )
}
