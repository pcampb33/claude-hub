import { useContext, useMemo, useState } from 'react'
import { useWorkflows } from './useWorkflows'
import { WorkflowDetail } from './WorkflowDetail'
import { WorkflowLegend } from './WorkflowLegend'
import { WorkflowNewPanel } from './WorkflowNewPanel'
import { GLOSSARY } from './glossary'
import { EmptyState } from '../shared/EmptyState'
import { ErrorNotice } from '../shared/ErrorNotice'
import { ViewHeader, RefreshAction } from '../shared/ViewHeader'
import { WorkflowsIcon } from '../shared/icons'
import { useReportLoading } from '../shared/appLoading'
import { useIsNarrow } from '../shared/useIsNarrow'
import { RouteParamContext, useNavigate } from '../shared/useHashRoute'
import { useRovingRows } from '../shared/useRovingRows'
import type { WorkflowComposition, WorkflowEntry } from '../../../shared/ipc-types'
import './workflows.css'

// The orchestration-shape summary chips for a master row.
function shapeChips(c: WorkflowComposition): string[] {
  const s: string[] = []
  if (c.orchestration.usesPipeline) s.push('pipeline')
  if (c.orchestration.usesParallel) s.push('parallel')
  if (c.orchestration.usesLoop) s.push('loop')
  if (c.orchestration.callsSubWorkflow) s.push('sub-workflow')
  return s
}

interface WorkflowGroup {
  key: string
  label: string
  maxMtime: string
  items: WorkflowEntry[]
}

// Group the (already mtime-desc-sorted) workflows by owning project — global
// workflows fall under a synthetic 'global' group that only appears when such
// workflows exist. Groups themselves are ordered by their most-recently-touched
// workflow; items keep listWorkflows()'s mtime-desc order within a group.
function groupByProject(workflows: WorkflowEntry[]): WorkflowGroup[] {
  const map = new Map<string, WorkflowGroup>()
  for (const w of workflows) {
    const key = w.projectId ?? '__global__'
    const g = map.get(key)
    if (g) {
      g.items.push(w)
      if (w.mtime > g.maxMtime) g.maxMtime = w.mtime
    } else {
      map.set(key, { key, label: w.projectName, maxMtime: w.mtime, items: [w] })
    }
  }
  return [...map.values()].sort((a, b) => b.maxMtime.localeCompare(a.maxMtime))
}

export function WorkflowsView() {
  const {
    workflows,
    loading,
    error,
    refresh,
    promote,
    launchSession,
    readSource,
    explainSession,
    listTemplates,
    createFromTemplate,
    openInEditor,
    editSession,
  } = useWorkflows()
  useReportLoading(loading)
  const selectedId = useContext(RouteParamContext)
  const navigate = useNavigate()
  const { listRef, onKeyDown } = useRovingRows('.workflow-master-row')
  const [filter, setFilter] = useState('')
  const [legendOpen, setLegendOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  // Group headers are collapsible but default-expanded — this set holds the
  // group keys the user has collapsed, so nothing is hidden until they ask.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  const query = filter.trim().toLowerCase()
  const visible = useMemo(
    () =>
      query
        ? workflows.filter(
            (w) =>
              w.name.toLowerCase().includes(query) ||
              (w.description ?? '').toLowerCase().includes(query) ||
              w.projectName.toLowerCase().includes(query),
          )
        : workflows,
    [workflows, query],
  )
  const groups = useMemo(() => groupByProject(visible), [visible])
  // Phone drill-in: no auto-selected detail — landing shows the list, a tap
  // opens the detail full-width, the back button returns to the list.
  const isNarrow = useIsNarrow()
  const explicit = workflows.find((w) => w.id === selectedId) ?? null
  // First VISIBLE row, never the unfiltered workflows[0] — a filter matching
  // nothing must clear the detail pane, not strand an unrelated workflow's
  // detail + live "Run in session" actions beside a "No workflows match" list.
  const selected = explicit ?? (isNarrow ? null : visible[0] ?? null)

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <section className="workflows-view">
      <ViewHeader
        title="Workflows"
        subtitle={
          <>
            Orchestration scripts discovered from <code>.claude/workflows/</code>. Pick one to see when and how to use
            it — run <code>/{'<name>'}</code> in a Claude Code session to execute it.
          </>
        }
        actions={
          <>
            <button
              className="workflow-run wf-new-toggle"
              onClick={() => setNewOpen((v) => !v)}
              aria-expanded={newOpen}
            >
              + New workflow
            </button>
            <button onClick={() => setLegendOpen((v) => !v)} aria-expanded={legendOpen}>
              ? Legend
            </button>
            <RefreshAction loading={loading} onClick={() => refresh()} />
          </>
        }
      />

      {error && <ErrorNotice message={error} onRetry={() => refresh()} />}

      {legendOpen && <WorkflowLegend onClose={() => setLegendOpen(false)} />}

      {newOpen && (
        <WorkflowNewPanel
          onClose={() => setNewOpen(false)}
          onCreated={(createdPath) => {
            refresh()
            navigate('workflows', createdPath)
          }}
          listTemplates={listTemplates}
          createFromTemplate={createFromTemplate}
          openInEditor={openInEditor}
          editSession={editSession}
        />
      )}

      {loading && workflows.length === 0 && (
        <div className="workflow-panes">
          <div className="workflow-master">
            <div className="skeleton workflow-row-skeleton" />
            <div className="skeleton workflow-row-skeleton" />
            <div className="skeleton workflow-row-skeleton" />
          </div>
          <div className="skeleton workflow-detail-skeleton" />
        </div>
      )}
      {/* The only thing that resolves an empty catalog is authoring one, and
          the header button that does it sits a full view away in the top-right
          corner — so the empty state carries its own copy of it. Which is also
          why the !error gate matters (same one the Inbox queue uses): a scan
          that failed left `workflows` empty, and answering that with "No
          workflows found" plus an authoring CTA is a confident claim about
          something nobody actually found out. The ErrorNotice above owns that
          case. */}
      {workflows.length === 0 && !loading && !error && (
        <EmptyState
          glyph={<WorkflowsIcon />}
          title="No workflows found"
          hint="Workflow scripts in registered projects' .claude/workflows/ and ~/.claude/workflows/ show up here."
          action={
            <button className="workflow-run wf-new-toggle" onClick={() => setNewOpen(true)}>
              + New workflow
            </button>
          }
        />
      )}

      {workflows.length > 0 && (
        <div className="workflow-panes">
          {(!isNarrow || !selected) && (
          // Roving focus is wired on the whole column, not just the row list,
          // so ↓ from the filter input drops straight onto the first row
          // instead of dead-ending there.
          <div className="workflow-master-col" ref={listRef} onKeyDown={onKeyDown}>
            <div className="workflow-filter">
              <input
                type="search"
                placeholder="Filter workflows…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="Filter workflows"
              />
              <span className="workflow-count">{visible.length}</span>
            </div>

            <div className="workflow-master">
              {visible.length === 0 && <div className="workflow-master-empty">No workflows match “{filter}”.</div>}
              {groups.map((g) => {
                const isCollapsed = collapsed.has(g.key)
                return (
                  <div className="workflow-group" key={g.key}>
                    <button
                      type="button"
                      className="workflow-group-head"
                      onClick={() => toggleGroup(g.key)}
                      aria-expanded={!isCollapsed}
                    >
                      <span className={`workflow-group-caret${isCollapsed ? '' : ' open'}`}>▸</span>
                      <span className="workflow-group-name">{g.label}</span>
                      <span className="workflow-group-count">{g.items.length}</span>
                    </button>
                    {!isCollapsed &&
                      g.items.map((w) => (
                        <button
                          key={w.id}
                          className={`workflow-master-row${selected?.id === w.id ? ' active' : ''}`}
                          onClick={() => navigate('workflows', w.id)}
                        >
                          <span className="workflow-master-name">{w.name}</span>
                          {w.description && <span className="workflow-master-purpose">{w.description}</span>}
                          <span className="workflow-master-sub">
                            {shapeChips(w.composition).map((s) => (
                              <span key={s} className="wf-shape-chip" title={GLOSSARY[s]}>
                                {s}
                              </span>
                            ))}
                            <span
                              className="wf-agent-count"
                              title={w.composition.dynamic ? `${GLOSSARY.agent} ${GLOSSARY.dynamic}` : GLOSSARY.agent}
                            >
                              {w.composition.agentCount} agent{w.composition.agentCount === 1 ? '' : 's'}
                              {w.composition.dynamic && '+'}
                            </span>
                          </span>
                        </button>
                      ))}
                  </div>
                )
              })}
            </div>

            <div className="list-hint">
              <kbd>↑</kbd>
              <kbd>↓</kbd> move&ensp;<kbd>⏎</kbd> open
            </div>
          </div>
          )}

          {selected && (
            <>
              {isNarrow && (
                <button className="drill-back" onClick={() => navigate('workflows')}>
                  ← All workflows
                </button>
              )}
              <WorkflowDetail
                key={selected.id}
                workflow={selected}
                onPromote={promote}
                onLaunchSession={launchSession}
                onReadSource={readSource}
                onExplainSession={explainSession}
                onEditSession={editSession}
                onOpenInEditor={openInEditor}
              />
            </>
          )}
        </div>
      )}
    </section>
  )
}
