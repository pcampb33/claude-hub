import { useContext, useMemo, useState } from 'react'
import { COMMANDS } from './commands-data'
import { useCommands, type CommandItem, type LiveSkillRow } from './useCommands'
import { CommandDetail } from './CommandDetail'
import { ListFilter, ListGroupHead, ListRows } from '../shared/ListShell'
import { ViewHeader, RefreshAction } from '../shared/ViewHeader'
import { ErrorNotice } from '../shared/ErrorNotice'
import { RouteParamContext, useNavigate } from '../shared/useHashRoute'
import { useIsNarrow } from '../shared/useIsNarrow'
import { useRovingRows } from '../shared/useRovingRows'
import './commands.css'

const LIVE_GROUP = 'Your skills — live'

interface CommandGroup {
  key: string
  items: CommandItem[]
}

// Flatten both halves into the shared row model. Live skills lead; the
// built-ins follow in the curated table's own category order.
function buildItems(liveSkills: LiveSkillRow[]): CommandItem[] {
  return [
    ...liveSkills.map((s) => ({
      id: `skill:${s.name}`,
      name: s.name,
      description: s.description,
      group: LIVE_GROUP,
      live: true,
      usageCount: s.count,
      runProjectId: s.runProjectId,
    })),
    ...COMMANDS.map((c) => ({
      id: `builtin:${c.name.slice(1)}`,
      name: c.name.slice(1),
      description: c.description,
      group: c.category,
      live: false,
      // Nothing on disk records a built-in slash command being typed, so the
      // pane claims nothing rather than implying "never used".
      usageCount: null,
      runProjectId: null,
    })),
  ]
}

// A Map keeps insertion order, so groups come out live-first then in table
// order without a re-sort.
function groupByCategory(items: CommandItem[]): CommandGroup[] {
  const map = new Map<string, CommandGroup>()
  for (const item of items) {
    const g = map.get(item.group)
    if (g) g.items.push(item)
    else map.set(item.group, { key: item.group, items: [item] })
  }
  return [...map.values()]
}

// The line under the action row — either what Run does, or why this command
// doesn't get one. An absent button with no explanation is what made the old
// view read as a dead end.
function runNoteFor(command: CommandItem, runnable: boolean): string {
  if (runnable) {
    return 'Opens a Claude Code session with the invocation pre-filled — nothing runs until you press Enter there.'
  }
  if (!command.live) {
    return 'Built-in commands are handled by the Claude Code client itself, so the hub can’t launch one for you — copy it and type it at a session prompt.'
  }
  return 'No working directory to open this in yet — it’s a global skill that hasn’t been used in any project. Copy it and paste it into any session.'
}

export function CommandsView() {
  const { liveSkills, loading, error, refresh } = useCommands()
  const selectedId = useContext(RouteParamContext)
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  // Group heads are collapsible but default-expanded — nothing is hidden
  // until the user asks. Holds the keys they have collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  // Scoped to the rows container, not the whole master column: the filter
  // input above it keeps the browser's own ↑/↓ caret behaviour untouched. The
  // selector walks every group; a collapsed one renders no rows to walk.
  const { listRef, onKeyDown } = useRovingRows('.command-master-row')

  const items = useMemo(() => buildItems(liveSkills), [liveSkills])

  const q = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      q
        ? items.filter((i) => `/${i.name}`.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
        : items,
    [items, q],
  )
  const groups = useMemo(() => groupByCategory(visible), [visible])

  // Phone drill-in: no auto-selected detail — landing shows the list, a tap
  // opens the detail full-width, the back button returns to the list.
  const isNarrow = useIsNarrow()
  const explicit = items.find((i) => i.id === selectedId) ?? null
  // First VISIBLE row, never items[0] — a filter matching nothing must clear
  // the detail pane, not strand an unrelated command's actions beside a "No
  // commands match" list.
  const selected = explicit ?? (isNarrow ? null : visible[0] ?? null)

  // Deep-link launch needs an unambiguous cwd, and only makes sense for a
  // skill: the prompt it pre-fills asks Claude to run the command, which a
  // model can do for a skill and cannot do for a client-side built-in like
  // /doctor.
  const runProjectId = selected?.live ? selected.runProjectId : null

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <section className="commands-view">
      <ViewHeader
        title="Claude Commands"
        subtitle={
          <>
            Quick reference — type <code>/</code> in any Claude Code session for the live, platform-filtered list. Pick
            a command to read it in full and copy it; your own skills are invocable as <code>/name</code>.
          </>
        }
        // The built-in list is a fixed cheat sheet; Refresh re-reads the live
        // "Your skills" group, which is the part that goes stale.
        actions={<RefreshAction loading={loading} onClick={() => refresh()} />}
      />

      {error && <ErrorNotice message={error} onRetry={() => refresh()} />}

      <div className="command-panes">
        {(!isNarrow || !selected) && (
          <div className="command-master-col">
            <ListFilter
              value={query}
              onChange={setQuery}
              placeholder="Filter commands…"
              count={visible.length}
              ariaLabel="Filter commands"
            />

            {/* The roving-focus scope wraps ListRows rather than being on it:
                the shared shell takes no ref. */}
            <div ref={listRef} onKeyDown={onKeyDown}>
            <ListRows className="command-master">
              {visible.length === 0 && <div className="command-master-empty">No commands match “{query}”.</div>}
              {groups.map((g) => {
                const isCollapsed = collapsed.has(g.key)
                return (
                  <div
                    className={`command-group${g.key === LIVE_GROUP ? ' command-group-live' : ''}`}
                    key={g.key}
                  >
                    <ListGroupHead
                      label={g.key}
                      count={g.items.length}
                      collapsed={isCollapsed}
                      onToggle={() => toggleGroup(g.key)}
                    />
                    {!isCollapsed &&
                      g.items.map((item) => (
                        <button
                          key={item.id}
                          className={`command-master-row${selected?.id === item.id ? ' active' : ''}`}
                          onClick={() => navigate('commands', item.id)}
                        >
                          <span className="command-master-name">/{item.name}</span>
                          <span className="command-master-desc">{item.description}</span>
                        </button>
                      ))}
                  </div>
                )
              })}
            </ListRows>
            </div>

            {/* Knowledge's hint strip, class included — one strip and one CSS
                rule across every master list, not a per-view variant. */}
            <div className="list-hint">
              <kbd>↑</kbd>
              <kbd>↓</kbd> move&ensp;<kbd>⏎</kbd> open
            </div>
          </div>
        )}

        {selected && (
          <>
            {isNarrow && (
              <button className="drill-back" onClick={() => navigate('commands')}>
                ← All commands
              </button>
            )}
            <CommandDetail
              key={selected.id}
              command={selected}
              onRun={
                runProjectId
                  ? () => void window.hubApi.launchCommandSession(selected.name, runProjectId)
                  : undefined
              }
              runNote={runNoteFor(selected, runProjectId !== null)}
            />
          </>
        )}
      </div>
    </section>
  )
}
