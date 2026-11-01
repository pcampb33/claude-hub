import {
  Component,
  useMemo,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { usePeek } from './peek-context'
import { FrameContext } from './frame-context'
import type { LayoutItem } from './layout'
import type { WidgetDef, WidgetSize } from './types'

// The card around every widget: title (which opens the peek), mode switch,
// a meta line the widget reports, and — in Customize — the edit bar. Widgets
// render only their body and talk to the frame through two hooks.

class WidgetBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[claude-hub] widget render error:', error, info.componentStack)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="wd-error" role="alert">
        This widget failed to render: {this.state.error.message}
      </div>
    )
  }
}

const SPAN: Record<WidgetSize, number> = { S: 4, M: 6, L: 8, XL: 12 }
const INTERACTIVE = 'button, a, input, select, textarea, label, [data-peek], [role="button"]'

export interface FrameEdit {
  index: number
  count: number
  setSize: (size: WidgetSize) => void
  setAuto: (auto: boolean) => void
  move: (delta: -1 | 1) => void
  remove: () => void
}

export function WidgetFrame({
  def,
  item,
  editing,
  edit,
  onMode,
}: {
  def: WidgetDef
  item: LayoutItem
  editing: boolean
  edit: FrameEdit
  onMode: (mode: string) => void
}) {
  const { open } = usePeek()
  const [meta, setMeta] = useState<string | null>(null)
  const [relevant, setRelevant] = useState<boolean | null>(null)
  const api = useMemo(() => ({ setMeta, setRelevant }), [])
  const quiet = item.auto && relevant === false
  const mode = def.modes ? (item.mode && def.modes.includes(item.mode) ? item.mode : def.modes[0]) : undefined

  // Mouse convenience: a click on the card's empty space opens the overview.
  // Keyboard users get the title button; nested controls keep their own
  // clicks.
  const onCardClick = (e: MouseEvent<HTMLElement>) => {
    if (editing) return
    const hit = (e.target as HTMLElement).closest(INTERACTIVE)
    if (hit && e.currentTarget.contains(hit)) return
    open(def.id)
  }

  return (
    <FrameContext.Provider value={api}>
      <section
        className={`wd${quiet ? ' wd-quiet' : ''}`}
        data-size={item.size}
        data-widget={def.id}
        style={{ '--span': SPAN[item.size] } as CSSProperties}
        aria-label={def.title}
        hidden={quiet && !editing}
        onClick={onCardClick}
      >
        <div className="wd-head">
          <h3>
            <button type="button" className="wd-title" onClick={() => open(def.id)} disabled={editing}>
              {def.title}
            </button>
          </h3>
          {def.modes && !editing && (
            <div className="wd-modes" role="group" aria-label={`${def.title} view`}>
              {def.modes.map((m) => (
                <button key={m} type="button" className="wbtn" aria-pressed={m === mode} onClick={() => onMode(m)}>
                  {m}
                </button>
              ))}
            </div>
          )}
          {meta && <span className="wd-meta">{meta}</span>}
          {editing && (
            <div className="wd-edit" role="group" aria-label={`Arrange ${def.title}`}>
              {def.sizes.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="wbtn"
                  aria-pressed={s === item.size}
                  aria-label={`Size ${s}`}
                  onClick={() => edit.setSize(s)}
                >
                  {s}
                </button>
              ))}
              <button type="button" className="wbtn" aria-label="Move earlier" disabled={edit.index === 0} onClick={() => edit.move(-1)}>
                ←
              </button>
              <button
                type="button"
                className="wbtn"
                aria-label="Move later"
                disabled={edit.index === edit.count - 1}
                onClick={() => edit.move(1)}
              >
                →
              </button>
              {def.relevance && (
                <button
                  type="button"
                  className="wbtn"
                  aria-pressed={item.auto}
                  title={def.relevance}
                  onClick={() => edit.setAuto(!item.auto)}
                >
                  Auto
                </button>
              )}
              <button type="button" className="wbtn wbtn-x" aria-label={`Remove ${def.title}`} onClick={edit.remove}>
                ×
              </button>
            </div>
          )}
        </div>
        {editing && quiet && <div className="wd-hiddenwhy">Hidden right now · {def.relevance}</div>}
        <div className="wd-body">
          <WidgetBoundary>
            <def.Widget size={item.size} mode={mode} />
          </WidgetBoundary>
        </div>
      </section>
    </FrameContext.Provider>
  )
}
