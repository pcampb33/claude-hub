import type { SessionActivity } from '../../../../../shared/ipc-types'
import { RIBBON_LEGEND, clockTime as clock, formatSpan, ribbonGroup, whereTimeWent, type RibbonGroup } from './live-core'

// Where a session's time went, as one strip: each segment's width is its share
// of the wall time; a break over 2h is a fixed zig-zag, not to scale. Flex
// widths (grow = duration) fill whatever row it sits in.

const label = new Map(RIBBON_LEGEND.map((l) => [l.group, l.label]))

function Zigzag() {
  return (
    <svg viewBox="0 0 12 10" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 10 L2 0 L4 10 L6 0 L8 10 L10 0 L12 10" />
    </svg>
  )
}

export function Ribbon({ a, big = false, name }: { a: SessionActivity; big?: boolean; name: string }) {
  const items = [
    ...a.segments.map((s) => ({ ...s, brk: false })),
    ...a.breaks.map((b) => ({ ...b, kind: null, brk: true })),
  ].sort((x, y) => x.startMs - y.startMs)
  const total = items.reduce((t, s) => t + (s.brk ? 0 : s.endMs - s.startMs), 0)
  const lw = big ? a.longestWait : undefined
  // The coarsened segment that holds the longest wait carries its label.
  const lwMid = lw ? (lw.startMs + lw.endMs) / 2 : NaN
  let before = 0
  return (
    <div className={`ribbon${big ? ' ribbon-big' : ''}`} role="img" aria-label={`${name}, where the time went: ${whereTimeWent(a)}`}>
      {items.map((s) => {
        if (s.brk)
          return (
            <span key={`b${s.startMs}`} className="rb-break" title={`${formatSpan(s.endMs - s.startMs)} away (not to scale)`}>
              <Zigzag />
            </span>
          )
        const d = s.endMs - s.startMs
        const at = total > 0 ? before / total : 0
        before += d
        const g: RibbonGroup = ribbonGroup(s.kind!)
        const holdsLw = lw && s.kind === 'waiting' && s.startMs <= lwMid && lwMid <= s.endMs
        return (
          <span
            key={s.startMs}
            className={`rb rb-${g}`}
            style={{ flexGrow: d }}
            title={`${label.get(g)} · ${formatSpan(d)} · ${clock(s.startMs)}–${clock(s.endMs)}`}
          >
            {holdsLw && (
              <span className={`rb-lw${at > 0.6 ? ' rb-lw-end' : ''}`}>longest wait {formatSpan(lw.endMs - lw.startMs)}</span>
            )}
          </span>
        )
      })}
    </div>
  )
}

// One legend for every ribbon on the card, listing only the groups shown.
export function RibbonLegend({ activities }: { activities: SessionActivity[] }) {
  const shown = new Set<RibbonGroup>()
  let breaks = false
  for (const a of activities) {
    for (const s of a.segments) shown.add(ribbonGroup(s.kind))
    if (a.breaks.length) breaks = true
  }
  if (shown.size === 0) return null
  return (
    <div className="live-legend" aria-hidden="true">
      {RIBBON_LEGEND.filter((l) => shown.has(l.group)).map((l) => (
        <span key={l.group}>
          <i className={`rb rb-${l.group}`} />
          {l.label}
        </span>
      ))}
      {breaks && (
        <span>
          <i className="rb-break">
            <Zigzag />
          </i>
          break over 2h
        </span>
      )}
    </div>
  )
}
