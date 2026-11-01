import { useContext, useMemo, useState } from 'react'
import { useSkillsList, type SkillWithUsage } from './useSkillsList'
import { SkillDetail } from './SkillDetail'
import { EmptyState } from '../shared/EmptyState'
import { ErrorNotice } from '../shared/ErrorNotice'
import { ListFilter, ListGroupHead, ListRows } from '../shared/ListShell'
import { ViewHeader, RefreshAction } from '../shared/ViewHeader'
import { SkillsIcon } from '../shared/icons'
import { relativeTime } from '../shared/relative-time'
import { useReportLoading } from '../shared/appLoading'
import { RouteParamContext, useNavigate } from '../shared/useHashRoute'
import { useIsNarrow } from '../shared/useIsNarrow'
import { useRovingRows } from '../shared/useRovingRows'
import './skills.css'

interface SkillGroup {
  key: string
  label: string
  items: SkillWithUsage[]
}

// Group the (already recency-sorted) skills by owning project — global skills
// fall under a synthetic 'global' group. Groups are emitted in first-appearance
// order: since useSkillsList() already returns skills recently-used-first, the
// group holding the most-recently-used skill naturally leads, and each group's
// items keep the incoming order. (A Map preserves insertion order, so no
// re-sort is needed — which also keeps the recency ranking intact.)
function groupByProject(skills: SkillWithUsage[]): SkillGroup[] {
  const map = new Map<string, SkillGroup>()
  for (const s of skills) {
    const key = s.projectId ?? '__global__'
    const g = map.get(key)
    if (g) g.items.push(s)
    else map.set(key, { key, label: s.projectName, items: [s] })
  }
  return [...map.values()]
}

// The compact usage sub-line for a master row — relative date here, the exact
// date lives in the detail pane's stat row.
function usageLine(s: SkillWithUsage): string {
  if (s.usedCount === 0 || !s.lastUsed) return 'Not used yet'
  return `used ${s.usedCount}× · ${relativeTime(s.lastUsed, Date.now())}`
}

export function SkillsView() {
  const { skills, sessionTitles, loading, error, refresh, promote, promoteAndTailor, promoteToGlobal, readSource } =
    useSkillsList()
  useReportLoading(loading)
  const selectedId = useContext(RouteParamContext)
  const navigate = useNavigate()
  const { listRef, onKeyDown } = useRovingRows('.skill-master-row')
  const [filter, setFilter] = useState('')
  // Group headers are collapsible but default-expanded — this set holds the
  // group keys the user has collapsed, so nothing is hidden until they ask.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  const query = filter.trim().toLowerCase()
  const visible = useMemo(
    () =>
      query
        ? skills.filter(
            (s) =>
              s.name.toLowerCase().includes(query) ||
              (s.description ?? '').toLowerCase().includes(query) ||
              s.projectName.toLowerCase().includes(query),
          )
        : skills,
    [skills, query],
  )
  const groups = useMemo(() => groupByProject(visible), [visible])
  // How many places each skill name is installed — computed over the FULL
  // list, not the filtered one, so the ⧉ chip never vanishes under a filter
  // that happens to hide the other copy.
  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of skills) counts.set(s.name, (counts.get(s.name) ?? 0) + 1)
    return counts
  }, [skills])
  // Phone drill-in: no auto-selected detail — landing shows the list, a tap
  // opens the detail full-width, the back button returns to the list.
  const isNarrow = useIsNarrow()
  const explicit = skills.find((s) => s.id === selectedId) ?? null
  // Fall back to the first VISIBLE row, never the unfiltered skills[0] — a
  // filter matching nothing must clear the detail pane, not strand it showing
  // an unrelated skill's live action buttons next to a "No skills match" list.
  const selected = explicit ?? (isNarrow ? null : visible[0] ?? null)
  const duplicates = useMemo(
    () => (selected ? skills.filter((s) => s.name === selected.name && s.id !== selected.id) : []),
    [skills, selected],
  )

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <section className="skills-view">
      <ViewHeader
        title="Skills"
        subtitle={
          <>
            Skills discovered from <code>.claude/skills/</code>, <code>.agents/skills/</code>, and{' '}
            <code>~/.claude/skills/</code>. Pick one to see its usage and copy it into a project.
          </>
        }
        actions={<RefreshAction loading={loading} onClick={() => refresh()} />}
      />

      {error && <ErrorNotice message={error} onRetry={() => refresh()} />}

      {loading && skills.length === 0 && (
        <div className="skill-panes">
          <div className="skill-master">
            <div className="skeleton skill-row-skeleton" />
            <div className="skeleton skill-row-skeleton" />
            <div className="skeleton skill-row-skeleton" />
          </div>
          <div className="skeleton skill-detail-skeleton" />
        </div>
      )}
      {/* The !error gate is the point (same as the Inbox queue's): a scan that
          failed left `skills` empty, and reporting that as "No skills found"
          is a confident claim about something nobody actually found out. On a
          failure the ErrorNotice above is the whole answer. */}
      {skills.length === 0 && !loading && !error && (
        <EmptyState
          glyph={<SkillsIcon />}
          title="No skills found"
          hint="Skills in registered projects' .claude/skills/, .agents/skills/, and ~/.claude/skills/ show up here."
        />
      )}

      {skills.length > 0 && (
        <div className="skill-panes">
          {(!isNarrow || !selected) && (
          // Roving focus is wired on the whole column, not just the row list:
          // ListRows takes no ref, and it means ↓ from the filter input drops
          // straight onto the first row instead of dead-ending there.
          <div className="skill-master-col" ref={listRef} onKeyDown={onKeyDown}>
            <ListFilter
              value={filter}
              onChange={setFilter}
              placeholder="Filter skills…"
              count={visible.length}
              ariaLabel="Filter skills"
            />

            <ListRows className="skill-master">
              {visible.length === 0 && <div className="skill-master-empty">No skills match “{filter}”.</div>}
              {groups.map((g) => {
                const isCollapsed = collapsed.has(g.key)
                return (
                  <div className="skill-group" key={g.key}>
                    <ListGroupHead
                      label={g.label}
                      count={g.items.length}
                      collapsed={isCollapsed}
                      onToggle={() => toggleGroup(g.key)}
                    />
                    {!isCollapsed &&
                      g.items.map((s) => {
                        const copies = nameCounts.get(s.name) ?? 1
                        return (
                          <button
                            key={s.id}
                            className={`skill-master-row${selected?.id === s.id ? ' active' : ''}${
                              s.usedCount === 0 ? ' never-used' : ''
                            }`}
                            onClick={() => navigate('skills', s.id)}
                          >
                            <span className="skill-master-name-line">
                              <span className="skill-master-name">{s.name}</span>
                              {copies > 1 && (
                                <span className="dup-chip" title={`Installed in ${copies} places`}>
                                  ⧉ {copies}
                                </span>
                              )}
                            </span>
                            {s.description && <span className="skill-master-purpose">{s.description}</span>}
                            <span className={`skill-master-usage${s.usedCount > 0 ? '' : ' unused'}`}>
                              {usageLine(s)}
                            </span>
                          </button>
                        )
                      })}
                  </div>
                )
              })}
            </ListRows>

            <div className="list-hint">
              <kbd>↑</kbd>
              <kbd>↓</kbd> move&ensp;<kbd>⏎</kbd> open
            </div>
          </div>
          )}

          {selected && (
            <>
              {isNarrow && (
                <button className="drill-back" onClick={() => navigate('skills')}>
                  ← All skills
                </button>
              )}
              <SkillDetail
                key={selected.id}
                skill={selected}
                duplicates={duplicates}
                sessionTitles={sessionTitles}
                onPromote={promote}
                onPromoteAndTailor={promoteAndTailor}
                onPromoteToGlobal={promoteToGlobal}
                onReadSource={readSource}
                onRefresh={refresh}
              />
            </>
          )}
        </div>
      )}
    </section>
  )
}
