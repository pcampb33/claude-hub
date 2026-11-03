import { useCallback, useEffect, useState } from 'react'
import type { WidgetId, WidgetSize } from './types'

// The board's layout: which widgets, in what order, at what size, and whether
// each one hides itself when it has nothing to say ("auto" = when-relevant).
// Persisted in localStorage — a layout you arranged should survive relaunch,
// unlike usePersistentState's sessionStorage.

export interface LayoutItem {
  id: WidgetId
  size: WidgetSize
  mode?: string
  auto: boolean
}

export type PresetId = 'focus' | 'balanced' | 'everything'

export interface Layout {
  preset: PresetId | 'custom'
  items: LayoutItem[]
}

export const PRESETS: Record<PresetId, { label: string; note: string; items: LayoutItem[] }> = {
  focus: {
    label: 'Focus',
    note: 'What needs you and what is running',
    items: [
      { id: 'needs', size: 'M', auto: false },
      { id: 'live', size: 'M', auto: false },
      { id: 'inbox', size: 'S', auto: true },
      { id: 'automation', size: 'S', auto: false },
      { id: 'capture', size: 'M', auto: false },
    ],
  },
  balanced: {
    label: 'Balanced',
    note: 'The default: health, work and the flywheel',
    items: [
      { id: 'needs', size: 'M', auto: false },
      { id: 'live', size: 'M', auto: false },
      { id: 'projects', size: 'L', auto: false },
      { id: 'automation', size: 'S', auto: false },
      { id: 'inbox', size: 'S', auto: true },
      { id: 'recall', size: 'S', auto: false },
      { id: 'launch', size: 'S', auto: false },
      // Always shown (2026-11-02, the user's call): weekly usage is worth a
      // glance at any level, not only once it projects past half.
      { id: 'pace', size: 'S', auto: false },
    ],
  },
  everything: {
    label: 'Everything',
    note: 'Every widget, always shown',
    items: [
      { id: 'needs', size: 'M', auto: false },
      { id: 'live', size: 'M', auto: false },
      { id: 'projects', size: 'L', auto: false },
      { id: 'automation', size: 'S', auto: false },
      { id: 'inbox', size: 'S', auto: false },
      { id: 'recall', size: 'S', auto: false },
      { id: 'pace', size: 'S', auto: false },
      { id: 'launch', size: 'S', auto: false },
      { id: 'capture', size: 'M', auto: false },
    ],
  },
}

const KEY = 'claude-hub:home-layout:v1'
const DEFAULT: Layout = { preset: 'balanced', items: PRESETS.balanced.items }

function load(valid: ReadonlySet<string>): Layout {
  try {
    return parseLayout(localStorage.getItem(KEY), valid)
  } catch {
    return DEFAULT // storage unreadable
  }
}

// The saved layout string → the layout to show. Exported for tests.
export function parseLayout(raw: string | null, valid: ReadonlySet<string>): Layout {
  try {
    if (raw) {
      const parsed = JSON.parse(raw) as Layout
      // A named preset is the preset as the code defines it now, not the copy
      // saved when it was picked, so a change to a preset reaches boards that
      // use it. Only a widget's mode (a view preference) carries over.
      if (parsed.preset && parsed.preset !== 'custom' && parsed.preset in PRESETS) {
        const modes = new Map((Array.isArray(parsed.items) ? parsed.items : []).map((i) => [i.id, i.mode]))
        const items = PRESETS[parsed.preset].items.map((i) => (modes.get(i.id) ? { ...i, mode: modes.get(i.id) } : i))
        return { preset: parsed.preset, items }
      }
      if (Array.isArray(parsed.items)) {
        // Drop widgets that no longer exist rather than failing the whole layout.
        return { preset: parsed.preset ?? 'custom', items: parsed.items.filter((i) => valid.has(i.id)) }
      }
    }
  } catch {
    // Corrupt — fall back to the default.
  }
  return DEFAULT
}

export function useHomeLayout(validIds: ReadonlySet<string>) {
  const [layout, setLayout] = useState<Layout>(() => load(validIds))

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(layout))
    } catch {
      // Not persisted; the layout still applies until relaunch.
    }
  }, [layout])

  const edit = useCallback((fn: (items: LayoutItem[]) => LayoutItem[]) => {
    setLayout((prev) => ({ preset: 'custom', items: fn(prev.items) }))
  }, [])

  return {
    layout,
    applyPreset: useCallback((id: PresetId) => setLayout({ preset: id, items: PRESETS[id].items }), []),
    reset: useCallback(() => setLayout(DEFAULT), []),
    setSize: useCallback(
      (id: WidgetId, size: WidgetSize) => edit((items) => items.map((i) => (i.id === id ? { ...i, size } : i))),
      [edit],
    ),
    // Mode is a view preference, not a layout change, so it keeps the preset.
    setMode: useCallback(
      (id: WidgetId, mode: string) =>
        setLayout((prev) => ({ ...prev, items: prev.items.map((i) => (i.id === id ? { ...i, mode } : i)) })),
      [],
    ),
    setAuto: useCallback(
      (id: WidgetId, auto: boolean) => edit((items) => items.map((i) => (i.id === id ? { ...i, auto } : i))),
      [edit],
    ),
    move: useCallback(
      (id: WidgetId, delta: -1 | 1) =>
        edit((items) => {
          const from = items.findIndex((i) => i.id === id)
          const to = from + delta
          if (from < 0 || to < 0 || to >= items.length) return items
          const next = items.slice()
          ;[next[from], next[to]] = [next[to], next[from]]
          return next
        }),
      [edit],
    ),
    remove: useCallback((id: WidgetId) => edit((items) => items.filter((i) => i.id !== id)), [edit]),
    add: useCallback(
      (id: WidgetId, size: WidgetSize) =>
        edit((items) => (items.some((i) => i.id === id) ? items : [...items, { id, size, auto: false }])),
      [edit],
    ),
  }
}
