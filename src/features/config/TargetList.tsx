import type { DesktopTarget } from '../../../shared/ipc-types'
import { ListFilter, ListGroupHead } from '../shared/ListShell'
import { TierChip } from '../shared/TierChip'
import { relativeTimeOrNever } from '../shared/relative-time'
import { useRovingRows } from '../shared/useRovingRows'
import { chipTier, groupTargets, targetParam } from './config-model.ts'
import type { BoundaryEntry } from './useConfig'

// The chip says the tier once its boundary is read; until then nothing, and a
// failed read says so rather than implying a default.
function Chip({ entry }: { entry: BoundaryEntry | undefined }) {
  if (!entry) return <span className="cfg-chip-wait" aria-label="Reading boundary" />
  if (entry.status === 'error') {
    return (
      <span className="cfg-chip-err" title={`Couldn’t read the boundary: ${entry.error}`}>
        ?
      </span>
    )
  }
  return <TierChip tier={chipTier(entry.data.boundary)} title={entry.data.guard.covers} />
}

export function TargetList({
  targets,
  filter,
  onFilter,
  selectedKey,
  boundaries,
  onPick,
}: {
  targets: DesktopTarget[]
  filter: string
  onFilter: (v: string) => void
  selectedKey: string | null
  boundaries: Record<string, BoundaryEntry>
  onPick: (key: string) => void
}) {
  const { listRef, onKeyDown } = useRovingRows('.cfg-row')
  const groups = groupTargets(targets, filter)
  const sections = [
    { label: 'Projects', rows: groups.projects },
    { label: 'Sandbox experiments', rows: groups.experiments },
  ].filter((s) => s.rows.length > 0)
  // When every boundary read failed the same way, say it once above the list.
  const reads = targets.map((t) => boundaries[targetParam(t)])
  const errors = reads.flatMap((e) => (e?.status === 'error' ? [e.error] : []))
  const failed = targets.length > 0 && errors.length === targets.length && new Set(errors).size === 1 ? errors[0] : null

  return (
    <div className="cfg-list">
      <ListFilter
        value={filter}
        onChange={onFilter}
        placeholder="Filter projects and experiments…"
        count={groups.projects.length + groups.experiments.length}
        ariaLabel="Filter projects and experiments"
      />
      {failed && <p className="cfg-note is-warn">Couldn’t read the boundaries, so tiers show as “?”: {failed}</p>}
      <div className="cfg-rows" ref={listRef} onKeyDown={onKeyDown}>
        {sections.length === 0 && (
          <p className="cfg-note">{filter.trim() ? `Nothing matches “${filter.trim()}”.` : 'No projects or sandbox experiments yet.'}</p>
        )}
        {sections.map((s) => (
          <div key={s.label} role="group" aria-label={s.label}>
            <ListGroupHead label={s.label} count={s.rows.length} />
            {s.rows.map((t) => {
              const key = targetParam(t)
              return (
                <button
                  type="button"
                  key={key}
                  className="cfg-row"
                  aria-current={key === selectedKey ? 'true' : undefined}
                  onClick={() => onPick(key)}
                >
                  <span className="cfg-row-text">
                    <b>{t.name}</b>
                    <small>{t.lastActivityIso ? `active ${relativeTimeOrNever(t.lastActivityIso)}` : 'no sessions found'}</small>
                  </span>
                  <Chip entry={boundaries[key]} />
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
