import type { DesktopSession } from '../../../shared/ipc-types'
import { summarize } from './desktop-model'
import { PRESETS, type Preset, type PresetKey } from './layout-model'

// Each preset's icon is drawn from its own cells, so the picture can't drift
// from the layout.
function PresetIcon({ preset }: { preset: Preset }) {
  const w = 12 / preset.cols
  const h = 10 / preset.rows
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      {preset.cells.map((c, i) => (
        <rect key={i} x={2 + c.col * w + 0.6} y={3 + c.row * h + 0.6} width={c.colSpan * w - 1.2} height={c.rowSpan * h - 1.2} rx="1" />
      ))}
    </svg>
  )
}

export function DeskBar({
  sessions,
  hostStarting,
  layout,
  onLayout,
  dockHidden,
  onToggleDock,
  onNewSession,
}: {
  sessions: DesktopSession[]
  hostStarting: boolean
  layout: PresetKey
  onLayout: (layout: PresetKey) => void
  dockHidden: boolean
  onToggleDock: () => void
  onNewSession: () => void
}) {
  const sum = summarize(sessions)
  // With nothing on the desktop the empty state carries the one CTA, and a
  // layout switch would have nothing to lay out.
  if (sum.total === 0) {
    return (
      <div className="desk-bar">
        <span className="desk-sum">
          No sessions on the desktop yet
          {hostStarting && <span className="desk-faint"> · starting the session host…</span>}
        </span>
      </div>
    )
  }
  return (
    <div className="desk-bar">
      <span className="desk-sum">
        {sum.total} session{sum.total === 1 ? '' : 's'}
        {sum.needsYou > 0 && (
          <>
            {' · '}
            <b>
              {sum.needsYou} need{sum.needsYou === 1 ? 's' : ''} you
            </b>
          </>
        )}
        {sum.working > 0 && ` · ${sum.working} working`}
        {hostStarting && <span className="desk-faint"> · starting the session host…</span>}
      </span>
      <div className="desk-tools">
        <button
          className="desk-btn"
          onClick={onToggleDock}
          title={dockHidden ? 'Show the session list' : 'Hide the session list to give the terminals its width'}
        >
          {dockHidden ? 'Show list' : 'Hide list'}
        </button>
        <div className="desk-seg" role="group" aria-label="Layout">
          {PRESETS.map((p) => (
            <button key={p.key} aria-pressed={layout === p.key} onClick={() => onLayout(p.key)} title={p.label}>
              <PresetIcon preset={p} />
              <span className="desk-seg-label">{p.label}</span>
            </button>
          ))}
        </div>
        <NewSessionButton onClick={onNewSession} />
      </div>
    </div>
  )
}

export function NewSessionButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="desk-btn primary" aria-haspopup="dialog" onClick={onClick} title="New session (Ctrl+N)">
      New session
    </button>
  )
}
