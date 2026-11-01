import type { DesktopSession, DesktopSnapshot, OutsideSession } from '../../../shared/ipc-types'
import { StatePill } from './StatePill'
import { TierChip } from '../shared/TierChip'
import { formatDuration, groupDock, idColor, sessionTime } from './desktop-model'
import { OUTSIDE_STATUS, outsideLabel } from './launcher-model'
import { outsideKey } from './layout-model'

interface Props {
  sessions: DesktopSession[]
  outside: DesktopSnapshot['outside']
  focusedId: string | null
  onStage: string[]
  nowMs: number
  onPick: (id: string) => void
  onPickOutside: (sessionId: string) => void
}

export function Dock({ sessions, outside, focusedId, onStage, nowMs, onPick, onPickOutside }: Props) {
  const others = outside.sessions ?? []
  return (
    <aside className="desk-dock" aria-label="Desktop sessions">
      {groupDock(sessions).map((group) => (
        <section key={group.key} className="desk-group" aria-label={group.label}>
          <h4 className="desk-group-head">
            <span>{group.label}</span>
            <span>{group.sessions.length}</span>
          </h4>
          {group.sessions.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              focused={s.id === focusedId}
              staged={onStage.includes(s.id)}
              nowMs={nowMs}
              onPick={() => onPick(s.id)}
            />
          ))}
        </section>
      ))}
      {others.length > 0 && (
        <section className="desk-group" aria-label="In other terminals">
          <h4 className="desk-group-head">
            <span>In other terminals</span>
            <span>{others.length}</span>
          </h4>
          {others.map((o) => (
            <OutsideCard
              key={o.sessionId}
              session={o}
              focused={focusedId === outsideKey(o.sessionId)}
              staged={onStage.includes(outsideKey(o.sessionId))}
              nowMs={nowMs}
              onPick={() => onPickOutside(o.sessionId)}
            />
          ))}
        </section>
      )}
      <OutsideNote outside={outside} />
    </aside>
  )
}

function SessionCard({
  session: s,
  focused,
  staged,
  nowMs,
  onPick,
}: {
  session: DesktopSession
  focused: boolean
  staged: boolean
  nowMs: number
  onPick: () => void
}) {
  const pct = s.contextPct === null ? null : Math.max(0, Math.min(100, Math.round(s.contextPct)))
  return (
    <button
      className={`desk-card${focused ? ' focused' : ''}`}
      style={idColor(s.color)}
      onClick={onPick}
      aria-current={focused ? 'true' : undefined}
      aria-label={`${s.name}, ${s.targetName}. Alt ${s.slot}.${s.poppedOut ? ' In its own window.' : staged ? ' On stage.' : ''}`}
    >
      <span className="desk-card-stripe" aria-hidden="true" />
      <span className="desk-card-name">{s.name}</span>
      <kbd className="desk-key">Alt {s.slot}</kbd>
      <span className="desk-card-meta">
        <StatePill state={s.state} />
        <span className="desk-card-proj">{s.targetName}</span>
        {s.tier !== null && <TierChip tier={s.tier} />}
        <span>{sessionTime(s, nowMs)}</span>
        <span
          className={`desk-ctx${pct === null ? ' unknown' : ''}`}
          title={pct === null ? 'Context use not known' : `Context ${pct}% used`}
        >
          {pct !== null && <i style={{ width: `${pct}%` }} />}
        </span>
      </span>
      {s.poppedOut && <span className="desk-card-window">In its own window</span>}
      {s.state === 'needs-you' && <span className="desk-card-why">{s.stateDetail ?? 'Waiting for your choice'}</span>}
    </button>
  )
}

function OutsideCard({
  session: o,
  focused,
  staged,
  nowMs,
  onPick,
}: {
  session: OutsideSession
  focused: boolean
  staged: boolean
  nowMs: number
  onPick: () => void
}) {
  const { name, where } = outsideLabel(o)
  return (
    <button
      className={`desk-card desk-card-outside${focused ? ' focused' : ''}`}
      onClick={onPick}
      aria-current={focused ? 'true' : undefined}
      aria-label={`${name}, ${where}, running in another terminal, ${OUTSIDE_STATUS[o.status]}. Opens a read-only view.${staged ? ' On stage.' : ''}`}
    >
      <span className="desk-card-stripe" aria-hidden="true" />
      <span className="desk-card-name">{name}</span>
      <span className="desk-card-ro">read-only</span>
      <span className="desk-card-meta">
        <span className="desk-state" data-state={o.status === 'busy' ? 'working' : o.status === 'idle' ? 'your-turn' : 'unknown'}>
          {OUTSIDE_STATUS[o.status]}
        </span>
        <span className="desk-card-proj">{where}</span>
        {o.updatedAtIso && <span>{formatDuration(nowMs - Date.parse(o.updatedAtIso))}</span>}
      </span>
    </button>
  )
}

// What the dock couldn't learn about sessions outside the desktop. The list
// itself is the "In other terminals" group above.
export function OutsideNote({ outside, inEmptyState = false }: { outside: DesktopSnapshot['outside']; inEmptyState?: boolean }) {
  const count = outside.sessions?.length ?? null
  if (count === null) {
    return (
      <p className="desk-outside">
        Couldn't check for Claude sessions in other terminals{outside.error ? `: ${outside.error}` : '.'}
      </p>
    )
  }
  if (count > 0 && inEmptyState) {
    const one = count === 1
    return (
      <p className="desk-outside">
        <b>
          {count} Claude session{one ? ' is' : 's are'} running in other terminals.
        </b>{' '}
        Open New session to read or take over {one ? 'it' : 'one'}.{outside.error && <> ({outside.error})</>}
      </p>
    )
  }
  // The error (e.g. "the count may be low") qualifies any count, zero included.
  if (!outside.error) return null
  return (
    <p className="desk-outside">
      {count === 0 ? `No Claude sessions found in other terminals, but ${outside.error}.` : `The list of other terminals may be incomplete: ${outside.error}.`}
    </p>
  )
}
