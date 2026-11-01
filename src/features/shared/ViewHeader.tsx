import { type ReactNode } from 'react'
import { RefreshIcon } from './icons'
import { usePersistentState } from './usePersistentState'
import './view-header.css'

// The one header every view starts with: title left, actions right, optional
// one-line subtitle tucked behind an ⓘ toggle (replaces the always-visible
// per-view intro paragraphs). Actions render in the caller's order under a
// fixed convention: primary CTA first, ghost buttons after, Refresh always
// last (use RefreshAction so it looks identical everywhere). Deliberately
// tiny — view-specific behavior belongs in the view, not behind new props
// here. Width overrides stay in view CSS via ancestor selectors
// (e.g. `.skills-view .view-header { max-width: … }`).
export function ViewHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  // Sticky per view, not per mount. Views remount on every route change, so a
  // plain useState re-collapsed the explanation each time you came back — the
  // one sentence saying what the view is for could never be made to stay. This
  // is sessionStorage-backed, so the calm collapsed default returns on relaunch
  // while a deliberate "leave it open" survives navigating away and back.
  const [infoOpen, setInfoOpen] = usePersistentState(`view-header:info:${title}`, false)
  return (
    <>
      <header className="view-header">
        <div className="view-header-heading">
          <h2>{title}</h2>
          {subtitle != null && (
            <button
              type="button"
              className={`view-header-info${infoOpen ? ' open' : ''}`}
              onClick={() => setInfoOpen((v) => !v)}
              aria-expanded={infoOpen}
              aria-label={`About ${title}`}
            >
              ⓘ
            </button>
          )}
        </div>
        {actions != null && <div className="view-header-actions">{actions}</div>}
      </header>
      {subtitle != null && infoOpen && <p className="view-header-subtitle">{subtitle}</p>}
    </>
  )
}

// The uniform trailing Refresh action — same glyph, label, and disabled
// treatment on every view.
export function RefreshAction({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={loading}>
      <span className={`refresh-glyph${loading ? ' spinning' : ''}`}>
        <RefreshIcon />
      </span>
      {loading ? 'Refreshing…' : 'Refresh'}
    </button>
  )
}
