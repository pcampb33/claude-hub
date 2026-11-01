import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useTheme } from '../shared/theme'
import { toast } from '../shared/toast'
import { ChunkSequencer } from './desktop-model'

const FONT_FAMILY = "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace"
const ANSI = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

// The terminal palette lives in desktop.css as per-theme tokens; xterm paints
// to its own surface, so it needs them as values.
function readTermTheme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim() || undefined
  const theme: ITheme = {
    background: v('--desk-term-bg'),
    foreground: v('--desk-term-fg'),
    cursor: v('--desk-term-cursor'),
    cursorAccent: v('--desk-term-bg'),
    selectionBackground: v('--desk-term-selection'),
  }
  for (const name of ANSI) theme[name] = v(`--desk-ansi-${name}`)
  return theme
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export type ScreenSeed = { status: 'loading' } | { status: 'ready' } | { status: 'error'; error: string }

interface Props {
  id: string
  alive: boolean
  // Focus the terminal whenever this changes while `wantsFocus` holds.
  focusToken: number
  wantsFocus: boolean
  onFocus: () => void
  onSeed: (seed: ScreenSeed) => void
  // On the desktop, Alt+1..9 and Ctrl+N belong to the desktop; a pop-out
  // window has no desktop around it, so they reach Claude Code.
  desktopKeys?: boolean
}

// One live terminal. Seeding without gaps or duplicates: subscribe to output
// first and hold it, fetch the serialized screen, write it at the size it was
// taken, release the held chunks newer than it, then fit to the tile (which
// resizes the pty so Claude Code redraws for this width).
export function SessionTerminal({ id, alive, focusToken, wantsFocus, onFocus, onSeed, desktopKeys = true }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const aliveRef = useRef(alive)
  aliveRef.current = alive
  const wantsFocusRef = useRef(wantsFocus)
  wantsFocusRef.current = wantsFocus
  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus
  const onSeedRef = useRef(onSeed)
  onSeedRef.current = onSeed
  const desktopKeysRef = useRef(desktopKeys)
  desktopKeysRef.current = desktopKeys
  const [ioError, setIoError] = useState<string | null>(null)
  const [theme] = useTheme()

  useEffect(() => {
    const el = hostRef.current!
    let disposed = false
    let seeded = false
    let resizeTimer: ReturnType<typeof setTimeout> | undefined

    const term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      theme: readTermTheme(),
      disableStdin: !aliveRef.current,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    termRef.current = term

    const sequencer = new ChunkSequencer()
    const off = window.hubApi.onDesktopData((chunk) => {
      if (chunk.id !== id) return
      for (const data of sequencer.push(chunk)) term.write(data)
    })

    const send = (data: string) => {
      if (!aliveRef.current) return
      window.hubApi.desktopInput(id, data).then(
        () => setIoError(null),
        (err: unknown) => setIoError(`Couldn't send your input: ${message(err)}`),
      )
    }
    term.onData(send)
    term.onResize(({ cols, rows }) => {
      if (!seeded || !aliveRef.current) return
      window.hubApi.desktopResize(id, cols, rows).catch((err: unknown) => setIoError(`Couldn't resize the session: ${message(err)}`))
    })
    term.attachCustomKeyEventHandler((ev) => {
      const plain = !ev.ctrlKey && !ev.altKey && !ev.metaKey
      // Alt+1..9 belongs to the desktop (it focuses that slot); without this
      // xterm would also send ESC+digit to the session.
      if (desktopKeysRef.current && ev.altKey && !ev.ctrlKey && !ev.metaKey && /^Digit[1-9]$/.test(ev.code)) return false
      // Ctrl+N opens the desktop's launcher instead of sending ^N.
      if (desktopKeysRef.current && ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey && ev.code === 'KeyN') return false
      // Shift+Enter: ESC CR, which Claude Code reads as a newline, not submit.
      if (ev.key === 'Enter' && ev.shiftKey && plain) {
        if (ev.type === 'keydown') {
          ev.preventDefault()
          send('\x1b\r')
        }
        return false
      }
      if (ev.type !== 'keydown' || !ev.ctrlKey || ev.altKey || ev.metaKey) return true
      const key = ev.key.toLowerCase()
      // Ctrl+C copies a selection; with none it reaches Claude Code as usual.
      if (key === 'c' && !ev.shiftKey && term.hasSelection()) {
        ev.preventDefault()
        navigator.clipboard.writeText(term.getSelection()).catch(() => toast.error("Couldn't copy the selection"))
        term.clearSelection()
        return false
      }
      // Ctrl+V: let the browser raise its paste event, which xterm turns into
      // a (bracketed) paste; xterm would otherwise send ^V and cancel it.
      if (key === 'v') return false
      return true
    })

    const refit = () => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return
      fit.fit()
    }
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(refit, 100)
    })

    const start = async () => {
      // xterm measures the cell once at open; measuring a fallback font would
      // leave every glyph mis-spaced once the real one arrives.
      try {
        await document.fonts.load(`13px 'JetBrains Mono'`)
      } catch {
        // Fall back to whatever loaded.
      }
      if (disposed) return
      term.open(el)
      term.textarea?.addEventListener('focus', () => onFocusRef.current())
      if (wantsFocusRef.current) term.focus()
      observer.observe(el)
      try {
        const screen = await window.hubApi.getDesktopScreen(id)
        if (disposed) return
        term.resize(Math.max(screen.cols, 1), Math.max(screen.rows, 1))
        term.write(screen.data)
        for (const data of sequencer.seed(screen.seq)) term.write(data)
        onSeedRef.current({ status: 'ready' })
      } catch (err) {
        if (disposed) return
        for (const data of sequencer.seed(-Infinity)) term.write(data)
        onSeedRef.current({ status: 'error', error: message(err) })
      }
      seeded = true
      refit()
    }
    void start()

    return () => {
      disposed = true
      off()
      observer.disconnect()
      clearTimeout(resizeTimer)
      term.dispose()
      termRef.current = null
    }
  }, [id])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = readTermTheme()
  }, [theme])

  useEffect(() => {
    if (termRef.current) termRef.current.options.disableStdin = !alive
    if (!alive) setIoError(null)
  }, [alive])

  useEffect(() => {
    if (wantsFocus) termRef.current?.focus()
    // Only a new pick moves focus; a re-render must not steal it back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken])

  return (
    <div className="desk-term">
      <div className="desk-term-host" ref={hostRef} />
      {ioError && (
        <div className="desk-term-io" role="alert">
          {ioError}
        </div>
      )}
    </div>
  )
}
