import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopSnapshot, OutsideSession } from '../../../shared/ipc-types'
import { EmptyState } from '../shared/EmptyState'
import { SessionsIcon } from '../shared/icons'
import { toast } from '../shared/toast'
import { DeskBar, NewSessionButton } from './DeskBar'
import { Dock, OutsideNote } from './Dock'
import { FORK_NOTE, Launcher, type Launched } from './Launcher'
import { Stage, type OutsideViews } from './Stage'
import { defaultColor, deskBody, errorText } from './desktop-model'
import { autoName, outsideRow } from './launcher-model'
import { outsideKey } from './layout-model'
import { useStage } from './useStage'


function useNowMs(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

export function Desk({ snapshot, onRetry }: { snapshot: DesktopSnapshot; onRetry: () => void }) {
  const { sessions, host, outside } = snapshot
  const stage = useStage(sessions, outside.sessions)
  const nowMs = useNowMs()
  const { pick, replace } = stage
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // The last record seen for each outside session, so a read-only view keeps
  // its folder and name through a moment when the list can't be read.
  const seenOutside = useRef(new Map<string, OutsideSession>())
  if (outside.sessions) for (const o of outside.sessions) seenOutside.current.set(o.sessionId, o)

  // A session popped out to its own window is focused there, not staged.
  const focusSession = useCallback(
    (id: string) => {
      const s = sessions.find((x) => x.id === id)
      if (s?.poppedOut) {
        window.hubApi.popOutDesktopSession(id).catch((err: unknown) => toast.error(`Couldn't show its window: ${errorText(err)}`))
      } else {
        pick(id)
      }
    },
    [sessions, pick],
  )

  // A session just created may reach us before or after the snapshot that
  // lists it; stage it once it is listed, so the stage never drops it. A
  // take-over replaces its read-only view in place.
  const [pending, setPending] = useState<{ id: string; replacing: string | null } | null>(null)
  useEffect(() => {
    if (pending && sessions.some((s) => s.id === pending.id)) {
      if (pending.replacing && stage.onStage.includes(pending.replacing)) replace(pending.replacing, pending.id)
      else pick(pending.id)
      setPending(null)
    }
  }, [pending, sessions, pick, replace, stage.onStage])

  const onLaunched = useCallback(({ session, replacing, note }: Launched) => {
    setLauncherOpen(false)
    setPending({ id: session.id, replacing })
    setNotice(note)
  }, [])

  // Take over from a read-only view on the stage, with the launcher's defaults.
  const [takeOverBusy, setTakeOverBusy] = useState<string | null>(null)
  const [takeOverErrors, setTakeOverErrors] = useState(new Map<string, string>())
  const takeOver = async (sessionId: string, closeOld: boolean) => {
    const o = seenOutside.current.get(sessionId)
    if (!o || takeOverBusy) return
    setTakeOverBusy(sessionId)
    setTakeOverErrors((m) => new Map([...m].filter(([k]) => k !== sessionId)))
    try {
      const result = await window.hubApi.takeOverSession(o.pid, o.sessionId, {
        name: autoName(outsideRow(o), sessions),
        color: defaultColor(sessions),
        closeOld,
      })
      onLaunched({ session: result.session, replacing: outsideKey(sessionId), note: result.closedOld ? null : (result.note ?? FORK_NOTE) })
    } catch (err) {
      setTakeOverErrors((m) => new Map(m).set(sessionId, `Couldn't take over the session: ${errorText(err)}`))
    } finally {
      setTakeOverBusy(null)
    }
  }

  // Alt+1..9 anywhere in the view: focus the session in that slot. Ctrl+N:
  // the launcher (the terminals pass it up rather than sending ^N).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.code === 'KeyN') {
        e.preventDefault()
        setLauncherOpen(true)
        return
      }
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const m = /^Digit([1-9])$/.exec(e.code)
      const target = m && sessions.find((s) => s.slot === Number(m[1]))
      if (!target) return
      e.preventDefault()
      focusSession(target.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessions, focusSession])

  const launcher = launcherOpen && (
    <Launcher sessions={sessions} outside={outside} onClose={() => setLauncherOpen(false)} onLaunched={onLaunched} />
  )

  const body = deskBody(snapshot)
  if (body === 'records-error') {
    return (
      <div className="desk">
        <div className="desk-empty">
          <div className="desk-records-error" role="alert">
            <h3 className="desk-records-error-title">The desktop can't read its sessions</h3>
            <p className="desk-records-error-what">{snapshot.records.error}</p>
            <p className="desk-faint">
              Until that's fixed the desktop can't list, start or change sessions. Sessions that were already running keep
              running. Fix the file named above in place (don't move or delete it: it holds every session's resume id), then
              retry.
            </p>
            <button className="btn btn-ghost" onClick={onRetry}>
              Retry
            </button>
          </div>
        </div>
      </div>
    )
  }

  const hostDown = host.state === 'down'
  const empty = body === 'empty'
  const outsideViews: OutsideViews = {
    byId: seenOutside.current,
    listError: outside.sessions === null ? (outside.error ?? 'unknown error') : null,
    busy: takeOverBusy,
    errors: takeOverErrors,
    onTakeOver: (sid, closeOld) => void takeOver(sid, closeOld),
  }

  return (
    <div className="desk">
      <DeskBar
        sessions={sessions}
        hostStarting={host.state === 'starting'}
        layout={stage.layout}
        onLayout={stage.setLayout}
        onNewSession={() => setLauncherOpen(true)}
      />
      {hostDown && !empty && (
        <div className="error-notice desk-host-down" role="alert">
          <span className="error-notice-message">
            Couldn't reach the session host{host.error ? `: ${host.error}` : '.'} The sessions below show their last known state.
          </span>
          <button className="btn btn-ghost error-notice-retry" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
      {notice && (
        <div className="desk-notice" role="status">
          <span>{notice}</span>
          <button className="desk-btn" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      {empty ? (
        <div className="desk-empty">
          <EmptyState
            glyph={<SessionsIcon />}
            title="Start a session"
            hint="Run Claude Code in a project or sandbox experiment, resume a recent conversation, or take over one running in another terminal. Its terminal stays on this desktop while you work elsewhere in the hub; Alt+1 to Alt+9 jump between sessions and Ctrl+N opens this launcher."
            action={<NewSessionButton onClick={() => setLauncherOpen(true)} />}
          />
          {hostDown && host.error && (
            <p className="desk-host-quiet">
              The session host isn't running ({host.error}). Starting a session will try to start it.
            </p>
          )}
          <div className="desk-empty-outside">
            <OutsideNote outside={outside} inEmptyState />
          </div>
        </div>
      ) : (
        <div className="desk-body">
          <Dock
            sessions={sessions}
            outside={outside}
            focusedId={stage.focusedId}
            onStage={stage.onStage}
            nowMs={nowMs}
            onPick={focusSession}
            onPickOutside={(sid) => pick(outsideKey(sid))}
          />
          <Stage stage={stage} sessions={sessions} nowMs={nowMs} outside={outsideViews} />
        </div>
      )}
      {launcher}
    </div>
  )
}
