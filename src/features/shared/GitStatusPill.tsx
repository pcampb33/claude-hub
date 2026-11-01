import './git-status-pill.css'

// Pill-shaped git status badge with a colored dot. Colors map to shared
// status tokens: clean -> ok, dirty/stale -> warn, no-git -> faint.

export type GitStatus = 'clean' | 'dirty' | 'no-git' | 'stale'

const STATUS: Record<GitStatus, { color: string; label: string }> = {
  clean: { color: 'var(--ok)', label: 'Clean' },
  dirty: { color: 'var(--warn)', label: 'Dirty' },
  stale: { color: 'var(--warn)', label: 'Stale' },
  'no-git': { color: 'var(--text-faint)', label: 'No git' },
}

export function GitStatusPill({ status, label }: { status: GitStatus; label?: string }) {
  const { color, label: fallback } = STATUS[status]
  return (
    <span
      className="git-status-pill"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 32%, transparent)`,
      }}
    >
      <span className="git-status-pill-dot" style={{ backgroundColor: color }} />
      {label ?? fallback}
    </span>
  )
}
