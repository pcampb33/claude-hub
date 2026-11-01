import { useEffect, useRef, useState } from 'react'
import type { GlobalAutomation, JobFreshness, ProjectFloorStatus } from '../../../../../shared/ipc-types'
import { PeekContent } from '../../peek'
import { Actions, Big, Btn, Code, Empty, KV, Loading, Row, RowList, Sec, StatePill, Unreachable } from '../../parts'
import { usePeekTarget } from '../../peek-context'
import { KEYS, useFloorRead, useGlobalConfigRead, useJobFreshness } from '../../reads'
import type { DetailProps } from '../../types'
import { invalidateHubRead, type HubRead } from '../../useHubRead'
import { relativeTime } from '../../../shared/relative-time'
import { toast } from '../../../shared/toast'
import { useNavigate } from '../../../shared/useHashRoute'
import { useVerifyJobs } from '../../../shared/useVerifyJobs'
import {
  floorDayText,
  floorDayWord,
  freshnessFor,
  gradeTone,
  gradeWord,
  hourText,
  logGist,
  msText,
  runHour,
  shortLabel,
  spendText,
  whenText,
} from './model'
import './automation.css'

const CRUMB = 'Automation'

export function AutomationDetail({ ctx }: DetailProps) {
  if (ctx?.floor != null) return <FloorDetail floor={String(ctx.floor)} day={typeof ctx.day === 'number' ? ctx.day : null} />
  if (ctx?.item != null) return <JobDetail id={String(ctx.item)} />
  return <Overview />
}

function lastRun(iso: string | null): string {
  return iso ? `${relativeTime(iso, Date.now())} · ${whenText(iso)}` : 'no dated run on record'
}

// ---------------------------------------------------------------- overview --

function Overview() {
  const cfg = useGlobalConfigRead()
  const fresh = useJobFreshness()
  const floor = useFloorRead()
  const navigate = useNavigate()
  const peekTarget = usePeekTarget()

  const autos = [...(cfg.data?.automations ?? [])].sort(
    (a, b) => (b.lastRunIso ? Date.parse(b.lastRunIso) : 0) - (a.lastRunIso ? Date.parse(a.lastRunIso) : 0),
  )
  const floors = floor.data?.projects.filter((p) => p.verifyCommand) ?? []

  return (
    <PeekContent crumb={CRUMB} title="Hooks, jobs and floors">
      <Sec title="Latest from each">
        {cfg.status === 'loading' && <Loading rows={4} />}
        {cfg.status === 'error' && <Unreachable what="the hooks and scheduled jobs" error={cfg.error} onRetry={cfg.refresh} />}
        {cfg.data?.schedulerError && (
          <Unreachable what="Task Scheduler" error={cfg.data.schedulerError} onRetry={cfg.refresh} />
        )}
        {fresh.status === 'error' && <Unreachable what="the job logs" error={fresh.error} onRetry={fresh.refresh} />}
        {cfg.data && autos.length === 0 && <Empty title="No hooks or scheduled jobs found" />}
        {autos.length > 0 && (
          <RowList tall>
            {autos.map((a) => {
              const line = freshnessFor(a, fresh.data)?.lastLine
              return (
                <Row
                  key={a.id}
                  label={
                    <>
                      <StatePill tone={gradeTone(a.state)}>{shortLabel(a)}</StatePill>{' '}
                      <span className="sub">{line ? logGist(line) : a.detail}</span>
                    </>
                  }
                  figure={a.lastRunIso ? relativeTime(a.lastRunIso, Date.now()) : '—'}
                  target={peekTarget('automation', { item: a.id }, `${shortLabel(a)} details`)}
                />
              )
            })}
          </RowList>
        )}
      </Sec>
      <Sec title="Verify floors">
        {floor.status === 'loading' && <Loading rows={2} />}
        {floor.status === 'error' && <Unreachable what="the verify floors" error={floor.error} onRetry={floor.refresh} />}
        {floor.data && floors.length === 0 && <Empty title="No project has a verify command" />}
        {floors.length > 0 && (
          <RowList>
            {floors.map((p) => (
              <Row
                key={p.id}
                label={p.name}
                figure={streakText(p)}
                target={peekTarget('automation', { floor: p.id }, `${p.name} verify floor`)}
              />
            ))}
          </RowList>
        )}
      </Sec>
      <Sec bare>
        <p className="sub">
          Each grade comes from a work probe — the job’s own log or ledger — not from its configuration. Unknown
          means nothing could tell whether it ran.
        </p>
      </Sec>
      <Sec>
        <Actions>
          <Btn kind="primary" onClick={() => navigate('global')}>
            Open Settings
          </Btn>
        </Actions>
      </Sec>
    </PeekContent>
  )
}

function streakText(p: ProjectFloorStatus): string {
  if (!p.latest) return 'never run'
  if (!p.latest.ok) return `red · exit ${p.latest.exitCode ?? '?'}`
  return `${p.streakDays}-day streak`
}

// ---------------------------------------------------------------- one job ---

function JobDetail({ id }: { id: string }) {
  const cfg = useGlobalConfigRead()
  const fresh = useJobFreshness()
  const a = cfg.data?.automations.find((x) => x.id === id)

  if (!a) {
    return (
      <PeekContent crumb={CRUMB} title="Automation">
        <Sec>
          {cfg.status === 'loading' && <Loading rows={4} />}
          {cfg.status === 'error' && (
            <Unreachable what="the hooks and scheduled jobs" error={cfg.error} onRetry={cfg.refresh} />
          )}
          {cfg.status === 'data' && <Empty title="This automation is no longer configured" />}
        </Sec>
      </PeekContent>
    )
  }
  return <JobBody a={a} fresh={fresh} configError={cfg.status === 'error' ? cfg.error : null} />
}

function JobBody({
  a,
  fresh,
  configError,
}: {
  a: GlobalAutomation
  fresh: HubRead<JobFreshness[]>
  configError: string | null
}) {
  const navigate = useNavigate()
  const [running, setRunning] = useState(false)
  const f = freshnessFor(a, fresh.data)
  const at = a.kind === 'scheduled' ? runHour(a) : null

  const runNow = () => {
    if (!a.taskName) return
    setRunning(true)
    window.hubApi
      .runGlobalTask(a.taskName)
      .then(
        () => {
          toast.success(`${shortLabel(a)} ${a.running ? 'restarted' : 'started'}`)
          invalidateHubRead(KEYS.globalConfig)
          invalidateHubRead(KEYS.jobFreshness)
        },
        (err: unknown) => toast.error(`Couldn’t start ${shortLabel(a)}: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => setRunning(false))
  }

  const openLog = () => {
    if (!a.logId) return
    window.hubApi
      .openGlobalFile(a.logId)
      .catch((err: unknown) => toast.error(`Couldn’t open the log: ${err instanceof Error ? err.message : String(err)}`))
  }

  return (
    <PeekContent crumb={CRUMB} title={shortLabel(a)}>
      {configError && <Unreachable what="the latest grades (showing the last answer)" error={configError} />}
      <Sec>
        <div>
          <StatePill tone={gradeTone(a.state)}>{gradeWord(a.state)}</StatePill>
          {a.running && <span className="sub"> · running now</span>}
        </div>
        <p>{a.detail}</p>
      </Sec>
      <Sec title={a.kind === 'hook' ? 'Hook' : 'Scheduled job'}>
        <KV
          rows={[
            a.kind === 'hook'
              ? ['Runs on', `${a.trigger} · every session, every project`]
              : ['Next run', a.trigger.replace(/^next\s+/, '')],
            // Only worth a row when the dial could not read the schedule.
            ...(at?.from === 'last run'
              ? [['On the dial', `${hourText(at.hour)} (from its last start)`] as [string, string]]
              : []),
            ['Last ran', lastRun(a.lastRunIso)],
            ...(f?.hoursSince != null ? [['Log written', `${f.hoursSince.toFixed(1)}h ago`] as [string, string]] : []),
          ]}
        />
      </Sec>
      <Sec title="Last log line">
        {fresh.status === 'loading' && <Loading rows={1} />}
        {fresh.status === 'error' && <Unreachable what="the job logs" error={fresh.error} onRetry={fresh.refresh} />}
        {fresh.status === 'data' &&
          (!a.logId ? (
            <p className="sub">No log is probed for this automation.</p>
          ) : f?.lastLine ? (
            <Code>{f.lastLine}</Code>
          ) : (
            <p className="sub">{f ? f.detail : 'The log probe returned nothing for this automation.'}</p>
          ))}
      </Sec>
      {f && (
        <Sec title="Model spend">
          {f.spend ? (
            <KV
              rows={[
                ['Last 7 days', spendText(f.spend.week)],
                ['Last 30 days', spendText(f.spend.month)],
              ]}
            />
          ) : (
            <p className="sub">Unknown: the log could not be read.</p>
          )}
        </Sec>
      )}
      {a.warnings.length > 0 && (
        <Sec title="Warnings">
          <ul className="auto-warnings">
            {a.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Sec>
      )}
      {a.command && (
        <Sec title="Command">
          <Code>{a.command}</Code>
        </Sec>
      )}
      <Sec>
        <Actions>
          {a.taskName && (
            <Btn kind="primary" onClick={runNow} disabled={running}>
              {running ? 'Starting…' : a.running ? 'Restart' : 'Run now'}
            </Btn>
          )}
          {a.logId && <Btn onClick={openLog}>Open log</Btn>}
          <Btn onClick={() => navigate('global')}>Open Settings</Btn>
        </Actions>
      </Sec>
    </PeekContent>
  )
}

// -------------------------------------------------------------- one floor ---

function FloorDetail({ floor: key, day }: { floor: string; day: number | null }) {
  const floor = useFloorRead()
  const p = floor.data?.projects.find((x) => x.id === key || x.name === key)

  if (!p) {
    return (
      <PeekContent crumb={CRUMB} title="Verify floor">
        <Sec>
          {floor.status === 'loading' && <Loading rows={4} />}
          {floor.status === 'error' && <Unreachable what="the verify floors" error={floor.error} onRetry={floor.refresh} />}
          {floor.status === 'data' && <Empty title="That project is no longer registered" />}
        </Sec>
      </PeekContent>
    )
  }
  return <FloorBody p={p} day={day} readError={floor.status === 'error' ? floor.error : null} />
}

function FloorBody({ p, day, readError }: { p: ProjectFloorStatus; day: number | null; readError: string | null }) {
  const navigate = useNavigate()
  const peekTarget = usePeekTarget()
  const jobs = useVerifyJobs()
  const [starting, setStarting] = useState(false)
  const job = jobs.find((j) => j.projectId === p.id) ?? null
  const busy = starting || job != null
  const latest = p.latest

  // A run started from the Projects view (or one this peek reopened onto)
  // ends without our runVerify promise; its end is the push dropping the job.
  const hadJob = useRef(false)
  useEffect(() => {
    if (hadJob.current && !job) invalidateHubRead(KEYS.floor)
    hadJob.current = job != null
  }, [job])
  const shown = day != null ? p.days[day] : null

  const runVerify = () => {
    setStarting(true)
    window.hubApi
      .runVerify(p.id)
      .then(
        (report) => {
          const r = report.projects.find((x) => x.id === p.id)?.latest
          if (r?.ok) toast.success(`${p.name}: verify passed in ${msText(r.durationMs)}`)
          else toast.error(`${p.name}: verify failed${r ? ` (exit ${r.exitCode ?? '?'})` : ''}`)
          invalidateHubRead(KEYS.floor)
        },
        (err: unknown) => toast.error(`Couldn’t run verify: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => setStarting(false))
  }

  return (
    <PeekContent crumb={CRUMB} title={`Floor · ${p.name}`}>
      {readError && <Unreachable what="the latest floor status (showing the last answer)" error={readError} />}
      <Sec>
        <div className="auto-hero">
          <Big
            value={p.streakDays ?? '—'}
            tone={p.streakDays == null ? 'unknown' : p.streakDays === 0 ? 'danger' : 'ok'}
            caption={p.streakDays == null ? 'no runs recorded' : 'days green in a row'}
          />
          <Big value={latest ? msText(latest.durationMs) : '—'} caption="last run took" />
          <Big
            value={latest ? (latest.exitCode ?? '—') : '—'}
            tone={latest ? (latest.ok ? undefined : 'danger') : 'unknown'}
            caption="last exit code"
          />
        </div>
      </Sec>
      <Sec title="Last run">
        <KV
          rows={[
            [
              'Result',
              latest ? (
                <StatePill tone={latest.ok ? 'ok' : 'danger'}>{latest.ok ? 'passed' : 'failed'}</StatePill>
              ) : (
                <StatePill tone="unknown">never run</StatePill>
              ),
            ],
            ['When', lastRun(latest?.timestamp ?? null)],
            ['Command', p.verifyCommand ? <Code>{p.verifyCommand}</Code> : 'none set'],
          ]}
        />
      </Sec>
      <Sec title={`Last ${p.days.length} days`}>
        <div className="auto-strip">
          {p.days.map((d, i) => (
            <span
              key={d.date}
              className={`auto-cell d-${d.status}${i === day ? ' on' : ''}`}
              {...peekTarget('automation', { floor: p.id, day: i }, `${floorDayText(d.date)}: ${floorDayWord(d.status)}`)}
            >
              <i />
              <small>{floorDayText(d.date).split(' ').pop()}</small>
            </span>
          ))}
        </div>
        {shown && (
          <p className="sub">
            {floorDayText(shown.date)}: {floorDayWord(shown.status)}. The ledger keeps pass/fail, exit code and
            duration per run, not the output.
          </p>
        )}
      </Sec>
      {job && (
        <Sec title={`Running · started ${relativeTime(job.startedAt, Date.now())}`}>
          <Code>{job.outputTail || 'waiting for output…'}</Code>
        </Sec>
      )}
      <Sec>
        <Actions>
          <Btn kind="primary" onClick={runVerify} disabled={busy || !p.verifyCommand}>
            {busy ? 'Running…' : 'Run verify'}
          </Btn>
          {job && (
            <Btn
              kind="danger"
              onClick={() =>
                window.hubApi
                  .cancelVerifyJob(job.id)
                  .catch((err: unknown) =>
                    toast.error(`Couldn’t cancel: ${err instanceof Error ? err.message : String(err)}`),
                  )
              }
            >
              Cancel
            </Btn>
          )}
          <Btn onClick={() => navigate('projects', p.id)}>Open project</Btn>
        </Actions>
      </Sec>
    </PeekContent>
  )
}
