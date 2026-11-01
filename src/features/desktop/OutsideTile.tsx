import { useEffect, useRef, useState } from 'react'
import type { OutsideSession } from '../../../shared/ipc-types'
import { SessionTranscript } from '../sessions/SessionTranscript'
import { OUTSIDE_STATUS, outsideLabel } from './launcher-model'
import { RestoreButton, type HeaderHandle } from './Tile'
import { useOutsideTranscript } from './useLaunchTargets'

// A session running in another terminal, shown read-only on the stage: its
// conversation, re-read every few seconds, under a Take over bar.
export function OutsideTile({
  sessionId,
  session,
  listError,
  active,
  handle,
  maximized,
  onRestore,
  busy,
  takeOverError,
  onTakeOver,
  onClose,
}: {
  sessionId: string
  // The latest record for it; undefined when the outside list couldn't be
  // read and it was never seen this visit.
  session: OutsideSession | undefined
  // Non-null when the outside list couldn't be read just now, so status and
  // "still running" are as last seen.
  listError: string | null
  active: boolean
  handle: HeaderHandle
  maximized: boolean
  onRestore: () => void
  busy: boolean
  takeOverError: string | null
  onTakeOver: (closeOld: boolean) => void
  onClose: () => void
}) {
  const transcript = useOutsideTranscript(session?.cwd ?? null, sessionId, active)
  const [closeOld, setCloseOld] = useState(true)
  const { name, where } = session ? outsideLabel(session) : { name: 'Session in another terminal', where: 'folder unknown' }
  const canTakeOver = !!session?.target

  // Follow the conversation while the reader is at the bottom.
  const bodyRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const count = transcript.status === 'data' ? transcript.messages.length : 0
  useEffect(() => {
    const el = bodyRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [count])

  return (
    <article className="desk-tile desk-tile-outside" aria-label={`${name}, read-only, running in another terminal`}>
      <header className="desk-tile-head" {...handle}>
        <span className="desk-mono desk-mono-outside" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="2" y="3" width="12" height="10" rx="1.5" />
            <path d="M5 7l2 1.5L5 10" />
          </svg>
        </span>
        <span className="desk-tile-name">{name}</span>
        <span className="desk-tile-proj">{where}</span>
        <span className="desk-tile-right">
          <span className="desk-tile-meta">
            {session ? OUTSIDE_STATUS[session.status] : 'Status unknown'} · read-only
          </span>
          {maximized && <RestoreButton onRestore={onRestore} />}
          <button className="desk-icon-btn" aria-label={`Close the view of ${name}`} title="Close this view" onClick={onClose}>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </span>
      </header>
      <div className="desk-outside-body">
        <div className="desk-takeover">
          <span className="desk-takeover-what">
            Running in another terminal. You can read it here; take it over to type into it.
          </span>
          {canTakeOver ? (
            <>
              <label className="desk-takeover-close" title="Only if it's idle and verified; otherwise it keeps running and the conversation forks here.">
                <input type="checkbox" checked={closeOld} onChange={(e) => setCloseOld(e.target.checked)} />
                Close the old terminal
              </label>
              <button className="desk-btn primary" disabled={busy || !session} onClick={() => onTakeOver(closeOld)}>
                {busy ? 'Taking over…' : 'Take over'}
              </button>
            </>
          ) : (
            <span className="desk-faint">
              {session ? "Its folder isn't a registered project or sandbox experiment, so it can't be taken over." : ''}
            </span>
          )}
        </div>
        {takeOverError && (
          <div className="desk-outside-alert" role="alert">
            {takeOverError}
          </div>
        )}
        {listError && (
          <div className="desk-outside-alert quiet">
            Couldn't check whether it's still running ({listError}). Status is as last seen.
          </div>
        )}
        <div
          className="desk-outside-chat"
          ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {!session ? (
            <p className="session-loading">The outside session list couldn't be read, so this session's folder isn't known and its conversation can't be read.</p>
          ) : transcript.status === 'loading' ? (
            <p className="session-loading">Reading the conversation…</p>
          ) : transcript.status === 'error' ? (
            <p className="session-loading">Couldn't read this conversation: {transcript.error}</p>
          ) : transcript.messages.length === 0 ? (
            <p className="session-loading">No conversation recorded yet.</p>
          ) : (
            <SessionTranscript messages={transcript.messages} autoExpandTail />
          )}
        </div>
        {transcript.status === 'data' && transcript.refreshError && (
          <div className="desk-outside-alert quiet">Couldn't refresh ({transcript.refreshError}); showing the last read.</div>
        )}
      </div>
    </article>
  )
}
