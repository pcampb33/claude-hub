import { useWidgetMeta } from '../../frame-context'
import { usePeekTarget } from '../../peek-context'
import { Empty, Loading, Unreachable } from '../../parts'
import { useActivity, useLatestSessions, useProjects } from '../../reads'
import type { WidgetProps, WidgetSize } from '../../types'
import {
  HEALTHY,
  activityRows,
  dayLabels,
  dotRadius,
  healthTone,
  hoursSince,
  logPos,
  MAP_SPAN_HOURS,
  placeLabels,
  scoreFloor,
} from './projects-core'
import { useHealthFan } from './useProjectsData'
import { useWidth } from './useWidth'
import './projects.css'

export function ProjectsWidget({ size, mode }: WidgetProps) {
  return mode === 'Activity' ? <ActivityGrid size={size} /> : <ProjectMap size={size} />
}

const X_TICKS: [number, string][] = [
  [0, 'now'],
  [1, '1h'],
  [24, '1d'],
  [168, '1w'],
  [MAP_SPAN_HOURS, '30d'],
]

// Health (y) against time since the last session (x, log), dot size = the
// tokens a project loads into every session. Bottom-left is the corner to
// worry about: unhealthy and in use.
function ProjectMap({ size }: { size: WidgetSize }) {
  const health = useHealthFan()
  const latest = useLatestSessions()
  const peekTarget = usePeekTarget()
  const [ref, W] = useWidth(640)
  const count = health.status === 'data' ? health.data.length : null
  useWidgetMeta(count !== null ? `${count} projects` : null)

  if (health.status === 'error') return <Unreachable what="CLAUDE.md health" error={health.error} onRetry={health.retry} />
  if (latest.status === 'error') return <Unreachable what="latest sessions" error={latest.error} onRetry={latest.refresh} />
  if (health.status === 'loading' || latest.status === 'loading')
    return (
      <div ref={ref}>
        <Loading rows={5} />
      </div>
    )
  if (health.data.length === 0) return <Empty title="No projects registered">Add one from the Projects view.</Empty>

  const now = Date.now()
  const lastById = new Map(latest.data.map((s) => [s.registryId, s.timestamp]))
  const rows = health.data.map((p) => {
    const last = lastById.get(p.id)
    const hrs = last ? hoursSince(last, now) : null
    return { id: p.id, name: p.name, score: p.configHealth.score, tokens: p.configHealth.combinedEstimatedTokens, hrs }
  })
  const onMap = rows.filter((r) => r.hrs !== null && r.hrs <= MAP_SPAN_HOURS)
  const quiet = rows.filter((r) => r.hrs === null || r.hrs > MAP_SPAN_HOURS).sort((a, b) => a.score - b.score)

  const H = W > 560 ? 250 : 220
  const L = 30
  const R = 12
  const B = 32
  const T = 12
  const floor = scoreFloor(onMap.map((r) => r.score))
  const x0 = L + 14
  const plotW = W - x0 - R - 70
  const X = (h: number) => x0 + logPos(h) * plotW
  const Y = (v: number) => T + (1 - (v - floor) / (100 - floor)) * (H - B - T)
  // Neediest first, so they win the label spots.
  const dots = onMap
    .map((r) => ({ ...r, x: X(r.hrs ?? 0), y: Y(r.score), r: dotRadius(r.tokens) }))
    .sort((a, b) => a.score - b.score)
  const labels = placeLabels(
    dots.map((d) => ({ x: d.x - L, y: d.y, r: d.r, label: d.name })),
    W - L - R,
    H - B,
  )
  const grid = [...new Set([floor, 70, HEALTHY, 100])].filter((v) => v >= floor)
  const chips = size === 'M' ? 3 : size === 'L' ? 4 : 7

  return (
    <div ref={ref} className="pj-map">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Projects by CLAUDE.md health and time since last session; dot size is tokens loaded per session"
      >
        {grid.map((v) => (
          <g key={v}>
            <line className={`hc-grid${v === HEALTHY ? ' hc-grid-dash' : ''}`} x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} />
            <text className="hc-axis" x={L - 6} y={Y(v) + 3} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        <text className="hc-axis pj-healthy" x={W - R} y={Y(HEALTHY) - 5} textAnchor="end">
          80 = healthy
        </text>
        {X_TICKS.map(([h, l]) => (
          <text key={l} className="hc-axis" x={X(h)} y={H - 16} textAnchor="middle">
            {l}
          </text>
        ))}
        <text className="hc-axis pj-axis-title" x={x0} y={H - 2}>
          time since last session (log scale) →
        </text>
        {[...dots].sort((a, b) => b.r - a.r).map((d) => (
          <g
            key={d.id}
            {...peekTarget(
              'projects',
              { project: d.id },
              `${d.name}: health ${d.score}, about ${Math.round(d.tokens)} tokens a session`,
            )}
          >
            <circle className={`pj-dot pj-tone-${healthTone(d.score)}`} cx={d.x} cy={d.y} r={d.r}>
              <title>{`${d.name}: health ${d.score} · ~${d.tokens} tokens a session`}</title>
            </circle>
          </g>
        ))}
        {dots.map((d, i) => {
          const l = labels[i]
          return (
            l && (
              <text key={d.id} className="pj-label" x={l.x + L} y={l.y} textAnchor={l.anchor}>
                {d.name}
              </text>
            )
          )
        })}
      </svg>
      {quiet.length > 0 && (
        <div className="pj-later">
          <span>No sessions in 30 days:</span>
          {quiet.slice(0, chips).map((r) => (
            <span key={r.id} className="pj-chip" {...peekTarget('projects', { project: r.id }, `${r.name}, health ${r.score}`)}>
              {r.name}
              <em className={`tone-${healthTone(r.score)}`}>{r.score}</em>
            </span>
          ))}
          {quiet.length > chips && (
            <span className="pj-chip" {...peekTarget('projects', { quiet: 1 }, 'All projects with no session in 30 days')}>
              +{quiet.length - chips} more
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// One row per project that had a session in the last 14 days, one cell per
// day, shade = sessions active that day. Each day column opens that day.
function ActivityGrid({ size }: { size: WidgetSize }) {
  const activity = useActivity()
  const projects = useProjects()
  const peekTarget = usePeekTarget()
  const [ref, W] = useWidth(640)
  const summary =
    activity.status === 'data' && projects.status === 'data'
      ? activityRows(activity.data, (id) => projects.data.find((p) => p.id === id)?.name)
      : null
  const sessionDays = summary ? summary.totals.reduce((a, v) => a + v, 0) : null
  useWidgetMeta(sessionDays !== null ? `${sessionDays} session-days` : null)

  if (activity.status === 'error') return <Unreachable what="activity" error={activity.error} onRetry={activity.refresh} />
  if (projects.status === 'error') return <Unreachable what="the project list" error={projects.error} onRetry={projects.refresh} />
  if (!summary)
    return (
      <div ref={ref}>
        <Loading rows={5} />
      </div>
    )
  if (summary.rows.length === 0) return <Empty title="No sessions in the last 14 days" />

  const { rows, totals } = summary
  const maxRows = size === 'M' ? 6 : size === 'L' ? 8 : 12
  const shown = rows.slice(0, maxRows)
  const labels = dayLabels(Date.now(), totals.length)
  const labelW = Math.min(120, Math.max(80, W * 0.2))
  const totalW = 34
  const cellW = (W - labelW - totalW) / totals.length
  const cellH = 18
  const gap = 2
  const rowsH = (shown.length + 1) * (cellH + gap)
  const H = rowsH + 16
  const max = Math.max(...shown.flatMap((r) => r.days), 1)
  const busiest = rows.slice(0, 2).map((r) => `${r.name} (${r.total})`)

  const cells = (days: number[], y: number, scale: number) =>
    days.map((v, i) => {
      // Inverse text only on a near-solid cell; on a faded one it sinks
      // into the card behind.
      const strong = v / scale >= 0.8
      return (
        <g key={i}>
          <rect
            className={v > 0 ? 'pj-cell' : 'pj-cell pj-cell-empty'}
            x={labelW + i * cellW + gap / 2}
            y={y}
            width={cellW - gap}
            height={cellH}
            rx={3}
            style={v > 0 ? { opacity: 0.25 + 0.75 * Math.min(1, v / scale) } : undefined}
          />
          {v > 0 && (
            <text
              className={strong ? 'pj-cell-n pj-cell-n-strong' : 'pj-cell-n'}
              x={labelW + i * cellW + cellW / 2}
              y={y + cellH / 2 + 3.5}
              textAnchor="middle"
            >
              {v}
            </text>
          )}
        </g>
      )
    })

  return (
    <div ref={ref} className="pj-activity">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Sessions active per project per day, last 14 days">
        {shown.map((r, ri) => {
          const y = ri * (cellH + gap)
          return (
            <g key={r.id}>
              <g {...peekTarget('projects', { project: r.id }, `${r.name}: ${r.total} session-days`)}>
                <rect className="hc-hit" x={0} y={y} width={labelW - 6} height={cellH} />
                <text className="pj-row-label" x={0} y={y + cellH / 2 + 4}>
                  {r.name.length > 16 ? `${r.name.slice(0, 15)}…` : r.name}
                </text>
              </g>
              {cells(r.days, y, max)}
              <text className="hc-value" x={W} y={y + cellH / 2 + 4} textAnchor="end">
                {r.total}
              </text>
            </g>
          )
        })}
        <text className="pj-row-label pj-row-total" x={0} y={rowsH - cellH / 2 + 2}>
          All projects
        </text>
        {totals.map((v, i) => (
          <text
            key={i}
            className={`hc-value${i === totals.length - 1 ? ' pj-today' : ''}`}
            x={labelW + i * cellW + cellW / 2}
            y={rowsH - cellH / 2 + 2}
            textAnchor="middle"
          >
            {v}
          </text>
        ))}
        {labels.map(
          (l, i) =>
            (i % 3 === 0 && i < labels.length - 2) || i === labels.length - 1 ? (
              <text key={i} className="hc-axis" x={labelW + i * cellW + cellW / 2} y={H - 2} textAnchor="middle">
                {l}
              </text>
            ) : null,
        )}
        {totals.map((v, i) => (
          <rect
            key={i}
            className="hc-hit"
            x={labelW + i * cellW}
            y={0}
            width={cellW}
            height={rowsH}
            {...peekTarget('projects', { day: i }, `${labels[i]}: ${v} sessions active`)}
          >
            <title>{`${labels[i]}: ${v} sessions active`}</title>
          </rect>
        ))}
      </svg>
      <div className="sub pj-activity-sub">
        {sessionDays} session-days across {rows.length} projects · busiest: {busiest.join(', ')}
        {rows.length > shown.length && ` · ${rows.length - shown.length} quieter not shown`} · click a day
      </div>
    </div>
  )
}
