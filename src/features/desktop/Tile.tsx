import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { DESKTOP_COLORS, type DesktopSession } from '../../../shared/ipc-types'
import { toast } from '../shared/toast'
import { SessionTerminal, type ScreenSeed } from './SessionTerminal'
import { StatePill } from './StatePill'
import { TierChip } from '../shared/TierChip'
import { idColor, sessionTime } from './desktop-model'
import { useDismiss } from './useDismiss'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function act(label: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run()
    return true
  } catch (err) {
    toast.error(`Couldn't ${label}: ${message(err)}`)
    return false
  }
}

// What the stage hands a tile header: drag it onto another tile to swap,
// double-click it to maximize.
export interface HeaderHandle {
  draggable: boolean
  onDragStart: (e: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
  onDoubleClick: (e: MouseEvent<HTMLElement>) => void
}

export interface TileArrange {
  maximized: boolean
  canMoveLeft: boolean
  canMoveRight: boolean
  onMove: (dir: -1 | 1) => void
  onToggleMaximize: () => void
}

interface Props {
  session: DesktopSession
  nowMs: number
  focused: boolean
  focusToken: number
  onFocus: () => void
  handle: HeaderHandle
  arrange: TileArrange
}

export function Tile({ session, nowMs, focused, focusToken, onFocus, handle, arrange }: Props) {
  const s = session
  // A resumed session is a new process with a new screen: remount the
  // terminal so it seeds afresh. Exiting keeps the terminal, which still
  // shows the final output.
  const [generation, setGeneration] = useState(0)
  const [seed, setSeed] = useState<ScreenSeed>({ status: 'loading' })
  const wasAlive = useRef(s.alive)
  useEffect(() => {
    if (s.alive && !wasAlive.current) {
      setGeneration((g) => g + 1)
      setSeed({ status: 'loading' })
    }
    wasAlive.current = s.alive
  }, [s.alive])
  const [renaming, setRenaming] = useState(false)

  const ctx = s.contextPct === null ? 'ctx —' : `ctx ${Math.round(s.contextPct)}%`
  const screenGone = !s.alive && seed.status === 'error'

  return (
    <article
      className={`desk-tile${focused ? ' focused' : ''}${s.state === 'needs-you' ? ' needs' : ''}`}
      style={idColor(s.color)}
      onMouseDown={onFocus}
      aria-label={`${s.name}, ${s.targetName}`}
    >
      <header className="desk-tile-head" {...handle} draggable={handle.draggable && !renaming}>
        <span className="desk-mono" aria-hidden="true">
          {s.slot}
        </span>
        {renaming ? (
          <RenameField session={s} onDone={() => setRenaming(false)} />
        ) : (
          <span className="desk-tile-name">{s.name}</span>
        )}
        <span className="desk-tile-proj">{s.targetName}</span>
        {s.tier !== null && <TierChip tier={s.tier} />}
        <span className="desk-tile-right">
          <StatePill state={s.state} title={s.exitCode !== null ? `exit code ${s.exitCode}` : undefined} />
          <span className="desk-tile-meta" title={s.contextPct === null ? 'Context use not known' : undefined}>
            {sessionTime(s, nowMs)} · {ctx}
          </span>
          {arrange.maximized && <RestoreButton onRestore={arrange.onToggleMaximize} />}
          <TileMenu session={s} arrange={arrange} onRename={() => setRenaming(true)} />
        </span>
      </header>
      <div className="desk-tile-body">
        <SessionTerminal
          key={generation}
          id={s.id}
          alive={s.alive}
          focusToken={focusToken}
          wantsFocus={focused}
          onFocus={onFocus}
          onSeed={setSeed}
        />
        {s.alive && seed.status === 'error' && (
          <div className="desk-term-io" role="alert">
            Couldn't load this session's screen ({seed.error}). Showing new output only.
          </div>
        )}
        {screenGone && (
          <div className="desk-tile-gone">
            <p>This session's screen is gone.</p>
            <p className="desk-faint">{seed.error}</p>
          </div>
        )}
        {!s.alive && (
          <div className="desk-tile-ended">
            <span>Session ended{s.exitCode !== null ? ` (exit code ${s.exitCode})` : ''}.</span>
            <button className="desk-btn primary" onClick={() => void act('resume the session', () => window.hubApi.resumeDesktopSession(s.id))}>
              Resume
            </button>
          </div>
        )}
      </div>
    </article>
  )
}

// Shown on a maximized tile; Escape and double-clicking the header also restore.
export function RestoreButton({ onRestore }: { onRestore: () => void }) {
  return (
    <button className="desk-icon-btn" aria-label="Restore the layout" title="Restore the layout (Esc)" onClick={onRestore}>
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" />
      </svg>
    </button>
  )
}

function RenameField({ session, onDone }: { session: DesktopSession; onDone: () => void }) {
  const [value, setValue] = useState(session.name)
  // Unmounting a focused input fires blur; without this, Escape would still
  // commit and Enter would commit twice.
  const settled = useRef(false)
  const cancel = () => {
    settled.current = true
    onDone()
  }
  const commit = async () => {
    if (settled.current) return
    settled.current = true
    const name = value.trim()
    if (name && name !== session.name) await act('rename the session', () => window.hubApi.updateDesktopSession(session.id, { name }))
    onDone()
  }
  return (
    <input
      className="desk-rename"
      type="text"
      aria-label="Session name"
      value={value}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit()
        if (e.key === 'Escape') cancel()
      }}
      onBlur={() => void commit()}
    />
  )
}

function TileMenu({ session, arrange, onRename }: { session: DesktopSession; arrange: TileArrange; onRename: () => void }) {
  const s = session
  const [open, setOpen] = useState(false)
  const [armed, setArmed] = useState<'close' | 'forget' | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const close = () => {
    setOpen(false)
    setArmed(null)
  }
  useDismiss(ref, open, () => {
    close()
    buttonRef.current?.focus()
  })

  const run = (label: string, fn: () => Promise<unknown>) => {
    close()
    void act(label, fn)
  }

  return (
    <div className="desk-menu-wrap" ref={ref}>
      <button
        ref={buttonRef}
        className="desk-icon-btn"
        aria-label={`Session menu for ${s.name}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="12.5" cy="8" r="1.3" />
        </svg>
      </button>
      {open && (
        <div className="desk-menu" role="group" aria-label={`${s.name} actions`}>
          <button
            className="desk-menu-item"
            autoFocus
            onClick={() => {
              close()
              onRename()
            }}
          >
            Rename
          </button>
          <button
            className="desk-menu-item"
            onClick={() => {
              close()
              arrange.onToggleMaximize()
            }}
          >
            {arrange.maximized ? 'Restore' : 'Maximize'}
          </button>
          {!arrange.maximized && (arrange.canMoveLeft || arrange.canMoveRight) && (
            <div className="desk-menu-pair">
              <button
                className="desk-menu-item"
                disabled={!arrange.canMoveLeft}
                onClick={() => {
                  close()
                  arrange.onMove(-1)
                }}
              >
                Move left
              </button>
              <button
                className="desk-menu-item"
                disabled={!arrange.canMoveRight}
                onClick={() => {
                  close()
                  arrange.onMove(1)
                }}
              >
                Move right
              </button>
            </div>
          )}
          {s.alive && (
            <button className="desk-menu-item" onClick={() => run('pop out the session', () => window.hubApi.popOutDesktopSession(s.id))}>
              Pop out to its own window
            </button>
          )}
          <div className="desk-menu-sep" />
          <div className="desk-menu-label" id={`desk-colour-${s.id}`}>
            Colour
          </div>
          <div className="desk-swatches" role="radiogroup" aria-labelledby={`desk-colour-${s.id}`}>
            {DESKTOP_COLORS.map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={c === s.color}
                aria-label={c}
                className="desk-swatch"
                style={idColor(c)}
                onClick={() => run('change the colour', () => window.hubApi.updateDesktopSession(s.id, { color: c }))}
              />
            ))}
          </div>
          <div className="desk-menu-sep" />
          {s.alive ? (
            <button
              className={`desk-menu-item danger${armed === 'close' ? ' armed' : ''}`}
              onClick={() =>
                armed === 'close' ? run('close the session', () => window.hubApi.closeDesktopSession(s.id)) : setArmed('close')
              }
            >
              {armed === 'close' ? 'Confirm: end the process?' : 'Close session'}
            </button>
          ) : (
            <>
              <button className="desk-menu-item" onClick={() => run('resume the session', () => window.hubApi.resumeDesktopSession(s.id))}>
                Resume
              </button>
              <button
                className={`desk-menu-item danger${armed === 'forget' ? ' armed' : ''}`}
                onClick={() =>
                  armed === 'forget' ? run('forget the session', () => window.hubApi.forgetDesktopSession(s.id)) : setArmed('forget')
                }
              >
                {armed === 'forget' ? 'Confirm: remove from the desktop?' : 'Forget'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
