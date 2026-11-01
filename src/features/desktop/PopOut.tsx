import { useEffect, useState } from 'react'
import { THEME_IDS, type ThemeId } from '../../../shared/ipc-types'
import { ToastHost } from '../shared/ToastHost'
import { applyTheme } from '../shared/theme'
import { SessionTerminal, type ScreenSeed } from './SessionTerminal'
import { StatePill } from './StatePill'
import { idColor, sessionTime } from './desktop-model'
import { useDesktop } from './useDesktop'
import './desktop.css'

// The route a popped-out session's window loads: #/desktop-tile/<id>.
export const POP_OUT_ROUTE = /^#\/desktop-tile\/(.+)$/

// One desktop session alone in its own window: a slim header and the live
// terminal, no rail or titlebar. Closing the window returns it to the stage
// (main does that).
export function PopOutTile({ id }: { id: string }) {
  const { state, retry } = useDesktop()
  const [seed, setSeed] = useState<ScreenSeed>({ status: 'loading' })
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // Follow theme changes made in the main window (same storage).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'claude-hub:theme' && THEME_IDS.includes(e.newValue as ThemeId)) applyTheme(e.newValue as ThemeId)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const s = state.status === 'data' ? state.snapshot.sessions.find((x) => x.id === id) : undefined
  useEffect(() => {
    document.title = s ? `${s.name} · ${s.targetName}` : 'Desktop session'
  }, [s])

  let body: JSX.Element
  if (state.status === 'loading') {
    body = <div className="desk-popout-msg">Loading the session…</div>
  } else if (state.status === 'error') {
    body = (
      <div className="desk-popout-msg" role="alert">
        <p>Couldn't load the session desktop: {state.error}</p>
        <button className="desk-btn" onClick={retry}>
          Retry
        </button>
      </div>
    )
  } else if (state.snapshot.records.error) {
    body = (
      <div className="desk-popout-msg" role="alert">
        The desktop can't read its sessions: {state.snapshot.records.error}
      </div>
    )
  } else if (!s) {
    body = <div className="desk-popout-msg">There's no session with this id on the desktop. It may have been forgotten; close this window.</div>
  } else if (!s.alive) {
    body = (
      <div className="desk-popout-msg">
        This session isn't running{s.exitCode !== null ? ` (it exited with code ${s.exitCode})` : ''}. Close this window and resume it from the
        desktop.
      </div>
    )
  } else {
    body = (
      <div className="desk-tile-body">
        <SessionTerminal id={s.id} alive={s.alive} focusToken={0} wantsFocus onFocus={() => {}} onSeed={setSeed} desktopKeys={false} />
        {seed.status === 'error' && (
          <div className="desk-term-io" role="alert">
            Couldn't load this session's screen ({seed.error}). Showing new output only.
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="desk-popout" style={s ? idColor(s.color) : undefined}>
      <header className="desk-popout-head">
        {s ? (
          <>
            <span className="desk-mono" aria-hidden="true">
              {s.slot}
            </span>
            <span className="desk-tile-name">{s.name}</span>
            <span className="desk-tile-proj">{s.targetName}</span>
            <StatePill state={s.state} />
            <span className="desk-tile-meta">
              {sessionTime(s, nowMs)} · {s.contextPct === null ? 'ctx —' : `ctx ${Math.round(s.contextPct)}%`}
            </span>
          </>
        ) : (
          <span className="desk-tile-name">Desktop session</span>
        )}
      </header>
      {body}
      <ToastHost />
    </div>
  )
}
