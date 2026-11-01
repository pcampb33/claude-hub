import type { PaceRow } from './pace'
import { formatSpan, pct } from './pace'
import './pace.css'

// One window: solid fill = used so far, faint fill = where the current pace
// lands by reset, tick = how much of the window's time has gone. A fill ahead
// of the tick is a pace above even.
export function PaceTrack({ row }: { row: PaceRow }) {
  const { pace } = row
  const used = Math.min(1, pace.used)
  const projected = pace.kind === 'projected' ? Math.min(1, pace.projected) : used
  const label =
    pace.kind === 'projected'
      ? `${row.name}: ${pct(pace.used)} used, ${pct(pace.elapsed)} of the window gone, about ${pct(pace.projected)} at reset`
      : pace.kind === 'early'
        ? `${row.name}: ${pct(pace.used)} used, ${pct(pace.elapsed)} of the window gone, too early to project`
        : `${row.name}: ${pct(pace.used)} used in a window that has since reset`
  return (
    <div className="pace-track" role="img" aria-label={label}>
      {pace.kind === 'projected' && <i className="pace-proj" style={{ width: `${projected * 100}%` }} />}
      <i className="pace-used" style={{ width: `${used * 100}%` }} />
      {pace.kind !== 'reset' && <b className="pace-tick" style={{ left: `${pace.elapsed * 100}%` }} />}
    </div>
  )
}

// The line under a track: the projection (or why there is none) and the reset.
export function PaceCaption({ row, clockFn }: { row: PaceRow; clockFn: (at: number) => string }) {
  const { pace } = row
  return (
    <div className="pace-cap">
      {pace.kind === 'projected' ? (
        pace.runsOutAt !== null ? (
          <span className="tone-warn">runs out ~{clockFn(pace.runsOutAt)} at this pace</span>
        ) : (
          <span>
            on pace for <b>{pct(pace.projected)}</b>
          </span>
        )
      ) : pace.kind === 'early' ? (
        <span>too early to project</span>
      ) : (
        <span>this reading’s window has reset</span>
      )}
      {pace.kind !== 'reset' && <span>resets in {formatSpan(pace.resetsInMs)}</span>}
    </div>
  )
}
