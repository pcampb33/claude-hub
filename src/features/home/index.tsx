import { useEffect, useRef, useState } from 'react'
import { PRESETS, useHomeLayout, type PresetId } from './layout'
import { WidgetFrame } from './frame'
import { PeekProvider } from './peek'
import { usePeek } from './peek-context'
import { WIDGETS, WIDGET_IDS } from './registry'
import { NeedsHeadline } from './widgets/needs/Headline'
import type { WidgetId } from './types'
import './home.css'

// Home: a customisable widget board. Presets pick a layout; Customize adds,
// removes, resizes and reorders; when-relevant widgets hide themselves when
// they have nothing to say. Every widget opens a slide-over peek.
export function HomeView() {
  return (
    <PeekProvider>
      <HomeBoard />
      <PeekPanel />
    </PeekProvider>
  )
}

function HomeBoard() {
  const { layout, applyPreset, reset, setSize, setMode, setAuto, move, remove, add } = useHomeLayout(WIDGET_IDS)
  const [editing, setEditing] = useState(false)
  const shown = new Set(layout.items.map((i) => i.id))
  const library = (Object.keys(WIDGETS) as WidgetId[]).filter((id) => !shown.has(id))
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div className={`home${editing ? ' home-editing' : ''}`}>
      <header className="home-head">
        <div>
          <h2 className="home-headline">
            <NeedsHeadline />
          </h2>
          <div className="home-date">{today}</div>
        </div>
        <div className="home-tools">
          <label className="home-preset">
            <select
              aria-label="Layout preset"
              className="hbtn hbtn-ghost"
              value={layout.preset}
              onChange={(e) => applyPreset(e.target.value as PresetId)}
            >
              {(Object.keys(PRESETS) as PresetId[]).map((id) => (
                <option key={id} value={id}>
                  {PRESETS[id].label}
                </option>
              ))}
              {layout.preset === 'custom' && <option value="custom">Custom</option>}
            </select>
          </label>
          <button
            type="button"
            className={`hbtn ${editing ? 'hbtn-primary' : 'hbtn-ghost'}`}
            aria-pressed={editing}
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? 'Done' : 'Customize'}
          </button>
        </div>
      </header>

      <div className="home-workspace">
        <div className="board">
          {layout.items.map((item, index) => (
            <WidgetFrame
              key={item.id}
              def={WIDGETS[item.id]}
              item={item}
              editing={editing}
              onMode={(m) => setMode(item.id, m)}
              edit={{
                index,
                count: layout.items.length,
                setSize: (s) => setSize(item.id, s),
                setAuto: (a) => setAuto(item.id, a),
                move: (d) => move(item.id, d),
                remove: () => remove(item.id),
              }}
            />
          ))}
        </div>

        {editing && (
          <aside className="drawer" aria-label="Widget library">
            <h4>Widgets</h4>
            <p>Presets are starting points; any change makes the layout Custom.</p>
            <div className="drawer-presets">
              {(Object.keys(PRESETS) as PresetId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  className="li"
                  aria-pressed={layout.preset === id}
                  onClick={() => applyPreset(id)}
                >
                  <b>{PRESETS[id].label}</b>
                  <span>{PRESETS[id].note}</span>
                </button>
              ))}
            </div>
            <h4>Not on the board</h4>
            {library.length === 0 && <p>Every widget is on the board.</p>}
            <div className="lib">
              {library.map((id) => (
                <div key={id} className="li">
                  <b>{WIDGETS[id].title}</b>
                  <span>{WIDGETS[id].blurb}</span>
                  {WIDGETS[id].relevance && <span className="li-rule">{WIDGETS[id].relevance}</span>}
                  <button type="button" className="wbtn" onClick={() => add(id, WIDGETS[id].sizes[0])}>
                    Add
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="hbtn hbtn-ghost" onClick={reset}>
              Reset to Balanced
            </button>
          </aside>
        )}
      </div>
    </div>
  )
}

// The slide-over. Renders the open widget's Detail; Esc and the scrim close
// it; focus moves into it on open and back to the opener on close.
function PeekPanel() {
  const { state, close } = usePeek()
  const panelRef = useRef<HTMLDivElement>(null)
  const open = state !== null

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      // aria-modal: Tab cycles inside the panel instead of walking out to
      // the board behind the scrim.
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = [
          ...panelRef.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input, select, textarea, [tabindex="0"]',
          ),
        ]
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        const inside = panelRef.current.contains(document.activeElement)
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  // Focus the close button whenever the content changes (open or chain).
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [open, state])

  const Detail = state ? WIDGETS[state.widget].Detail : null
  return (
    <>
      <div className={`scrim${open ? ' open' : ''}`} onClick={close} aria-hidden="true" />
      <div
        ref={panelRef}
        className={`peek${open ? ' open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="peek-title"
        aria-hidden={!open}
      >
        {Detail && state && <Detail key={JSON.stringify(state)} ctx={state.ctx} />}
      </div>
    </>
  )
}
