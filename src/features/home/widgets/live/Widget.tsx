import { useWidgetMeta } from '../../frame-context'
import { usePeekTarget } from '../../peek-context'
import { Empty, Loading, StatePill, Track, Unreachable } from '../../parts'
import { formatElapsed, formatTokens } from '../../../live/format'
import { activitySentence, clockTime, liveMeta, liveSessions, modelLabel, sessionKey } from './live-core'
import { Ribbon, RibbonLegend } from './Ribbon'
import { useLive, useNow } from './useLive'
import type { LiveProjectStatus, SessionActivity } from '../../../../../shared/ipc-types'
import './live.css'

// Every running session: what it is doing, where its time went (the ribbon),
// and how full its context is. Each row opens that session's peek.
export function LiveWidget() {
  const live = useLive()
  const now = useNow(30_000)
  const sessions = live.status === 'data' ? liveSessions(live.snapshot) : []
  useWidgetMeta(live.status === 'data' ? liveMeta(sessions) : null)

  if (live.status === 'loading') return <Loading rows={2} />
  if (live.status === 'error') return <Unreachable what="live sessions" error={live.error} onRetry={live.retry} />
  if (sessions.length === 0)
    return <Empty title="No live sessions">Sessions with recent transcript activity show here.</Empty>

  return (
    <div className="live-list">
      {sessions.map((s) => (
        <LiveRow key={s.registryId} s={s} now={now} />
      ))}
      <RibbonLegend activities={sessions.map((s) => s.activity).filter((a): a is SessionActivity => a !== undefined)} />
    </div>
  )
}

function LiveRow({ s, now }: { s: LiveProjectStatus; now: number }) {
  const peekTarget = usePeekTarget()
  const working = s.state === 'active'
  const model = modelLabel(s.model)
  const title = s.aiTitle ?? 'Untitled session'
  return (
    <div className="lrow" {...peekTarget('live', { session: sessionKey(s) }, `${s.name}: ${title}, details`)}>
      <h4>{title}</h4>
      <div className="lrow-meta">
        <StatePill tone={working ? 'ok' : 'warn'}>{working ? 'working' : 'idle'}</StatePill>
        <span className="lrow-project">{s.name}</span>
        {s.sessionStart && <span>· {formatElapsed(s.sessionStart, now)}</span>}
        {model && <span>· {model}</span>}
      </div>
      {s.activity ? (
        <>
          {s.activity.segments.length > 0 && <Ribbon a={s.activity} name={s.name} />}
          <div className="lrow-says">{activitySentence(s.activity, clockTime)}</div>
        </>
      ) : (
        <div className="sub">
          {s.activityError ? `Couldn’t read the transcript for its timeline: ${s.activityError}` : 'Timeline not computed for this session'}
        </div>
      )}
      {s.contextPct !== undefined ? (
        <div className="lrow-ctx">
          <Track value={s.contextPct / 100} label={`${s.contextPct}% of the context window used`} />
          <span>
            {s.contextPct}%
            {s.contextTokens !== undefined && s.contextLimit !== undefined &&
              ` · ${formatTokens(s.contextTokens)} of ${formatTokens(s.contextLimit)}`}
          </span>
        </div>
      ) : (
        <div className="sub">Context size not reported yet</div>
      )}
    </div>
  )
}
