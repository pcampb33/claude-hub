import { useMemo, useRef, useState } from 'react'
import type { UsageGranularity, UsageSeries } from '../../../shared/ipc-types'
import { ViewHeader, RefreshAction } from '../shared/ViewHeader'
import { ErrorNotice } from '../shared/ErrorNotice'
import { EmptyState } from '../shared/EmptyState'
import { usePersistentState } from '../shared/usePersistentState'
import { useReportLoading } from '../shared/appLoading'
import { useUsage, type DrillTarget } from './useUsage'
import { UsageChart } from './UsageChart'
import { UsageTable } from './UsageTable'
import { SessionDrill } from './SessionDrill'
import { Headline, IndexingProgress, Legend, Toggle } from './parts'
import { assignSlots, GRANULARITIES, METRICS, nextPeriodStart, OTHER_KEY, periodTitle, pickSeries, type Metric } from './model'
import './usage.css'

export function UsageView() {
  const [granularity, setGranularity] = usePersistentState<UsageGranularity>('usage:granularity', 'day')
  const [metric, setMetric] = usePersistentState<Metric>('usage:metric', 'processed')
  const g = GRANULARITIES.find((x) => x.key === granularity) ?? GRANULARITIES[1]
  const { state, refreshing, reload } = useUsage(g.key, g.periods)
  useReportLoading(state.status === 'loading')
  const [drill, setDrill] = useState<DrillTarget | null>(null)

  const report = state.data?.state === 'ready' ? state.data : undefined
  const { shown, rest } = useMemo(() => (report ? pickSeries(report, metric) : { shown: [], rest: [] }), [report, metric])
  const slotMemory = useRef(new Map<string, number>())
  const shownKeys = shown.map((s) => s.key).join('\n')
  const slots = useMemo(() => {
    slotMemory.current = assignSlots(shownKeys ? shownKeys.split('\n') : [], slotMemory.current)
    return slotMemory.current
  }, [shownKeys])
  const names = useMemo(() => new Map((report?.series ?? []).map((s) => [s.key, s.name])), [report])

  const changeGranularity = (k: UsageGranularity) => {
    setDrill(null)
    setGranularity(k)
  }
  const pickWindow = (s: UsageSeries) => {
    if (!report || report.buckets.length === 0) return
    const lastStart = report.buckets[report.buckets.length - 1].startIso
    setDrill({ key: s.key, name: s.name, startIso: report.buckets[0].startIso, endIso: nextPeriodStart(g.key, lastStart), label: g.span })
  }
  const pickBar = (key: string, i: number) => {
    if (!report || key === OTHER_KEY) return
    const start = report.buckets[i].startIso
    setDrill({ key, name: names.get(key) ?? key, startIso: start, endIso: nextPeriodStart(g.key, start), label: periodTitle(g.key, start) })
  }

  // Periods more than ~30 days before the first build are partial: Claude Code
  // had already deleted most of their transcripts.
  const since = report?.coverage.indexedSinceIso
  const completeFrom = since ? new Date(Date.parse(since) - 30 * 86_400_000) : null
  const historyCut = !!completeFrom && !!report?.buckets.length && Date.parse(report.buckets[0].startIso) < completeFrom.getTime()

  return (
    <section className="usage-view">
      <ViewHeader
        title="Usage"
        subtitle="Tokens processed per project, sandbox experiment and headless run, read from every transcript under ~/.claude/projects. Subagent transcripts count toward the session that started them."
        actions={<RefreshAction loading={refreshing} onClick={() => void reload()} />}
      />

      <div className="usage-controls">
        <Toggle label="Granularity" options={GRANULARITIES} value={g.key} onChange={changeGranularity} />
        <Toggle label="Metric" options={METRICS} value={metric} onChange={setMetric} />
      </div>

      {state.status === 'error' && <ErrorNotice message={`Couldn't read usage: ${state.error}`} onRetry={() => void reload()} />}
      {state.status === 'loading' && <div className="usage-skeleton" aria-busy="true" aria-label="Loading usage" />}
      {state.data?.state === 'indexing' && <IndexingProgress progress={state.data.progress} />}
      {state.data?.state === 'error' && (
        <ErrorNotice message={`Couldn't build the usage index: ${state.data.error}`} onRetry={() => void reload()} />
      )}

      {report && (
        <>
          {report.error && (
            <div className="usage-warn" role="status">
              The latest refresh failed ({report.error}); these numbers are from the last refresh that worked.
            </div>
          )}
          {report.coverage.filesUnreadable > 0 && (
            <div className="usage-warn" role="status">
              {report.coverage.filesUnreadable} transcript{report.coverage.filesUnreadable === 1 ? '' : 's'} (or folders of them)
              couldn't be read; totals may be low.
            </div>
          )}

          {report.series.length === 0 ? (
            <EmptyState title={`No responses in the ${g.span}.`} hint={`${report.coverage.filesIndexed} transcripts indexed.`} />
          ) : (
            <>
              <Headline report={report} span={g.span} />
              <div className="usage-card">
                <Legend report={report} metric={metric} shown={shown} rest={rest} slots={slots} onPick={pickWindow} />
                {shown.length > 0 ? (
                  <UsageChart report={report} granularity={g.key} metric={metric} shown={shown} names={names} slots={slots} onPick={pickBar} />
                ) : (
                  <div className="usage-drill-note">No {METRICS.find((m) => m.key === metric)?.label.toLowerCase()} in this window.</div>
                )}
              </div>
              {drill && <SessionDrill key={`${drill.key}|${drill.startIso}`} target={drill} onClose={() => setDrill(null)} />}
              <UsageTable report={report} metric={metric} slots={slots} selectedKey={drill?.key ?? null} onPick={pickWindow} />
            </>
          )}

          <p className="usage-caption">
            <strong>Processed</strong> counts input, cache-read, cache-write and output tokens for every response.
            Cache reads are most of it (re-sending the conversation each turn), and how rate limits weigh cached
            against fresh tokens isn't public, so treat shares as an estimate of what's eating your quota, not a bill.{' '}
            <strong>Active time</strong> is the minutes in which a session got a response, added up per session —
            parallel sessions each count.{' '}
            {historyCut && completeFrom && since && (
              <>
                Periods before about {completeFrom.toLocaleDateString()} are incomplete: Claude Code deletes transcripts
                after 30 days by default, and this index was first built on {new Date(since).toLocaleDateString()}. It
                keeps what it has read from then on.
              </>
            )}
          </p>
        </>
      )}
    </section>
  )
}
