import type { ReactNode } from 'react'
import type { GlobalAutomation, ProjectFloorStatus } from '../../../../../shared/ipc-types'
import { useWidgetMeta } from '../../frame-context'
import { Loading, Unreachable } from '../../parts'
import { usePeekTarget } from '../../peek-context'
import { useFloorRead, useGlobalConfigRead } from '../../reads'
import type { WidgetProps } from '../../types'
import { relativeTime } from '../../../shared/relative-time'
import {
  cycleMinutes,
  dialPlacements,
  durationText,
  floorDayText,
  floorDayWord,
  gradeSummary,
  gradeWord,
  hourText,
  minutesUntil,
  runHour,
  shortLabel,
} from './model'
import { useNow } from './useNow'
import './automation.css'

const CX = 70
const CY = 70
const R = 48

// Glance: scheduled jobs on a 24-hour dial at the time they run, the global
// hooks with when each last did work, and a 14-day pass/fail strip per verify
// floor. Every job, hook and floor day opens its own peek.
export function AutomationWidget({ size }: WidgetProps) {
  const cfg = useGlobalConfigRead()
  const floor = useFloorRead()
  const now = useNow()

  const autos = cfg.data?.automations
  const redFloors = floor.data?.projects.filter((p) => p.latest && !p.latest.ok).length ?? 0
  const summary = autos ? gradeSummary(autos) : null
  useWidgetMeta(
    cfg.status === 'error'
      ? 'couldn’t read'
      : summary === 'all working' && redFloors
        ? `${redFloors} floor${redFloors > 1 ? 's' : ''} red`
        : summary,
  )

  return (
    <div className={`auto${size === 'S' ? '' : ' auto-wide'}`}>
      {cfg.status === 'loading' && <Loading rows={4} />}
      {cfg.status === 'error' && (
        <Unreachable what="the hooks and scheduled jobs" error={cfg.error} onRetry={cfg.refresh} />
      )}
      {autos && <Schedule autos={autos} schedulerError={cfg.data!.schedulerError} now={now} wide={size !== 'S'} />}
      <Floors read={floor} />
    </div>
  )
}

function Schedule({
  autos,
  schedulerError,
  now,
  wide,
}: {
  autos: GlobalAutomation[]
  schedulerError: string | null
  now: Date
  wide: boolean
}) {
  const peekTarget = usePeekTarget()
  const jobs = autos.filter((a) => a.kind === 'scheduled')
  const hooks = autos.filter((a) => a.kind === 'hook')
  const placed = jobs.flatMap((a) => {
    const at = runHour(a)
    return at ? [{ a, hour: at.hour }] : []
  })
  const unplaced = jobs.filter((a) => !placed.some((p) => p.a === a))
  const dots = dialPlacements(placed, CX, CY, R, 13)
  const next = [...placed].sort((p, q) => cycleMinutes(p.hour, now) - cycleMinutes(q.hour, now))[0]
  const nextIn = next ? minutesUntil(next.a, next.hour, now) : null
  const handAng = ((now.getHours() + now.getMinutes() / 60) / 24) * 2 * Math.PI - Math.PI / 2

  return (
    <div className="auto-top">
      <svg viewBox="0 0 140 140" className="auto-dial" role="group" aria-label="Scheduled jobs on a 24-hour dial">
        <circle cx={CX} cy={CY} r={R} className="auto-ring" />
        {[0, 6, 12, 18].map((h) => {
          const ang = (h / 24) * 2 * Math.PI - Math.PI / 2
          return (
            <text key={h} x={CX + (R + 15) * Math.cos(ang)} y={CY + (R + 15) * Math.sin(ang) + 3} className="auto-hr">
              {String(h).padStart(2, '0')}
            </text>
          )
        })}
        <line
          x1={CX}
          y1={CY}
          x2={CX + (R - 20) * Math.cos(handAng)}
          y2={CY + (R - 20) * Math.sin(handAng)}
          className="auto-hand"
        />
        <circle cx={CX} cy={CY} r={3} className="auto-hub" />
        {dots.map((d) => (
          <g
            key={d.a.id}
            {...peekTarget(
              'automation',
              { item: d.a.id },
              `${shortLabel(d.a)}, ${hourText(d.hour)}, ${gradeWord(d.a.state)}`,
            )}
          >
            <title>{`${shortLabel(d.a)} · ${hourText(d.hour)} · ${gradeWord(d.a.state)}`}</title>
            <circle cx={d.x} cy={d.y} r={6.5} className={`auto-dot g-${d.a.state}`} />
          </g>
        ))}
      </svg>

      <div className="auto-side">
        {schedulerError && <div className="auto-warn">Task Scheduler unreadable — job grades are unknown</div>}
        {next && (
          <div className="auto-line" {...peekTarget('automation', { item: next.a.id }, `Next: ${shortLabel(next.a)}`)}>
            <b>Next: {shortLabel(next.a)}</b>
            <span>
              {hourText(next.hour)}
              {nextIn != null ? ` · in ${durationText(nextIn)}` : ''}
            </span>
          </div>
        )}
        {wide && jobs.length > 0 && (
          <Group title="Scheduled">
            {jobs.map((a) => (
              <Item key={a.id} a={a} figure={a.lastRunIso ? relativeTime(a.lastRunIso, now.getTime()) : 'no run'} />
            ))}
          </Group>
        )}
        {!wide && unplaced.length > 0 && (
          <Group title="No time known">
            {unplaced.map((a) => (
              <Item key={a.id} a={a} figure="—" />
            ))}
          </Group>
        )}
        <Group title="Hooks">
          {hooks.length === 0 ? (
            <span className="auto-none">No global hooks configured</span>
          ) : (
            hooks.map((a) => (
              <Item key={a.id} a={a} figure={a.lastRunIso ? relativeTime(a.lastRunIso, now.getTime()) : 'undated'} />
            ))
          )}
        </Group>
      </div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="auto-group">
      <h6>{title}</h6>
      {children}
    </div>
  )
}

function Item({ a, figure }: { a: GlobalAutomation; figure: string }) {
  const peekTarget = usePeekTarget()
  return (
    <div className="auto-item" {...peekTarget('automation', { item: a.id }, `${shortLabel(a)}: ${gradeWord(a.state)}`)}>
      <i className={`auto-pip g-${a.state}`} aria-hidden="true" />
      <span>{shortLabel(a)}</span>
      <em>{figure}</em>
    </div>
  )
}

function Floors({ read }: { read: ReturnType<typeof useFloorRead> }) {
  const peekTarget = usePeekTarget()
  if (read.status === 'loading') return <Loading rows={2} />
  if (read.status === 'error') return <Unreachable what="the verify floors" error={read.error} onRetry={read.refresh} />
  const set: ProjectFloorStatus[] = read.data.projects.filter((p) => p.verifyCommand)
  const without = read.data.projects.length - set.length
  return (
    <div className="auto-floors">
      <div className="auto-cap">
        Verify floors, {read.data.historyDays} days
        {without > 0 && <span> · {without} projects have none</span>}
      </div>
      {set.length === 0 && <span className="auto-none">No project has a verify command</span>}
      {set.map((p) => (
        <div key={p.id} className="auto-fl">
          <span className="auto-fl-name" {...peekTarget('automation', { floor: p.id }, `${p.name} verify floor`)}>
            {p.name}
          </span>
          <span className="auto-fl-days">
            {p.days.map((d, i) => (
              <i
                key={d.date}
                className={`auto-day d-${d.status}`}
                title={`${p.name} · ${floorDayText(d.date)}: ${floorDayWord(d.status)}`}
                {...peekTarget(
                  'automation',
                  { floor: p.id, day: i },
                  `${p.name}, ${floorDayText(d.date)}: ${floorDayWord(d.status)}`,
                )}
              />
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}
