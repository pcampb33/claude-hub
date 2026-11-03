import { PeekContent } from '../../peek'
import { usePeek } from '../../peek-context'
import { Actions, Btn, Code, Empty, KV, Loading, Row, RowList, Sec, Unreachable } from '../../parts'
import type { DetailProps } from '../../types'
import { formatElapsed, formatTokens } from '../../../live/format'
import { relativeTime } from '../../../shared/relative-time'
import { copyText } from '../../../shared/copy-text'
import { Hero } from '../../charts'
import { runAction, useGo } from '../../actions'
import {
  activitySentence,
  blockedOn,
  clockTime,
  stateLabel,
  findSession,
  formatSpan,
  liveSessions,
  modelLabel,
  roomLeft,
  sessionKey,
  whereTimeWent,
  ROOM_WINDOW,
} from './live-core'
import { Ribbon, RibbonLegend } from './Ribbon'
import { useLive, useNow } from './useLive'
import type { LiveProjectStatus } from '../../../../../shared/ipc-types'
import './live.css'

const CRUMB = 'Live sessions'

export function LiveDetail({ ctx }: DetailProps) {
  const live = useLive()
  const key = ctx?.session != null ? String(ctx.session) : null

  if (live.status !== 'data') {
    return (
      <PeekContent crumb={CRUMB} title="Live sessions">
        {live.status === 'loading' ? (
          <Loading rows={4} />
        ) : (
          <Unreachable what="live sessions" error={live.error} onRetry={live.retry} />
        )}
      </PeekContent>
    )
  }
  if (key) {
    const s = findSession(live.snapshot, key)
    if (s && s.state !== 'ended') return <SessionPeek s={s} />
    return <Gone />
  }
  return <Overview sessions={liveSessions(live.snapshot)} />
}

function Overview({ sessions }: { sessions: LiveProjectStatus[] }) {
  const { open } = usePeek()
  const go = useGo()
  return (
    <PeekContent crumb={CRUMB} title="Live sessions">
      {sessions.length === 0 ? (
        <Sec>
          <Empty title="No live sessions">Nothing has written to a transcript recently.</Empty>
        </Sec>
      ) : (
        <Sec>
          <RowList>
            {sessions.map((s) => (
              <Row
                key={s.registryId}
                label={
                  <>
                    <b>{s.name}</b> · {s.aiTitle ?? 'Untitled session'}
                  </>
                }
                figure={`${s.contextPct !== undefined ? `${s.contextPct}% · ` : ''}${stateLabel(s).word} ›`}
                target={{
                  role: 'button',
                  tabIndex: 0,
                  onClick: () => open('live', { session: sessionKey(s) }),
                  onKeyDown: (e: { key: string }) => e.key === 'Enter' && open('live', { session: sessionKey(s) }),
                }}
              />
            ))}
          </RowList>
        </Sec>
      )}
      <Sec bare>
        <p className="sub">Only sessions with recent transcript activity show here. Ended ones move to Sessions.</p>
      </Sec>
      <Sec bare>
        <Actions>
          <Btn kind="primary" onClick={() => go('sessions')}>
            Open Sessions
          </Btn>
        </Actions>
      </Sec>
    </PeekContent>
  )
}

function Gone() {
  const go = useGo()
  return (
    <PeekContent crumb={CRUMB} title="Session ended">
      <Sec>
        <Empty title="This session is no longer live">It ended or went quiet since you opened it.</Empty>
      </Sec>
      <Sec bare>
        <Actions>
          <Btn kind="primary" onClick={() => go('sessions')}>
            Open Sessions
          </Btn>
        </Actions>
      </Sec>
    </PeekContent>
  )
}

function SessionPeek({ s }: { s: LiveProjectStatus }) {
  const now = useNow(30_000)
  const go = useGo()
  // In use either way: a session waiting on a prompt still has its reader.
  const working = s.state === 'active' || s.state === 'waiting'
  const model = modelLabel(s.model)
  const room = roomLeft(s)
  const turns = s.recentTurns ?? []
  const a = s.activity
  const sid = s.sessionId

  const roomFigure = room.kind === 'estimate' ? `~${room.turns}` : '—'
  const roomCaption =
    room.kind === 'estimate'
      ? `turns of room at +${formatTokens(Math.round(room.perTurn))} a turn (estimate, last ${Math.min(turns.length, ROOM_WINDOW)} turns)`
      : room.kind === 'too-few'
        ? 'turns of room: needs 2+ turns to estimate'
        : room.kind === 'not-growing'
          ? 'turns of room: context isn’t growing (compacted?)'
          : 'turns of room: context size not reported'

  return (
    <PeekContent crumb={CRUMB} title={`${s.name} · ${stateLabel(s).word}`}>
      <div className="peek-live">
        <Sec bare>
          <div className="sub">
            {[
              model,
              s.sessionStart && `started ${new Date(s.sessionStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
              s.lastTimestamp && `last activity ${relativeTime(s.lastTimestamp, now)}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          <h4 className="live-peek-title">{s.aiTitle ?? 'Untitled session'}</h4>
        </Sec>
        <Sec>
          <Hero
            cells={[
              {
                value: s.contextPct !== undefined ? `${s.contextPct}%` : '—',
                caption: s.contextLimit !== undefined ? `of the ${formatTokens(s.contextLimit)} window` : 'window size not reported',
              },
              {
                value: s.contextTokens !== undefined ? formatTokens(s.contextTokens) : '—',
                caption: 'tokens in context',
              },
              { value: roomFigure, caption: roomCaption },
            ]}
          />
        </Sec>
        <Sec title="Where the time went">
          {a ? (
            <>
              {a.segments.length > 0 && (
                <>
                  <Ribbon a={a} big name={s.name} />
                  <div className="ribbon-ends">
                    <span>{clockTime(a.windowStartMs)}</span>
                    <span>{clockTime(a.endMs)}</span>
                  </div>
                  <RibbonLegend activities={[a]} />
                </>
              )}
              <p>{whereTimeWent(a)}</p>
              <p className="sub">
                {activitySentence(a, clockTime, blockedOn(s))}.{' '}
                {a.windowStartMs > a.startMs
                  ? `The strip shows the last ${formatSpan(a.endMs - a.windowStartMs)}; the totals cover the whole session since ${clockTime(a.startMs)}.`
                  : 'The strip and the totals cover the whole session.'}{' '}
                Edits count this transcript only, not its subagents’.
              </p>
            </>
          ) : (
            <p className="sub">
              {s.activityError
                ? `Couldn’t read the transcript for its timeline: ${s.activityError}`
                : 'Timeline not computed for this session.'}
            </p>
          )}
        </Sec>
        <Sec title="Session">
          <KV
            rows={[
              ['Project', s.name],
              ['Model', model ?? '—'],
              ['Elapsed', s.sessionStart ? formatElapsed(s.sessionStart, now) : '—'],
              ...(s.waitingFor ? ([['Waiting on', s.waitingFor]] as [string, string][]) : []),
              ['Last tool', s.lastToolName ?? '—'],
              ['Session ID', sid ? <Code>{sid}</Code> : '—'],
            ]}
          />
        </Sec>
        <Sec bare>
          <Actions>
            <Btn kind="primary" disabled={!sid} onClick={() => sid && go('sessions', sid)}>
              Open in Sessions
            </Btn>
            <Btn
              disabled={!sid || working}
              title={working ? 'It’s running right now. Resume is for idle or ended sessions.' : undefined}
              onClick={() =>
                sid && runAction(() => window.hubApi.resumeSessionInTerminal(s.registryId, sid), 'resume the session')
              }
            >
              Resume in terminal
            </Btn>
            {sid && (
              <Btn onClick={() => void copyText(sid, { success: 'Session ID copied', failure: 'Couldn’t copy the session ID' })}>
                Copy session ID
              </Btn>
            )}
          </Actions>
        </Sec>
      </div>
    </PeekContent>
  )
}
