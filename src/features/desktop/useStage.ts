import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DesktopSession, OutsideSession } from '../../../shared/ipc-types'
import { pickOnStage, reconcileStage, shrinkStage } from './desktop-model'
import {
  LEGACY_STAGE_KEY,
  STAGE_STORAGE_KEY,
  capacityOf,
  effectiveMaximized,
  moveCell,
  parseStageState,
  replaceOnStage,
  resetAxis as resetAxisIn,
  setTracks,
  stageCandidates,
  swapCells,
  toggleMaximize as toggleIn,
  tracksFor,
  type PresetKey,
  type StageState,
  type Tracks,
} from './layout-model'

function load(): StageState {
  try {
    return parseStageState(localStorage.getItem(STAGE_STORAGE_KEY), localStorage.getItem(LEGACY_STAGE_KEY))
  } catch {
    return parseStageState(null)
  }
}

export interface Stage {
  layout: PresetKey
  onStage: string[]
  tracks: Tracks // the current preset's
  maximized: string | null
  focusedId: string | null
  // Bumped on every pick, so the picked tile's terminal takes keyboard focus
  // even when it was already focused once.
  focusToken: number
  pick: (id: string) => void
  noteFocus: (id: string) => void
  setLayout: (layout: PresetKey) => void
  swap: (i: number, j: number) => void
  move: (id: string, dir: -1 | 1) => void
  replace: (oldId: string, newId: string) => void
  remove: (id: string) => void
  setAxis: (axis: 'cols' | 'rows', fracs: number[]) => void
  resetAxis: (axis: 'cols' | 'rows') => void
  toggleMaximize: (id: string) => void
}

// Which sessions are on stage, where, at what sizes, and which one has focus.
// `sessions` is null until the snapshot loads, so a not-yet-loaded list never
// empties the stage. `outside` is the snapshot's outside list (null =
// unreadable), which decides whether a read-only view still has a session.
export function useStage(sessions: DesktopSession[] | null, outside: OutsideSession[] | null): Stage {
  const [state, setState] = useState<StageState>(load)
  const [mru, setMru] = useState<string[]>(() => state.onStage)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [focusToken, setFocusToken] = useState(0)
  const [maximized, setMaximized] = useState<string | null>(null)

  const existing = useMemo(() => (sessions ? stageCandidates(sessions, state.onStage, outside) : null), [sessions, state.onStage, outside])

  // Drop gone sessions (forgotten, popped out, stopped outside) and fill free
  // tiles; stored, not derived, so a filled tile stays put when the dock
  // order later changes.
  useEffect(() => {
    if (!existing) return
    const next = reconcileStage(state.onStage, capacityOf(state.layout), existing, mru)
    if (next.length !== state.onStage.length || next.some((id, i) => id !== state.onStage[i])) {
      setState((s) => ({ ...s, onStage: next }))
    }
  }, [existing, state, mru])

  useEffect(() => {
    try {
      localStorage.setItem(STAGE_STORAGE_KEY, JSON.stringify(state))
    } catch {
      // Not persisted; the layout still works for this visit.
    }
  }, [state])

  const noteFocus = useCallback((id: string) => {
    setFocusedId(id)
    setMru((m) => [id, ...m.filter((x) => x !== id)])
  }, [])

  const pick = useCallback(
    (id: string) => {
      setState((s) => ({ ...s, onStage: pickOnStage(s.onStage, capacityOf(s.layout), id, mru) }))
      // Picking another tile while one is maximized shows the picked one.
      setMaximized((m) => (m && m !== id ? id : m))
      noteFocus(id)
      setFocusToken((t) => t + 1)
    },
    [mru, noteFocus],
  )

  const setLayout = useCallback(
    (layout: PresetKey) => {
      setState((s) => ({ ...s, layout, onStage: shrinkStage(s.onStage, capacityOf(layout), mru) }))
      setMaximized(null)
    },
    [mru],
  )

  const swap = useCallback((i: number, j: number) => setState((s) => ({ ...s, onStage: swapCells(s.onStage, i, j) })), [])
  const move = useCallback((id: string, dir: -1 | 1) => setState((s) => ({ ...s, onStage: moveCell(s.onStage, id, dir) })), [])
  const replace = useCallback(
    (oldId: string, newId: string) => {
      setState((s) => ({ ...s, onStage: replaceOnStage(s.onStage, oldId, newId) }))
      setMaximized((m) => (m === oldId ? newId : m))
      noteFocus(newId)
      setFocusToken((t) => t + 1)
    },
    [noteFocus],
  )
  const remove = useCallback((id: string) => {
    setState((s) => ({ ...s, onStage: s.onStage.filter((x) => x !== id) }))
    setMru((m) => m.filter((x) => x !== id))
  }, [])
  const setAxis = useCallback(
    (axis: 'cols' | 'rows', fracs: number[]) => setState((s) => ({ ...s, tracks: setTracks(s.tracks, s.layout, axis, fracs) })),
    [],
  )
  const resetAxis = useCallback((axis: 'cols' | 'rows') => setState((s) => ({ ...s, tracks: resetAxisIn(s.tracks, s.layout, axis) })), [])
  const toggleMaximize = useCallback((id: string) => setMaximized((m) => toggleIn(m, id)), [])

  const live = existing && focusedId && existing.includes(focusedId) ? focusedId : null
  return {
    layout: state.layout,
    onStage: state.onStage,
    tracks: tracksFor(state.tracks, state.layout),
    maximized: effectiveMaximized(state.onStage, maximized),
    focusedId: live,
    focusToken,
    pick,
    noteFocus,
    setLayout,
    swap,
    move,
    replace,
    remove,
    setAxis,
    resetAxis,
    toggleMaximize,
  }
}
