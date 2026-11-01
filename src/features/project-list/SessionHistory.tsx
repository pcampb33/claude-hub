import { useEffect, useState } from 'react'
import { useSessionHistory } from './useSessionHistory'
import { TranscriptView } from '../shared/TranscriptView'
import { ErrorNotice } from '../shared/ErrorNotice'
import { ConfirmButton } from '../shared/ConfirmButton'
import { displaySessionTitle, NO_SESSION_TITLE } from './session-title'

// Sessions are returned newest-first; long-lived projects accumulate
// hundreds, so only the most recent are shown until the user opts in. The
// full back-catalogue is reachable via global session search.
const INITIAL_SHOWN = 12

// Compact row timestamp — toLocaleString() printed the full
// "8/9/2026, 9:15:46 PM" on every row. Today's sessions need only the time;
// older ones a day qualifier ("yesterday 11:02 PM", "Aug 3, 11:02 PM").
function sessionDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (dayDiff === 0) return time
  if (dayDiff === 1) return `yesterday ${time}`
  const monthDay = d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return d.getFullYear() === now.getFullYear() ? `${monthDay}, ${time}` : `${monthDay} ${d.getFullYear()}, ${time}`
}

// A summary carries only the file's mtime, not a live state, so "written to
// in the last five minutes" (live-core's ACTIVE_WINDOW_MS) stands in for the
// Sessions view's active gate: trashing a transcript mid-turn is a write into
// a file still being written. Exit bookkeeping can bump mtime too, which only
// errs toward disabling the button for a few minutes.
const IN_USE_MS = 5 * 60 * 1000
function isBeingWritten(iso: string): boolean {
  return Date.now() - new Date(iso).getTime() < IN_USE_MS
}

// Auto-loads the (metadata-only, cheap) session summaries on mount — the
// parent remounts this per selected project via `key`, so the fetch reruns
// for each project. Clicking a row lazily loads that session's transcript.
export function SessionHistory({ projectPath, projectId }: { projectPath: string; projectId: string }) {
  const {
    sessions,
    loadingSessions,
    sessionsError,
    loadSessions,
    openSessionId,
    toggleSession,
    transcript,
    loadingTranscript,
    transcriptError,
    retryTranscript,
    deleteSession,
  } = useSessionHistory(projectPath, projectId)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  const shown = expanded ? sessions : sessions?.slice(0, INITIAL_SHOWN)
  const hiddenCount = sessions && !expanded ? sessions.length - (shown?.length ?? 0) : 0

  return (
    <div className="session-list">
      {loadingSessions && <div className="session-list-loading">Loading sessions…</div>}
      {sessionsError && (
        <ErrorNotice message={`Could not read this project's sessions: ${sessionsError}`} onRetry={loadSessions} />
      )}
      {/* Only claim "none" when the listing actually succeeded. */}
      {!sessionsError && sessions?.length === 0 && <div className="session-list-empty">No sessions found.</div>}
      {shown?.map((session) => (
        <div key={session.id} className="session-row">
          <button className="session-row-header" onClick={() => toggleSession(session.id)}>
            <span className={`session-row-caret${openSessionId === session.id ? ' open' : ''}`}>›</span>
            <span className={`session-row-title${session.title === NO_SESSION_TITLE ? ' untitled' : ''}`}>
              {displaySessionTitle(session.title)}
            </span>
            <span className="session-row-date">{sessionDate(session.date)}</span>
          </button>

          {openSessionId === session.id && (
            <div className="session-row-actions">
              <ConfirmButton
                label="Delete history"
                confirmLabel="Confirm — to recycle bin?"
                onConfirm={() => void deleteSession(session.id)}
                disabled={isBeingWritten(session.date)}
                title={
                  isBeingWritten(session.date)
                    ? 'This session was written to in the last few minutes — delete it once it goes quiet'
                    : `Sends this session's transcript and subagent logs to the recycle bin. It leaves Claude Code's own store, so "claude --resume ${session.id}" stops working too.`
                }
              />
            </div>
          )}
          {openSessionId === session.id &&
            (transcriptError ? (
              <ErrorNotice message={`Could not read this transcript: ${transcriptError}`} onRetry={retryTranscript} />
            ) : (
              <TranscriptView messages={transcript} loading={loadingTranscript} />
            ))}
        </div>
      ))}
      {hiddenCount > 0 && (
        <button className="session-list-more" onClick={() => setExpanded(true)}>
          Show all {sessions?.length} sessions
        </button>
      )}
    </div>
  )
}
