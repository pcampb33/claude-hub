import { useCallback, useMemo, useRef, useState } from 'react'
import type { VaultEdge, VaultNote } from '../../../shared/ipc-types'
import { useTheme } from '../shared/theme'
import { isLightColor, tintCluster } from './community'
import { displayNoteTitle } from './note-title'

// The right pane at rest: three triage lenses over the already-loaded graph
// payload — Recent (birth time — mtime is rewritten by the linker), Most linked (edges, high first), Unlinked (no edges
// at all). Hovering or arrow-focusing a row lights its node in the canvas;
// opening swaps this pane for NoteDetail. Lenses, not a file manager — deep
// work still exits to Obsidian.
//
// Unlinked used to filter `n.project === null`, which is *unprojected*, not
// unlinked, so a note with no links appeared in no lens but Recent — the
// linker's own misses were the one thing hidden. The two link lenses now
// partition the corpus (edges > 0 and edges === 0), and the project-less count
// keeps its own home in the canvas legend.

type BrowseTab = 'recent' | 'linked' | 'unlinked'

// Same neutral the canvas paints unprojected nodes (LivingWebGraph).
const NEUTRAL_DOT = 'var(--text-faint)'

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function dateLabel(iso: string, now: Date): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  if (sameDay(d, now)) return 'today'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function BrowsePane({
  notes,
  edges,
  projectColors,
  onOpen,
  onHover,
}: {
  notes: VaultNote[]
  edges: VaultEdge[]
  projectColors: Map<string, string>
  onOpen: (id: string) => void
  onHover: (id: string | null) => void
}) {
  // Subscribing re-renders on a theme flip, so the dots re-tint for the new ground.
  useTheme()
  const light = isLightColor(getComputedStyle(document.documentElement).getPropertyValue('--bg-base'))
  const [tab, setTab] = useState<BrowseTab>('recent')
  const listRef = useRef<HTMLDivElement>(null)
  const now = new Date()

  // Degree over the edges the canvas actually draws, NOT shared/community's
  // nodeDegree(): that counts hand-authored [[wikilinks]] only — 17 of the
  // vault's 463 edges on 2026-08-22 — so "0" under it means "nobody typed a
  // wikilink" (183 of 205 notes), not "connected to nothing" (9 notes). Both
  // the ranking and the empty case have to mean the web on screen, or these
  // lenses answer a question about a graph nobody is looking at. LivingWebGraph
  // flags the same trap for its label rule; its node sizing still rides
  // authored degree.
  const degree = useMemo(() => {
    const counts = new Map(notes.map((n) => [n.id, 0]))
    for (const e of edges) {
      // An endpoint outside the note set (renamed/removed note) counts for nobody.
      if (counts.has(e.source)) counts.set(e.source, counts.get(e.source)! + 1)
      if (counts.has(e.target)) counts.set(e.target, counts.get(e.target)! + 1)
    }
    return counts
  }, [notes, edges])
  const deg = useCallback((n: VaultNote) => degree.get(n.id) ?? 0, [degree])

  const byRecency = (a: VaultNote, b: VaultNote) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  const unlinkedCount = useMemo(() => notes.filter((n) => deg(n) === 0).length, [notes, deg])
  const rows = useMemo(() => {
    if (tab === 'linked') return [...notes].sort((a, b) => deg(b) - deg(a) || byRecency(a, b)).filter((n) => deg(n) > 0)
    if (tab === 'unlinked') return notes.filter((n) => deg(n) === 0).sort(byRecency)
    return [...notes].sort(byRecency)
  }, [notes, tab, deg])

  // ↑/↓ walk the rows via roving focus; each focus lights the node (onHover
  // fires from focus as well as mouse), Enter clicks the focused button.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const rowEls = listRef.current?.querySelectorAll<HTMLButtonElement>('.b-row')
    if (!rowEls || rowEls.length === 0) return
    e.preventDefault()
    const current = Array.from(rowEls).indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'ArrowDown' ? Math.min(current + 1, rowEls.length - 1) : Math.max(current - 1, 0)
    rowEls[next]?.focus()
  }

  return (
    <aside className="browse-pane">
      <div className="browse-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'recent'}
          className={`browse-tab${tab === 'recent' ? ' active' : ''}`}
          onClick={() => setTab('recent')}
        >
          Recent
        </button>
        <button
          role="tab"
          aria-selected={tab === 'linked'}
          className={`browse-tab${tab === 'linked' ? ' active' : ''}`}
          onClick={() => setTab('linked')}
        >
          Most linked
        </button>
        <button
          role="tab"
          aria-selected={tab === 'unlinked'}
          className={`browse-tab${tab === 'unlinked' ? ' active' : ''}`}
          onClick={() => setTab('unlinked')}
        >
          Unlinked{unlinkedCount > 0 && <span className="browse-tab-n">{unlinkedCount}</span>}
        </button>
      </div>

      <div className="browse-list" ref={listRef} onKeyDown={onKeyDown}>
        {rows.length === 0 && <p className="browse-none">Nothing in this lens.</p>}
        {rows.map((n) => {
          const fresh = sameDay(new Date(n.createdAt), now)
          return (
            <button
              key={n.id}
              className={`b-row${fresh ? ' fresh' : ''}`}
              onClick={() => onOpen(n.id)}
              onMouseEnter={() => onHover(n.id)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(n.id)}
              onBlur={() => onHover(null)}
            >
              <span
                className="b-dot"
                style={{
                  backgroundColor: n.project
                    ? tintCluster(projectColors.get(n.project) ?? '', light) || NEUTRAL_DOT
                    : NEUTRAL_DOT,
                }}
              />
              <span className="b-title">{displayNoteTitle(n.title || n.id)}</span>
              <span className={`b-meta${fresh ? ' fresh' : ''}`}>
                {tab === 'linked' ? `${deg(n)} links` : dateLabel(n.createdAt, now)}
              </span>
            </button>
          )
        })}
      </div>

      <div className="list-hint list-hint-flush">
        <kbd>↑</kbd>
        <kbd>↓</kbd> move&ensp;<kbd>⏎</kbd> open — selecting a row lights its node; opening swaps this pane for the note
      </div>
    </aside>
  )
}
