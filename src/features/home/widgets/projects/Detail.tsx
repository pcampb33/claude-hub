import type { ReactNode } from 'react'
import { PeekContent } from '../../peek'
import { usePeek, usePeekTarget } from '../../peek-context'
import { Actions, Btn, Code, Empty, KV, Loading, Row, RowList, Sec, StatePill, Unreachable } from '../../parts'
import { useActivity, useFloorRead, useLatestSessions, useProjects } from '../../reads'
import type { DetailProps } from '../../types'
import { relativeTime } from '../../../shared/relative-time'
import { floorState } from '../../../floor/useFloorStatus'
import { kTokens } from '../needs/needs-core'
import { useLive } from '../live/useLive'
import { Columns, HBars, Hero } from '../../charts'
import { runAction, useGo } from '../../actions'
import { MAP_SPAN_HOURS, activityRows, dayLabels, healthTone, hoursSince } from './projects-core'
import { useGitFan, useHealthFan } from './useProjectsData'
import type { ConfigHealthFinding, RegistryEntry } from '../../../../../shared/ipc-types'
import './projects.css'

export function ProjectsDetail({ ctx }: DetailProps) {
  if (ctx?.project != null) return <ProjectPeek id={String(ctx.project)} />
  if (ctx?.day != null) return <DayPeek day={Number(ctx.day)} />
  return <Overview quiet={ctx?.quiet != null} />
}

const CRUMB = 'Projects'

function Shell({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <PeekContent crumb={CRUMB} title={title}>
      <div className="peek-projects">{children}</div>
    </PeekContent>
  )
}

// ---- One project -----------------------------------------------------------

// Section-cost findings get a short gloss; the rest name a specific file or
// section, so their detail's first clause says more than any gloss could.
function findingText(f: ConfigHealthFinding): string {
  if (f.kind === 'oversized-section') return 'loaded into every session · could become a skill'
  if (f.kind === 'skill-shaped-candidate') return 'reads like a procedure · candidate skill'
  return f.detail.split(' — ')[0]
}

function ProjectPeek({ id }: { id: string }) {
  const projects = useProjects()
  if (projects.status === 'loading') return <Shell title="Project"><Loading rows={5} /></Shell>
  if (projects.status === 'error')
    return (
      <Shell title="Project">
        <Unreachable what="the project list" error={projects.error} onRetry={projects.refresh} />
      </Shell>
    )
  const entry = projects.data.find((p) => p.id === id)
  if (!entry)
    return (
      <Shell title="Project">
        <Sec>
          <Empty title="Not registered any more">This project was removed from the hub.</Empty>
        </Sec>
      </Shell>
    )
  return <ProjectBody entry={entry} />
}

function ProjectBody({ entry }: { entry: RegistryEntry }) {
  const health = useHealthFan()
  const latest = useLatestSessions()
  const activity = useActivity()
  const git = useGitFan()
  const floor = useFloorRead()
  const live = useLive()
  const go = useGo()
  const now = Date.now()

  const report = health.status === 'data' ? health.data.find((p) => p.id === entry.id)?.configHealth : undefined
  const last = latest.status === 'data' ? latest.data.find((s) => s.registryId === entry.id) : undefined
  const days = activity.status === 'data' ? activity.data.find((a) => a.registryId === entry.id)?.days : undefined
  const status = git.status === 'data' ? git.data.find((p) => p.id === entry.id)?.status : undefined
  const fl = floor.status === 'data' ? floor.data.projects.find((p) => p.id === entry.id) : undefined
  const liveEntry = live.status === 'data' ? live.snapshot.projects.find((p) => p.registryId === entry.id) : undefined
  const sid = liveEntry?.sessionId
  const running = liveEntry?.state === 'active'

  const pending = (s: { status: string }) => (s.status === 'loading' ? '…' : '—')
  const sinceHours = last ? hoursSince(last.timestamp, now) : null

  const findings = report ? [...report.findings].sort((a, b) => (b.estimatedTokens ?? -1) - (a.estimatedTokens ?? -1)).slice(0, 6) : []

  const latestRow: ReactNode =
    latest.status === 'error' ? (
      <span className="tone-warn">couldn’t read: {latest.error}</span>
    ) : latest.status === 'loading' ? (
      '…'
    ) : last ? (
      <>
        {last.title} <span className="sub">· {relativeTime(last.timestamp, now)}</span>
      </>
    ) : (
      <span className="sub">no session recorded</span>
    )

  const gitRows: [ReactNode, ReactNode][] =
    git.status === 'error'
      ? [['Git', <span className="tone-warn">couldn’t read: {git.error}</span>]]
      : git.status === 'loading' || !status
        ? [['Git', git.status === 'loading' ? '…' : <span className="sub">not reported</span>]]
        : !status.pathExists
          ? [['Git', <span className="tone-danger">the project path no longer exists</span>]]
          : !status.git
            ? [['Git', <span className="sub">not a git repo</span>]]
            : [
                [
                  'Git',
                  <>
                    <span className="pj-mono">{status.git.branch}</span> ·{' '}
                    {status.git.dirty ? <span className="tone-warn">uncommitted changes</span> : 'clean'}
                  </>,
                ],
                status.git.lastCommitMessage
                  ? [
                      'Last commit',
                      <>
                        <span className="pj-clamp">{status.git.lastCommitMessage}</span>
                        {status.git.lastCommitDate && (
                          <span className="sub"> · {relativeTime(status.git.lastCommitDate, now)}</span>
                        )}
                      </>,
                    ]
                  : ['Last commit', <span className="sub">none</span>],
              ]

  let floorRow: ReactNode
  if (floor.status === 'error') floorRow = <span className="tone-warn">couldn’t read: {floor.error}</span>
  else if (floor.status === 'loading') floorRow = '…'
  else if (!fl?.verifyCommand) floorRow = <span className="sub">none set</span>
  else {
    const st = floorState(fl, now)
    floorRow = (
      <>
        <Code>{fl.verifyCommand}</Code>
        <span className="pj-floor-line">
          <StatePill tone={st === 'green' ? 'ok' : st === 'red' ? 'danger' : 'unknown'}>{st}</StatePill>{' '}
          {fl.latest
            ? `${fl.streakDays ? `${fl.streakDays}-day green streak · ` : ''}last run ${relativeTime(fl.latest.timestamp, now)} · ${(fl.latest.durationMs / 1000).toFixed(1)}s`
            : 'never run'}
        </span>
      </>
    )
  }

  return (
    <Shell title={entry.name}>
      <Sec>
        <Hero
          cells={[
            {
              value: report ? report.score : pending(health),
              tone: report ? healthTone(report.score) : undefined,
              caption: health.status === 'error' ? 'CLAUDE.md health couldn’t be read' : 'CLAUDE.md health',
            },
            {
              value: report ? kTokens(report.combinedEstimatedTokens) : pending(health),
              caption: 'tokens loaded every session (MCP not measured)',
            },
            {
              value: sinceHours !== null ? relativeTime(last!.timestamp, now).replace(' ago', '') : pending(latest),
              caption:
                latest.status === 'error'
                  ? 'latest session couldn’t be read'
                  : sinceHours === null
                    ? 'no session recorded'
                    : 'since last session',
            },
          ]}
        />
      </Sec>

      <Sec title="What costs the most, highest first">
        {health.status === 'error' ? (
          <Unreachable what="CLAUDE.md health" error={health.error} onRetry={health.retry} />
        ) : health.status === 'loading' ? (
          <Loading rows={3} />
        ) : !report ? (
          <p className="sub">Not scored.</p>
        ) : findings.length === 0 ? (
          <p className="sub">No findings: nothing in this CLAUDE.md costs points.</p>
        ) : (
          <RowList tall>
            {findings.map((f) => (
              <Row
                key={f.id}
                label={
                  <span className="pj-finding">
                    <b>{f.sectionHeading ?? '(top of file)'}</b>
                    <span className="sub">
                      {findingText(f)}
                      {f.source === 'global' && ' · in the global CLAUDE.md'}
                    </span>
                  </span>
                }
                figure={f.estimatedTokens !== null ? `~${f.estimatedTokens} tok` : f.severity}
              />
            ))}
          </RowList>
        )}
      </Sec>

      <Sec title="Last 14 days">
        {activity.status === 'error' ? (
          <Unreachable what="activity" error={activity.error} onRetry={activity.refresh} />
        ) : activity.status === 'loading' ? (
          <Loading rows={2} />
        ) : days && days.some((v) => v > 0) ? (
          <Columns
            values={days}
            labels={dayLabels(now, days.length)}
            w={440}
            h={100}
            label={`${entry.name}: sessions active per day`}
            labelEvery={4}
            max={Math.max(4, ...days)}
            highlight={days.length - 1}
          />
        ) : (
          <p className="sub">No sessions in the last 14 days.</p>
        )}
      </Sec>

      <Sec title="State">
        <KV rows={[['Latest session', latestRow], ...gitRows, ['Verify floor', floorRow]]} />
      </Sec>

      <Sec bare>
        <Actions>
          <Btn kind="primary" onClick={() => runAction(() => window.hubApi.openClaudeMd(entry.id), 'open CLAUDE.md')}>
            Open CLAUDE.md
          </Btn>
          <Btn onClick={() => runAction(() => window.hubApi.openInVSCode(entry.id), 'open VS Code')}>Open in VS Code</Btn>
          <Btn onClick={() => runAction(() => window.hubApi.openTerminal(entry.id), 'open a terminal')}>Open terminal</Btn>
          <Btn
            disabled={!sid || running}
            title={
              running
                ? 'Its latest session is running right now'
                : !sid
                  ? live.status === 'error'
                    ? 'The latest session id couldn’t be read'
                    : 'No session to resume'
                  : undefined
            }
            onClick={() =>
              sid && runAction(() => window.hubApi.resumeSessionInTerminal(entry.id, sid), 'resume the session')
            }
          >
            Resume latest session
          </Btn>
          <Btn onClick={() => go('projects', entry.id)}>Open in Projects</Btn>
        </Actions>
      </Sec>
    </Shell>
  )
}

// ---- One day of activity ---------------------------------------------------

function DayPeek({ day }: { day: number }) {
  const activity = useActivity()
  const projects = useProjects()
  const peekTarget = usePeekTarget()
  const { open } = usePeek()
  const go = useGo()

  if (activity.status === 'error' || projects.status === 'error')
    return (
      <Shell title="Activity">
        {activity.status === 'error' && <Unreachable what="activity" error={activity.error} onRetry={activity.refresh} />}
        {projects.status === 'error' && (
          <Unreachable what="the project list" error={projects.error} onRetry={projects.refresh} />
        )}
      </Shell>
    )
  if (activity.status === 'loading' || projects.status === 'loading')
    return (
      <Shell title="Activity">
        <Loading rows={4} />
      </Shell>
    )

  const { rows, totals } = activityRows(activity.data, (id) => projects.data.find((p) => p.id === id)?.name)
  const labels = dayLabels(Date.now(), totals.length)
  const avg = totals.reduce((a, v) => a + v, 0) / totals.length
  const that = rows.filter((r) => r.days[day] > 0).sort((a, b) => b.days[day] - a.days[day])

  return (
    <Shell title={`Activity · ${labels[day]}`}>
      <Sec>
        <div className="big">{totals[day] ?? 0}</div>
        <div className="sub">
          sessions active {labels[day] === 'today' ? 'today' : `on ${labels[day]}`} · 14-day average {avg.toFixed(1)}
        </div>
      </Sec>
      <Sec title="By project (click one)">
        {that.length === 0 ? (
          <p className="sub">No sessions that day.</p>
        ) : (
          <HBars
            w={440}
            label={`Sessions by project on ${labels[day]}`}
            rows={that.map((r) => ({
              label: r.name,
              value: r.days[day],
              target: peekTarget('projects', { project: r.id }, `${r.name}: ${r.days[day]} sessions`),
            }))}
          />
        )}
      </Sec>
      <Sec title="Other days">
        <div className="pj-daypick">
          {labels.map((l, j) => (
            <button
              key={j}
              type="button"
              className="wbtn"
              aria-pressed={j === day}
              onClick={() => open('projects', { day: j })}
            >
              {l}
            </button>
          ))}
        </div>
      </Sec>
      <Sec bare>
        <Actions>
          <Btn kind="primary" onClick={() => go('sessions')}>
            Open Sessions
          </Btn>
        </Actions>
        <p className="sub">Sessions lists every recent session; it has no day filter yet.</p>
      </Sec>
    </Shell>
  )
}

// ---- Every project, least healthy first --------------------------------------

function Overview({ quiet }: { quiet: boolean }) {
  const health = useHealthFan()
  const latest = useLatestSessions()
  const activity = useActivity()
  const peekTarget = usePeekTarget()
  const go = useGo()
  const title = quiet ? 'No sessions in 30 days' : 'Projects, least healthy first'

  let body: ReactNode
  if (health.status === 'error') body = <Unreachable what="CLAUDE.md health" error={health.error} onRetry={health.retry} />
  else if (health.status === 'loading' || latest.status === 'loading') body = <Loading rows={6} />
  else {
    const now = Date.now()
    const lastById = latest.status === 'data' ? new Map(latest.data.map((s) => [s.registryId, s.timestamp])) : null
    const daysById = activity.status === 'data' ? new Map(activity.data.map((a) => [a.registryId, a.days])) : null
    const rows = [...health.data]
      .sort((a, b) => a.configHealth.score - b.configHealth.score)
      .filter((p) => {
        if (!quiet) return true
        const last = lastById?.get(p.id)
        return !last || hoursSince(last, now) > MAP_SPAN_HOURS
      })
    body = (
      <Sec>
        {latest.status === 'error' && <Unreachable what="latest sessions" error={latest.error} onRetry={latest.refresh} />}
        {activity.status === 'error' && <Unreachable what="activity" error={activity.error} onRetry={activity.refresh} />}
        <div className="pj-table">
          <div className="pj-tr pj-th" aria-hidden="true">
            <span>Project</span>
            <span>Health</span>
            <span>Tokens</span>
            <span>Last</span>
            <span>14d</span>
          </div>
          {rows.map((p) => {
            const last = lastById?.get(p.id)
            const days = daysById?.get(p.id)
            return (
              <div key={p.id} className="pj-tr pj-tr-go" {...peekTarget('projects', { project: p.id }, `${p.name}: health ${p.configHealth.score}, details`)}>
                <span>{p.name}</span>
                <span className={`tone-${healthTone(p.configHealth.score)}`}>{p.configHealth.score}</span>
                <span>~{kTokens(p.configHealth.combinedEstimatedTokens)}</span>
                <span>{lastById ? (last ? relativeTime(last, now) : 'none') : '—'}</span>
                <span>{daysById ? (days ? days.reduce((a, v) => a + v, 0) : 0) : '—'}</span>
              </div>
            )
          })}
        </div>
      </Sec>
    )
  }

  return (
    <Shell title={title}>
      {body}
      <Sec bare>
        <p className="sub">
          Health is the CLAUDE.md score: oversized sections, unconditional reads and skill-shaped procedures cost points.
          Tokens are what a project loads into every session, global CLAUDE.md included. 14d counts session-days.
        </p>
      </Sec>
      <Sec bare>
        <Actions>
          <Btn kind="primary" onClick={() => go('projects')}>
            Open Projects
          </Btn>
        </Actions>
      </Sec>
    </Shell>
  )
}
