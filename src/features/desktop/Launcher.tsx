import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { DESKTOP_COLORS, type DesktopColor, type DesktopSession, type DesktopSnapshot } from '../../../shared/ipc-types'
import { relativeTime } from '../shared/relative-time'
import { defaultColor, errorText, idColor } from './desktop-model'
import { outsideKey } from './layout-model'
import {
  actionLabel,
  autoName,
  buildModel,
  chooseTab,
  emptyNote,
  GROUP_LABEL,
  launcherView,
  launchSpec,
  moveHighlight,
  navRows,
  visibleTabs,
  type GroupKey,
  type LauncherGroup,
  type LauncherRow,
} from './launcher-model'
import { useLaunchTargets } from './useLaunchTargets'

export interface Launched {
  session: DesktopSession
  replacing: string | null // the stage key of the read-only view it replaces
  note: string | null // say this after success (a take-over that forked)
}

export const FORK_NOTE = 'The old terminal kept running, so the conversation forked here under a new id.'

const TAB_KEY = 'claude-hub:desktop-launcher-tab'

function loadTab(): string | null {
  try {
    return localStorage.getItem(TAB_KEY)
  } catch {
    return null
  }
}

function saveTab(tab: GroupKey): void {
  try {
    localStorage.setItem(TAB_KEY, tab)
  } catch {
    // Not remembered; the launcher still opens on a sensible tab.
  }
}

// Opens a new session, resumes a recent conversation, or takes over one
// running in another terminal. A centered dialog: one search box, three tabs
// (a query searches all of them at once), ↑/↓ and Enter, name and colour in
// the footer.
export function Launcher({
  sessions,
  outside,
  onClose,
  onLaunched,
}: {
  sessions: DesktopSession[]
  outside: DesktopSnapshot['outside']
  onClose: () => void
  onLaunched: (launched: Launched) => void
}) {
  const targets = useLaunchTargets()
  const launch = targets.state.status === 'data' ? targets.state.data : null
  const loading = targets.state.status === 'loading'
  const model = useMemo(() => buildModel({ outside: outside.sessions, launch, sessions }), [outside.sessions, launch, sessions])

  const [query, setQuery] = useState('')
  const searching = query.trim() !== ''
  const [stored] = useState(loadTab)
  const [picked, setPicked] = useState<GroupKey | null>(null)
  const tabs = visibleTabs(model)
  const tab = chooseTab(model, picked, stored, loading)
  const [showAll, setShowAll] = useState<ReadonlySet<GroupKey>>(new Set())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const groups = launcherView(model, tab, query, showAll)
  const rows = navRows(groups, expanded)
  const [highlight, setHighlight] = useState<string | null>(null)
  const current = rows.find((r) => r.key === highlight) ?? rows[0] ?? null

  // Name and colour follow the highlighted row until edited; picking another
  // row puts them back on auto.
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [colorPick, setColorPick] = useState<DesktopColor | null>(null)
  useEffect(() => setNameDraft(null), [current?.key])
  const name = nameDraft ?? (current ? autoName(current, sessions) : '')
  const color = colorPick ?? defaultColor(sessions)
  const [closeOld, setCloseOld] = useState(true)
  const [busy, setBusy] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)

  const panelRef = useRef<HTMLDivElement>(null)
  const listId = 'desk-launch-list'
  const rowId = (key: string) => `desk-launch-${key.replace(/[^\w-]/g, '_')}`
  const tabId = (t: GroupKey) => `desk-launch-tab-${t}`

  // Return focus to whatever opened the launcher.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    return () => {
      if (opener && document.contains(opener)) opener.focus()
    }
  }, [])

  useEffect(() => {
    if (current) document.getElementById(rowId(current.key))?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const pickTab = (t: GroupKey) => {
    setPicked(t)
    saveTab(t)
    setHighlight(null)
  }

  const toggleOlder = (head: LauncherRow) => {
    const open = expanded.has(head.key)
    setExpanded((s) => {
      const next = new Set(s)
      if (open) next.delete(head.key)
      else next.add(head.key)
      return next
    })
    // Collapsing hides the highlighted older row: keep the highlight on its place.
    if (open && head.older.some((o) => o.key === current?.key)) setHighlight(head.key)
  }

  const run = async (row: LauncherRow | null) => {
    if (!row || busy) return
    const action = row.action
    if (action.kind === 'unavailable') return
    const finalName = name.trim() || autoName(row, sessions)
    setBusy(true)
    setRunError(null)
    try {
      if (action.kind === 'take-over') {
        const result = await window.hubApi.takeOverSession(action.pid, action.sessionId, { name: finalName, color, closeOld })
        onLaunched({
          session: result.session,
          replacing: outsideKey(action.sessionId),
          note: result.closedOld ? null : (result.note ?? FORK_NOTE),
        })
      } else {
        const spec = launchSpec(action, finalName, color)!
        onLaunched({ session: await window.hubApi.createDesktopSession(spec), replacing: null, note: null })
      }
    } catch (err) {
      const verb = action.kind === 'take-over' ? 'take over the session' : action.kind === 'resume' ? 'resume the conversation' : 'start the session'
      setRunError(`Couldn't ${verb}: ${errorText(err)}`)
      setBusy(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    const digit = /^Digit([1-3])$/.exec(e.code)
    if (digit && e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      e.preventDefault()
      const t = tabs[Number(digit[1]) - 1]
      if (t && !searching) pickTab(t)
      return
    }
    if (e.key === 'Tab') {
      // Keep focus inside the dialog.
      const items = panelRef.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled), [tabindex="0"]')
      if (!items || items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(moveHighlight(rows, current?.key ?? null, e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void run(current)
    } else if (!searching && current && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      // The query is empty, so the caret has nowhere to go: →/← open and
      // close a place's older conversations instead.
      const head = groups[0].rows.find((r) => r.key === current.key || r.older.some((o) => o.key === current.key))
      if (!head || head.older.length === 0) return
      const open = expanded.has(head.key)
      if (e.key === 'ArrowRight' ? !open : open) {
        e.preventDefault()
        toggleOlder(head)
      }
    }
  }

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.indexOf(tab)
    const next =
      e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : null
    if (!next) return
    e.preventDefault()
    pickTab(next)
    document.getElementById(tabId(next))?.focus()
  }

  const label = current ? actionLabel(current.action) : null
  // An outside list that couldn't be read, or a partial one with no Take over
  // tab to say it in, is said above everything.
  const outsideNotice =
    outside.sessions === null
      ? `Couldn't check for Claude sessions in other terminals${outside.error ? `: ${outside.error}` : '.'}`
      : model.takeover.length === 0
        ? outside.error
        : null
  const nothingFound = searching && targets.state.status === 'data' && groups.every((g) => g.total === 0)

  const rowProps = (row: LauncherRow) => ({
    row,
    id: rowId(row.key),
    highlighted: row.key === current?.key,
    onSelect: setHighlight,
    onRun: (r: LauncherRow) => void run(r),
  })
  const more = (g: LauncherGroup) =>
    g.rows.length < g.total && (
      <button
        type="button"
        className="desk-launch-more"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setShowAll((s) => new Set(s).add(g.key))}
      >
        Show all {g.total}
        {!searching && g.key === 'continue' ? ' places' : ''}
      </button>
    )
  const skeletons = (
    <div aria-busy="true">
      <div className="skeleton desk-launch-skel" />
      <div className="skeleton desk-launch-skel" />
      <div className="skeleton desk-launch-skel" />
    </div>
  )

  const tabBody = (g: LauncherGroup) => {
    if (loading && g.key !== 'takeover') return skeletons
    return (
      <div className="desk-launch-sec" role="group" aria-labelledby={tabId(g.key)}>
        {g.key === 'takeover' && (
          <>
            <label className="desk-launch-closeold">
              <input type="checkbox" checked={closeOld} onChange={(e) => setCloseOld(e.target.checked)} />
              <span>
                Close the old terminal
                <span className="desk-faint"> — only if it's idle and verified; otherwise it keeps running and the conversation forks here.</span>
              </span>
            </label>
            {outside.error && <p className="desk-launch-partial">{outside.error}</p>}
          </>
        )}
        {g.rows.map((row) => (
          <div key={row.key}>
            <Row {...rowProps(row)} expanded={row.older.length > 0 ? expanded.has(row.key) : undefined} onToggle={() => toggleOlder(row)} />
            {expanded.has(row.key) && row.older.map((o) => <Row key={o.key} {...rowProps(o)} nested />)}
          </div>
        ))}
        {more(g)}
        {g.total === 0 && targets.state.status === 'data' && (
          <p className="desk-launch-none">{emptyNote(g.key, launch?.error ?? null)}</p>
        )}
      </div>
    )
  }

  return (
    <div
      className="desk-launch-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="desk-launch" role="dialog" aria-modal="true" aria-labelledby="desk-launch-title" ref={panelRef} onKeyDown={onKeyDown}>
        <h2 id="desk-launch-title" className="desk-sr">
          New session
        </h2>
        <div className="desk-launch-search">
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <input
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={current ? rowId(current.key) : undefined}
            aria-label="Search conversations, projects and experiments"
            placeholder="Search conversations, projects and experiments"
            value={query}
            autoFocus
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              setShowAll(new Set())
            }}
            onKeyDown={onSearchKey}
          />
          <kbd className="desk-key">Esc</kbd>
        </div>

        {!searching && (
          <div className="desk-launch-tabs" role="tablist" aria-label="Session kind" onKeyDown={onTabKey}>
            {tabs.map((t) => (
              <button
                key={t}
                id={tabId(t)}
                type="button"
                role="tab"
                aria-selected={t === tab}
                aria-controls={listId}
                tabIndex={t === tab ? 0 : -1}
                className="desk-launch-tab"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickTab(t)}
              >
                {GROUP_LABEL[t]}
                {t === 'takeover' && <span className="desk-launch-tab-n">{model.takeover.length}</span>}
              </button>
            ))}
          </div>
        )}

        <div className="desk-launch-list" id={listId} role="listbox" aria-label="Sessions you can open">
          {targets.state.status === 'error' && (
            <div className="desk-launch-fail" role="alert">
              <span>Couldn't list projects, experiments and recent conversations: {targets.state.error}</span>
              <button className="desk-btn" onClick={targets.retry}>
                Retry
              </button>
            </div>
          )}
          {launch?.error && <p className="desk-launch-partial">Part of the list couldn't be read: {launch.error}</p>}
          {outsideNotice && <p className="desk-launch-partial">{outsideNotice}</p>}
          {!searching && tabBody(groups[0])}
          {searching &&
            groups.map((g) => {
              const pending = loading && g.key !== 'takeover'
              if (g.total === 0 && !pending) return null
              return (
                <div key={g.key} className="desk-launch-sec" role="group" aria-label={g.label}>
                  <h3 className="desk-group-head">
                    <span>{g.label}</span>
                    <span>{pending ? '' : g.rows.length < g.total ? `${g.rows.length} of ${g.total}` : g.total}</span>
                  </h3>
                  {pending ? skeletons : g.rows.map((row) => <Row key={row.key} {...rowProps(row)} />)}
                  {more(g)}
                </div>
              )
            })}
          {nothingFound && <p className="desk-launch-none">Nothing matches “{query.trim()}”.</p>}
        </div>

        <div className="desk-launch-foot">
          <label className="desk-field desk-launch-name">
            <span>Name</span>
            <input type="text" value={name} disabled={!current || !label} onChange={(e) => setNameDraft(e.target.value)} />
          </label>
          <div className="desk-field">
            <span id="desk-launch-colour">Colour</span>
            <div className="desk-swatches" role="radiogroup" aria-labelledby="desk-launch-colour">
              {DESKTOP_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={c === color}
                  aria-label={c}
                  className="desk-swatch"
                  style={idColor(c)}
                  onClick={() => setColorPick(c)}
                />
              ))}
            </div>
          </div>
          <div className="desk-launch-go">
            <button type="button" className="desk-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="desk-btn primary" disabled={!current || !label || busy} onClick={() => void run(current)}>
              {busy ? 'Working…' : (label ?? 'Open')}
            </button>
          </div>
          {current?.action.kind === 'unavailable' && <p className="desk-launch-why">{current.action.reason}</p>}
          {runError && (
            <p className="desk-field-error desk-launch-err" role="alert">
              {runError}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// One line of title, one quiet line of meta. A place's latest conversation
// can open its older ones (`expanded` set); those render `nested` under it.
function Row({
  row,
  id,
  highlighted,
  expanded,
  nested,
  onSelect,
  onRun,
  onToggle,
}: {
  row: LauncherRow
  id: string
  highlighted: boolean
  expanded?: boolean
  nested?: boolean
  onSelect: (key: string) => void
  onRun: (row: LauncherRow) => void
  onToggle?: () => void
}) {
  const label = actionLabel(row.action)
  return (
    <div
      id={id}
      role="option"
      aria-selected={highlighted}
      aria-disabled={label === null || undefined}
      className={`desk-launch-row${highlighted ? ' on' : ''}${label === null ? ' off' : ''}${nested ? ' nested' : ''}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onSelect(row.key)}
      onDoubleClick={() => onRun(row)}
    >
      <span className="desk-launch-row-name">{row.name}</span>
      <span className="desk-launch-row-meta">
        {row.status && <span className="desk-launch-status">{row.status}</span>}
        {!nested && <span className="desk-launch-where">{row.where}</span>}
        {row.recencyIso && <span>{relativeTime(row.recencyIso, Date.now())}</span>}
      </span>
      <span className="desk-launch-side">
        {expanded !== undefined && (
          <button
            type="button"
            tabIndex={-1}
            className="desk-launch-older"
            aria-expanded={expanded}
            aria-label={`${row.older.length} older conversation${row.older.length === 1 ? '' : 's'} in ${row.where}`}
            onClick={(e) => {
              e.stopPropagation()
              onToggle?.()
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {row.older.length} older
            <svg viewBox="0 0 10 10" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d={expanded ? 'M2 3.5l3 3 3-3' : 'M3.5 2l3 3-3 3'} />
            </svg>
          </button>
        )}
        <span className="desk-launch-act">
          {label ?? 'Unavailable'}
          {label && (
            <kbd className="desk-key" aria-hidden={!highlighted || undefined}>
              ↵
            </kbd>
          )}
        </span>
      </span>
    </div>
  )
}
