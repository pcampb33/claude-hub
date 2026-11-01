import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import type { DesktopSession, OutsideSession } from '../../../shared/ipc-types'
import { OutsideTile } from './OutsideTile'
import { Tile, type HeaderHandle } from './Tile'
import { GUTTER_PX, PRESET, cellArea, gutters, minFraction, outsideSessionIdOf, resizeTracks, trackTemplate, type Gutter } from './layout-model'
import type { Stage as StageModel } from './useStage'

const DRAG_TYPE = 'application/x-desk-tile'
const MIN_PX = { cols: 260, rows: 140 }
const KEY_STEP = 0.02

export interface OutsideViews {
  byId: Map<string, OutsideSession> // latest known record per Claude session id
  listError: string | null // set when the list couldn't be read just now
  busy: string | null // session id with a take-over in flight
  errors: Map<string, string> // take-over failures per session id
  onTakeOver: (sessionId: string, closeOld: boolean) => void
}

export function Stage({
  stage,
  sessions,
  nowMs,
  outside,
}: {
  stage: StageModel
  sessions: DesktopSession[]
  nowMs: number
  outside: OutsideViews
}) {
  const ref = useRef<HTMLElement>(null)
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const preset = PRESET[stage.layout]
  const max = stage.maximized
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropOn, setDropOn] = useState<number | null>(null)
  const [resizing, setResizing] = useState<Gutter | null>(null)

  const gridStyle: CSSProperties = max
    ? { gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1fr)' }
    : { gridTemplateColumns: trackTemplate(stage.tracks.cols), gridTemplateRows: trackTemplate(stage.tracks.rows) }
  const area = (i: number): CSSProperties => (max ? { gridColumn: '1', gridRow: '1' } : cellArea(preset.cells[i]))

  const handleFor = (i: number, id: string): HeaderHandle => ({
    draggable: !max && stage.onStage.length > 1,
    onDragStart: (e) => {
      if ((e.target as HTMLElement).closest('button, input')) {
        e.preventDefault()
        return
      }
      e.dataTransfer.setData(DRAG_TYPE, String(i))
      e.dataTransfer.effectAllowed = 'move'
      setDragFrom(i)
    },
    onDragEnd: () => {
      setDragFrom(null)
      setDropOn(null)
    },
    onDoubleClick: (e) => {
      if ((e.target as HTMLElement).closest('button, input')) return
      stage.toggleMaximize(id)
    },
  })

  // Escape restores a maximized tile, except where Escape already means
  // something: inside a terminal (Claude Code's interrupt), a field or a
  // dialog. An open tile menu stops it before it gets here.
  const { toggleMaximize } = stage
  useEffect(() => {
    if (!max) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t?.closest?.('.xterm, input, textarea, [role="dialog"]')) return
      toggleMaximize(max)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [max, toggleMaximize])

  // Tiles render in a fixed (id) order and are placed by grid area, so a swap
  // or a maximize moves no DOM node and no terminal remounts.
  const placed = stage.onStage.map((id, i) => ({ id, i })).sort((a, b) => (a.id < b.id ? -1 : 1))
  const empties = max ? [] : preset.cells.map((_, i) => i).filter((i) => i >= stage.onStage.length)

  return (
    <section
      ref={ref}
      className={`desk-stage${resizing ? ` resizing-${resizing.axis}` : ''}${dragFrom !== null ? ' dragging' : ''}`}
      style={gridStyle}
      aria-label="Stage"
    >
      {empties.map((i) => (
        <div key={`empty-${i}`} className="desk-cell-empty" style={area(i)}>
          Pick a session from the dock to put it here.
        </div>
      ))}
      {placed.map(({ id, i }) => {
        const hidden = max !== null && max !== id
        const sid = outsideSessionIdOf(id)
        const s = sid === null ? byId.get(id) : undefined
        if (sid === null && !s) return null
        return (
          <div
            key={id}
            className={`desk-cell${hidden ? ' hidden' : ''}${dropOn === i && dragFrom !== i ? ' drop' : ''}`}
            style={area(i)}
            onDragOver={(e) => {
              if (dragFrom === null || !e.dataTransfer.types.includes(DRAG_TYPE)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (dropOn !== i) setDropOn(i)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null) && dropOn === i) setDropOn(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragFrom !== null) stage.swap(dragFrom, i)
              setDragFrom(null)
              setDropOn(null)
            }}
          >
            {sid !== null ? (
              <OutsideTile
                sessionId={sid}
                session={outside.byId.get(sid)}
                listError={outside.listError}
                active={!hidden}
                handle={handleFor(i, id)}
                maximized={max === id}
                onRestore={() => stage.toggleMaximize(id)}
                busy={outside.busy === sid}
                takeOverError={outside.errors.get(sid) ?? null}
                onTakeOver={(closeOld) => outside.onTakeOver(sid, closeOld)}
                onClose={() => stage.remove(id)}
              />
            ) : (
              <Tile
                session={s!}
                nowMs={nowMs}
                focused={id === stage.focusedId}
                focusToken={stage.focusToken}
                onFocus={() => {
                  if (id !== stage.focusedId) stage.noteFocus(id)
                }}
                handle={handleFor(i, id)}
                arrange={{
                  maximized: max === id,
                  canMoveLeft: i > 0,
                  canMoveRight: i < stage.onStage.length - 1,
                  onMove: (dir) => stage.move(id, dir),
                  onToggleMaximize: () => stage.toggleMaximize(id),
                }}
              />
            )}
          </div>
        )
      })}
      {!max &&
        gutters(stage.layout).map((g) => (
          <GutterHandle
            key={`${g.axis}-${g.index}`}
            gutter={g}
            fracs={stage.tracks[g.axis]}
            stageRef={ref}
            onChange={(f) => stage.setAxis(g.axis, f)}
            onReset={() => stage.resetAxis(g.axis)}
            active={resizing?.axis === g.axis && resizing.index === g.index}
            onDragging={(on) => setResizing(on ? g : null)}
          />
        ))}
    </section>
  )
}

// A draggable boundary between two columns or rows. Pointer drag resizes
// live; arrow keys step it; double-click evens that axis out again.
function GutterHandle({
  gutter,
  fracs,
  stageRef,
  onChange,
  onReset,
  active,
  onDragging,
}: {
  gutter: Gutter
  active: boolean
  fracs: number[]
  stageRef: RefObject<HTMLElement>
  onChange: (fracs: number[]) => void
  onReset: () => void
  onDragging: (on: boolean) => void
}) {
  const { axis, index } = gutter
  const drag = useRef<{ start: number; fracs: number[]; available: number } | null>(null)
  const available = () => {
    const rect = stageRef.current?.getBoundingClientRect()
    const size = rect ? (axis === 'cols' ? rect.width : rect.height) : 0
    return size - GUTTER_PX * (fracs.length - 1)
  }
  const pos = (e: PointerEvent) => (axis === 'cols' ? e.clientX : e.clientY)
  const min = (avail: number) => minFraction(MIN_PX[axis], avail, fracs.length)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const back = axis === 'cols' ? 'ArrowLeft' : 'ArrowUp'
    const fwd = axis === 'cols' ? 'ArrowRight' : 'ArrowDown'
    if (e.key !== back && e.key !== fwd) return
    e.preventDefault()
    onChange(resizeTracks(fracs, index, e.key === fwd ? KEY_STEP : -KEY_STEP, min(available())))
  }

  return (
    <div
      className={`desk-gutter desk-gutter-${axis}${active ? ' active' : ''}`}
      style={{ gridColumn: gutter.gridColumn, gridRow: gutter.gridRow }}
      role="separator"
      aria-orientation={axis === 'cols' ? 'vertical' : 'horizontal'}
      aria-label={axis === 'cols' ? 'Resize columns' : 'Resize rows'}
      aria-valuenow={Math.round(fracs[index] * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      title="Drag to resize · double-click to even out"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { start: pos(e), fracs, available: available() }
        onDragging(true)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || d.available <= 0) return
        onChange(resizeTracks(d.fracs, index, (pos(e) - d.start) / d.available, min(d.available)))
      }}
      onPointerUp={(e) => {
        if (!drag.current) return
        drag.current = null
        e.currentTarget.releasePointerCapture(e.pointerId)
        onDragging(false)
      }}
      onLostPointerCapture={() => {
        if (drag.current) {
          drag.current = null
          onDragging(false)
        }
      }}
    />
  )
}
