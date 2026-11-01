import { useEffect, useState } from 'react'
import type { LiveProjectStatus } from '../../../shared/ipc-types'
import { useLiveStatus } from './useLiveStatus'
import { useNavigate } from '../shared/useHashRoute'
import { SearchTrigger } from '../shared/SearchTrigger'
import { formatElapsed, formatTokens } from './format'
import './titlebar.css'

// The frameless window's real titlebar: an always-rendered 36px strip above
// the scrolling content. One pill per live session (dot · name · elapsed ·
// context gauge) with the detail demoted to the hover tooltip; everything
// between the pills is a native drag region (see titlebar.css).
//
// The same live session is also a row in Sessions, so the two surfaces split
// the job rather than printing the same three facts twice: this bar is the
// ambient glance — how long it has been running and whether the window is
// filling up — and Sessions owns what it is doing and the exact percentage.

// Pills past the cap collapse into "+N more" (deep-links to Sessions), so the
// bar can never outgrow its single 36px row. The cap is a width question, not
// a count one: a full pill measures ~165-205px, and the strip also has to seat
// the search trigger, so three of them only fit on a wide window. Below these
// widths the extra session goes to the chip rather than squeezing every name
// down to an initial — the chip still counts it, where "c…" is a pill you
// cannot identify. Ordered widest-first; the fallback is the narrowest tier.
const PILL_CAPS: ReadonlyArray<readonly [string, number]> = [
  ['(min-width: 1400px)', 3],
  ['(min-width: 1050px)', 2],
]

function readPillCap(): number {
  return PILL_CAPS.find(([query]) => window.matchMedia(query).matches)?.[1] ?? 1
}

function usePillCap(): number {
  const [cap, setCap] = useState(readPillCap)
  useEffect(() => {
    const lists = PILL_CAPS.map(([query]) => window.matchMedia(query))
    const onChange = () => setCap(readPillCap())
    lists.forEach((l) => l.addEventListener('change', onChange))
    return () => lists.forEach((l) => l.removeEventListener('change', onChange))
  }, [])
  return cap
}

function pillTitle(p: LiveProjectStatus, nowMs: number): string {
  const parts: string[] = []
  if (p.lastToolName) parts.push(p.lastToolName)
  // Both durations, each labelled. The pill prints the first one bare, and
  // "12m 47s" next to an unqualified "idle 3s" is two numbers with no way to
  // tell which the pill was showing.
  if (p.sessionStart) parts.push(`running ${formatElapsed(p.sessionStart, nowMs)}`)
  if (p.lastTimestamp) parts.push(`idle ${formatElapsed(p.lastTimestamp, nowMs)}`)
  if (p.contextPct !== undefined) {
    // The gauge is the glance; the number it stands for lives here, said in
    // full, since the pill itself no longer prints a bare unlabelled "8%".
    const tokens =
      p.contextTokens !== undefined && p.contextLimit !== undefined
        ? ` (${formatTokens(p.contextTokens)}/~${formatTokens(p.contextLimit)})`
        : ''
    parts.push(`context ${p.contextPct}%${tokens}`)
  }
  if (p.sessionId) parts.push('click to open session')
  // Always lead with the project name, never only the AI title: the pill can
  // now ellipsise the name, and this tooltip is where the whole of it lives.
  const heading = p.aiTitle ? `${p.name} — ${p.aiTitle}` : p.name
  return `${heading}\n${parts.join(' · ')}`
}

function gaugeLevel(pct: number): string {
  return pct > 90 ? 'danger' : pct > 70 ? 'warn' : 'ok'
}

export function TitleBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const snapshot = useLiveStatus()
  const navigate = useNavigate()
  const maxPills = usePillCap()
  const active = snapshot?.projects.filter((p) => p.state === 'active') ?? []

  // Local 1s tick keeps the elapsed counters moving between pushes.
  const [nowMs, setNowMs] = useState(() => Date.now())
  const anyActive = active.length > 0
  useEffect(() => {
    if (!anyActive) return
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [anyActive])

  const visible = active.slice(0, maxPills)
  const overflow = active.length - visible.length

  return (
    <div className="titlebar">
      {anyActive ? (
        <div className="titlebar-pills">
          {visible.map((p) => {
            // Only sessions we can address become buttons — a status with no
            // transcript has nowhere to deep-link.
            const Tag = p.sessionId ? ('button' as const) : ('span' as const)
            return (
              <Tag
                key={p.registryId}
                className="titlebar-pill"
                title={pillTitle(p, nowMs)}
                {...(p.sessionId
                  ? { type: 'button' as const, onClick: () => navigate('sessions', p.sessionId) }
                  : {})}
              >
                <span className="titlebar-pill-dot" aria-hidden="true" />
                <span className="titlebar-pill-name">{p.name}</span>
                {p.sessionStart && (
                  <span className="titlebar-pill-elapsed">{formatElapsed(p.sessionStart, nowMs)}</span>
                )}
                {p.contextPct !== undefined && (
                  <span className="titlebar-pill-gauge" aria-hidden="true">
                    <span
                      className={`titlebar-pill-gauge-fill titlebar-gauge-${gaugeLevel(p.contextPct)}`}
                      style={{ width: `${p.contextPct}%` }}
                    />
                  </span>
                )}
              </Tag>
            )
          })}
          {overflow > 0 && (
            <button type="button" className="titlebar-pill titlebar-pill-more" onClick={() => navigate('sessions')}>
              +{overflow} more
            </button>
          )}
        </div>
      ) : (
        <span className="titlebar-idle">no live sessions</span>
      )}
      <SearchTrigger onOpen={onOpenPalette} className="search-trigger-titlebar" />
    </div>
  )
}
