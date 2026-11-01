import { useContext, useEffect, useState } from 'react'
import { useSessions } from './useSessions'
import { SessionDetail } from './SessionDetail'
import { realModel, toolLeaf } from './transcript-model'
import { EmptyState } from '../shared/EmptyState'
import { ErrorNotice } from '../shared/ErrorNotice'
import { SkeletonList } from '../shared/Skeleton'
import { ListFilter } from '../shared/ListShell'
import { ViewHeader, RefreshAction } from '../shared/ViewHeader'
import { SessionsIcon } from '../shared/icons'
import { RouteParamContext, useNavigate } from '../shared/useHashRoute'
import { useIsNarrow } from '../shared/useIsNarrow'
import { useRovingRows } from '../shared/useRovingRows'
import { useReportLoading } from '../shared/appLoading'
import { relativeTime } from '../shared/relative-time'
import type { SessionListEntry } from '../../../shared/ipc-types'
import './sessions.css'

// The row's second line answers "which window is this?" — project, model,
// and what it is doing right now, in that order. Time and context % live in
// the row's fixed right rail, so the scanned values never truncate.
function metaLine(entry: SessionListEntry): string {
  const parts = [entry.projectName]
  const model = realModel(entry.model)
  if (model) parts.push(model.replace(/^claude-/, ''))
  if (entry.state === 'active') parts.push(entry.lastToolName ? `running ${toolLeaf(entry.lastToolName)}` : 'working')
  else parts.push(entry.state)
  return parts.join(' · ')
}

// Compact right-rail age: "now", "7m", "4h", "2d".
function shortAge(iso: string, nowMs: number): string {
  const rel = relativeTime(iso, nowMs)
  return rel === 'just now' ? 'now' : rel.replace(' ago', '')
}

function dayKey(iso: string, nowMs: number): 'today' | 'yesterday' | 'earlier' {
  const day = new Date(iso).toDateString()
  if (day === new Date(nowMs).toDateString()) return 'today'
  if (day === new Date(nowMs - 86_400_000).toDateString()) return 'yesterday'
  return 'earlier'
}

export function SessionsView() {
  const { entries, loading, error, refresh, remove } = useSessions()
  useReportLoading(loading)
  const selectedId = useContext(RouteParamContext)
  const navigate = useNavigate()
  const isNarrow = useIsNarrow()

  // Row clocks ("idle 12m") advance between refreshes on their own.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const list = entries ?? []
  const explicit = list.find((e) => e.sessionId === selectedId) ?? null
  // A deep link (Search's "Continue in Sessions") can point past the recent
  // window this list is capped to — falling back to list[0] there would
  // silently show the WRONG session's transcript. The newest-session default
  // applies only when no session was asked for.
  const missing = !!selectedId && entries !== null && !explicit
  const selected = selectedId ? explicit : isNarrow ? null : (list[0] ?? null)

  // Client-side narrowing over title/project — 40 near-identical "continue"
  // rows are unscannable without it.
  const [filter, setFilter] = useState('')
  // Scoped to the rows container, not the whole master column: the filter
  // input above it keeps the browser's own ↑/↓ caret behaviour untouched. The selector walks the day groups as one list.
  const { listRef, onKeyDown } = useRovingRows('.session-master-row')
  const needle = filter.trim().toLowerCase()
  const visible = needle
    ? list.filter((e) => e.title.toLowerCase().includes(needle) || e.projectName.toLowerCase().includes(needle))
    : list

  const ended = visible.filter((e) => e.state === 'ended')
  const groups = [
    { key: 'live', label: 'Live', items: visible.filter((e) => e.state !== 'ended') },
    { key: 'today', label: 'Today', items: ended.filter((e) => dayKey(e.date, nowMs) === 'today') },
    { key: 'yesterday', label: 'Yesterday', items: ended.filter((e) => dayKey(e.date, nowMs) === 'yesterday') },
    { key: 'earlier', label: 'Earlier', items: ended.filter((e) => dayKey(e.date, nowMs) === 'earlier') },
  ].filter((g) => g.items.length > 0)

  return (
    <section className="sessions-view">
      <ViewHeader
        title="Sessions"
        subtitle="Every recent Claude Code session, with what it is doing right now. Read any transcript and its subagents here; resume an idle one in a terminal."
        actions={<RefreshAction loading={loading} onClick={() => refresh()} />}
      />

      {error && <ErrorNotice message={error} onRetry={() => refresh()} />}

      {loading && entries === null && (
        <div className="session-panes">
          <div className="session-master">
            <SkeletonList rows={5} />
          </div>
          <div className="skeleton session-detail-skeleton" />
        </div>
      )}

      {entries !== null && list.length === 0 && (
        <EmptyState
          glyph={<SessionsIcon />}
          title="No sessions yet"
          hint="Sessions from every registered project show up here as soon as one runs."
        />
      )}

      {list.length > 0 && (
        <div className="session-panes">
          {(!isNarrow || !selected) && (
            <div className="session-master-col">
              <ListFilter
                value={filter}
                onChange={setFilter}
                placeholder={`Filter ${list.length} sessions — title or project…`}
                count={visible.length}
                ariaLabel="Filter sessions"
              />
              <div className="session-master" ref={listRef} onKeyDown={onKeyDown}>
                {visible.length === 0 && (
                  <div className="session-master-empty">No sessions match “{filter}”.</div>
                )}
                {groups.map((group) => (
                  <div className="session-group" key={group.key}>
                    <div className="session-group-head">
                      <span>
                        {group.label} · {group.items.length}
                      </span>
                      {/* Column label for the right rail's percentages. A bare
                          "94%" down the edge of a session list is a number
                          with no claim attached — readers guessed at
                          completion. Labelling the column instead of each row
                          costs the meta line no width. */}
                      <span>context</span>
                    </div>
                    {group.items.map((entry) => (
                      <button
                        key={entry.sessionId}
                        className={`session-master-row${selected?.sessionId === entry.sessionId ? ' active' : ''}`}
                        onClick={() => navigate('sessions', entry.sessionId)}
                      >
                        <span className="session-master-top">
                          <span className={`session-pulse session-pulse-${entry.state}`} />
                          <span className="session-master-title">{entry.title}</span>
                          <span className="session-master-time">{shortAge(entry.date, nowMs)}</span>
                        </span>
                        <span className="session-master-meta">
                          <span className="session-master-meta-txt">{metaLine(entry)}</span>
                          {entry.contextPct !== undefined && (
                            <span
                              className={`session-master-ctx${entry.contextPct >= 40 ? ' hot' : ''}`}
                              title={`Context window ${entry.contextPct}% full`}
                            >
                              {entry.contextPct}%
                            </span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>

              {/* Knowledge's hint strip, class included — one strip and one CSS
                  rule across every master list, not a per-view variant. */}
              <div className="list-hint">
                <kbd>↑</kbd>
                <kbd>↓</kbd> move&ensp;<kbd>⏎</kbd> open
              </div>
            </div>
          )}

          {missing && (
            <div className="session-missing-notice">
              That session isn't in the recent window (newest {list.length}) — it may be older; its transcript is
              still readable from Search.
            </div>
          )}

          {selected && (
            <>
              {isNarrow && (
                <button className="drill-back" onClick={() => navigate('sessions')}>
                  ← All sessions
                </button>
              )}
              <SessionDetail
                key={selected.sessionId}
                entry={selected}
                // Only leave the detail pane when the delete actually landed —
                // on a failure the session is still there and still selected.
                onDelete={async (entry) => {
                  if (await remove(entry)) navigate('sessions')
                }}
              />
            </>
          )}
        </div>
      )}
    </section>
  )
}
