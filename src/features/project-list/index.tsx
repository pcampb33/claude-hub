import { useEffect, useState, type DragEvent } from 'react'
import {
  useProjectList,
  attentionKind,
  isProjectScope,
  matchesScope,
  SCOPE_LABELS,
  type ProjectScope,
  type SortKey,
  type SortDir,
} from './useProjectList'
import { ProjectDetail } from './ProjectDetail'
import { displaySessionTitle } from './session-title'
import { useCrossProjectRedundancy } from '../shared/useCrossProjectRedundancy'
import { ProjectMark } from '../shared/ProjectMark'
import type { GitStatus } from '../shared/GitStatusPill'
import { ViewHeader, RefreshAction } from '../shared/ViewHeader'
import { toast } from '../shared/toast'
import { ErrorNotice } from '../shared/ErrorNotice'
import { relativeTimeOrNever } from '../shared/relative-time'
import { useReportLoading } from '../shared/appLoading'
import { useIsNarrow } from '../shared/useIsNarrow'
import { useRovingRows } from '../shared/useRovingRows'
import './project-list.css'

// `#/projects/<param>` carries either a registry id or a scope word. They can
// never be confused: registry ids are UUIDs and the scope words are bare
// lowercase names (see isProjectScope).
function hashParam(): string | null {
  const match = location.hash.match(/^#\/projects\/(.+)$/)
  return match ? decodeURIComponent(match[1]) : null
}

function hashProjectId(): string | null {
  const param = hashParam()
  return param !== null && !isProjectScope(param) ? param : null
}

function hashScope(): ProjectScope | null {
  const param = hashParam()
  return param !== null && isProjectScope(param) ? param : null
}

function gitStatusOf(status: { git: { dirty: boolean } | null } | null): GitStatus {
  if (!status?.git) return 'no-git'
  return status.git.dirty ? 'dirty' : 'clean'
}

// Tooltip copy for the corner git dot — the dot alone is not colorblind-legible,
// so every dot MUST carry one of these titles.
const GIT_DOT_TITLE: Record<GitStatus, string> = {
  clean: 'Git: clean',
  dirty: 'Git: uncommitted changes',
  stale: 'Git: stale',
  'no-git': 'Not a git repository',
}

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'git', label: 'Git' },
  { key: 'activity', label: 'Activity' },
  { key: 'health', label: 'Health' },
]

// Human meaning of the active sort direction — Health's worst-first default
// was invisible as a bare caret.
const SORT_DIR_LABEL: Record<SortKey, Record<SortDir, string>> = {
  name: { asc: 'A→Z', desc: 'Z→A' },
  git: { asc: 'least urgent first', desc: 'most urgent first' },
  activity: { asc: 'oldest first', desc: 'newest first' },
  health: { asc: 'worst first', desc: 'best first' },
}

// Colored-dot bucket for a config-health score, matching HealthRing's
// thresholds (>=85 ok, 60-84 warn, <60 danger; null = unscored).
function healthDotClass(score: number | null): string {
  if (score === null) return 'health-dot-none'
  if (score >= 85) return 'health-dot-ok'
  if (score >= 60) return 'health-dot-warn'
  return 'health-dot-danger'
}

// Master-row timestamp: compact form of relativeTimeOrNever ("3h", not
// "3h ago") — the right-aligned mono column reads as a unit, the suffix
// is noise at this density.
function compactTime(iso: string | null): string {
  const full = relativeTimeOrNever(iso)
  return full === 'just now' ? 'now' : full.replace(' ago', '')
}

// IPC rejections arrive wrapped ("Error invoking remote method 'registry:add':
// Error: Not a directory: …") — strip the plumbing, keep the reason.
function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function ProjectListView() {
  const { projects, loading, error, refresh, sortKey, sortDir, toggleSort } = useProjectList()
  useReportLoading(loading)
  const { findings: crossProjectFindings, error: crossProjectError } = useCrossProjectRedundancy()
  // Direct hash read keeps this worktree self-contained; the shell-level
  // hash hook (agent A) takes over view switching after merge.
  const [selectedId, setSelectedId] = useState<string | null>(hashProjectId)
  const [picking, setPicking] = useState(false)
  const [filter, setFilter] = useState('')
  const [scope, setScope] = useState<ProjectScope>(() => hashScope() ?? 'all')
  // Scoped to the rows container, not the whole master column: the filter
  // input above it keeps the browser's own ↑/↓ caret behaviour untouched.
  const { listRef, onKeyDown } = useRovingRows('.project-master-row')

  useEffect(() => {
    const onHashChange = () => {
      const id = hashProjectId()
      if (id) setSelectedId(id)
      // A scope arriving by route replaces the current one; arriving at a
      // project id leaves it alone, so a deep-linked project stays visible
      // even when the active scope would exclude it.
      const routeScope = hashScope()
      if (routeScope) setScope(routeScope)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Scroll the selected row into view once both the selection and the
  // loaded list exist (deep-link can land before projects finish loading).
  useEffect(() => {
    if (selectedId && projects.some((p) => p.id === selectedId)) {
      document.getElementById(`project-row-${selectedId}`)?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedId, projects])

  // Triage signal over ALL registered projects (not the filtered view):
  // missing path, dirty tree, stale, or failing config-health score.
  const attentionProjects = projects.filter((p) => attentionKind(p) !== null)

  const query = filter.trim().toLowerCase()
  const scoped = scope === 'all' ? projects : projects.filter((p) => matchesScope(p, scope))
  const visibleProjects = query ? scoped.filter((p) => p.name.toLowerCase().includes(query)) : scoped
  // Phone drill-in: no auto-selected detail — landing shows the list, a tap
  // opens the detail full-width, the back button returns to the list.
  const isNarrow = useIsNarrow()
  const explicit = projects.find((p) => p.id === selectedId) ?? null
  // First VISIBLE row, never the unfiltered projects[0] — a filter matching
  // nothing must clear the detail pane, not strand an unrelated project's
  // detail + live actions beside a "No projects match" list.
  const selected = explicit ?? (isNarrow ? null : visibleProjects[0] ?? null)

  const selectProject = (id: string) => {
    setSelectedId(id)
    location.hash = `#/projects/${id}`
  }

  const addPath = async (path: string) => {
    try {
      const entry = await window.hubApi.addProject(path)
      toast.success(`Added ${entry.name}.`)
      refresh()
    } catch (err) {
      toast.error(ipcErrorMessage(err))
    }
  }

  const handleAddClick = async () => {
    setPicking(true)
    try {
      const path = await window.hubApi.pickFolder()
      if (path) await addPath(path)
    } finally {
      setPicking(false)
    }
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    // In Electron's renderer, dropped Files carry the real filesystem path.
    // File.path is deprecated from Electron 32 — on an Electron upgrade this
    // must switch to webUtils.getPathForFile(file) exposed via preload.
    const path = file ? (file as File & { path?: string }).path : undefined
    if (path) {
      addPath(path)
    } else if (file) {
      toast.error('Could not read a folder path from the drop.')
    }
  }

  const handleRemove = async (id: string) => {
    try {
      await window.hubApi.removeProject(id)
      toast.success('Project removed.')
      if (selectedId === id) setSelectedId(null)
      refresh()
    } catch (err) {
      toast.error(ipcErrorMessage(err))
    }
  }

  const handleTogglePin = async (id: string, pinned: boolean) => {
    try {
      const entry = await window.hubApi.setPinned(id, pinned)
      toast.success(pinned ? `Pinned ${entry.name}.` : `Unpinned ${entry.name}.`)
      refresh()
    } catch (err) {
      toast.error(ipcErrorMessage(err))
    }
  }

  return (
    <section className="project-list-view" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
      <ViewHeader
        title="Projects"
        subtitle={
          <>
            Every registered Claude Code project. The score beside each name is its <b>CLAUDE.md health</b> — how much
            the project’s and global CLAUDE.md cost every session and how many scanner rules they trip; MCP and hooks
            are not measured, so the score covers those two files only. In the detail pane, <b>config tokens / session</b>{' '}
            is what those files load before you type a word, the <b>Verify floor</b> strip is one dot per day of the
            project’s verify command, and <b>Findings</b> are the individual rules that fired.
          </>
        }
        actions={
          <>
            <button onClick={handleAddClick} disabled={picking}>
              {picking ? 'Choosing…' : 'Add project'}
            </button>
            <RefreshAction loading={loading} onClick={() => refresh()} />
          </>
        }
      />

      {error && <ErrorNotice message={error} onRetry={() => refresh()} />}

      {loading && projects.length === 0 && (
        <div className="project-panes">
          <div className="project-master">
            <div className="skeleton project-row-skeleton" />
            <div className="skeleton project-row-skeleton" />
            <div className="skeleton project-row-skeleton" />
          </div>
          <div className="skeleton project-detail-skeleton" />
        </div>
      )}
      {!loading && projects.length === 0 && (
        <div className="empty-state">No projects registered yet — add one, or drop a folder here.</div>
      )}

      {projects.length > 0 && (
        <div className="project-panes">
          {(!isNarrow || !selected) && (
          <div className="project-master-col">
            <div className="project-filter">
              <input
                type="search"
                placeholder="Filter projects…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="Filter projects"
              />
              <span className="project-count">{visibleProjects.length}</span>
            </div>

            {/* The inert header "N need attention" chip, reborn as a scope
                filter where it can act. */}
            <div className="project-scope" role="group" aria-label="Scope">
              <button
                type="button"
                className={`project-scope-btn${scope === 'all' ? ' active' : ''}`}
                aria-pressed={scope === 'all'}
                onClick={() => setScope('all')}
              >
                All <span className="project-scope-count">{projects.length}</span>
              </button>
              <button
                type="button"
                className={`project-scope-btn${scope === 'attention' ? ' active' : ''}`}
                aria-pressed={scope === 'attention'}
                onClick={() => setScope('attention')}
              >
                <span className="project-scope-warn-dot" aria-hidden="true" />
                Needs attention <span className="project-scope-count">{attentionProjects.length}</span>
              </button>
              {/* A scope arriving from a Dashboard tile gets its own chip. It
                  has to be visible: without it the list would sit filtered
                  while "All" stayed lit, which is the view claiming to show
                  everything it is not showing. Clicking it clears back to All. */}
              {scope !== 'all' && scope !== 'attention' && (
                <button
                  type="button"
                  className="project-scope-btn active"
                  aria-pressed={true}
                  title={`Filtered from the Dashboard — click to clear`}
                  onClick={() => setScope('all')}
                >
                  {SCOPE_LABELS[scope]} <span className="project-scope-count">{scoped.length}</span>
                </button>
              )}
            </div>

            <div className="project-sort" role="group" aria-label="Sort projects">
              <span className="project-sort-label">Sort</span>
              {SORT_OPTIONS.map(({ key, label }) => {
                const active = sortKey === key
                return (
                  <button
                    key={key}
                    type="button"
                    className={`project-sort-btn${active ? ' active' : ''}`}
                    aria-pressed={active}
                    onClick={() => toggleSort(key)}
                  >
                    {label}
                    {active && (
                      <span className="project-sort-caret" aria-hidden="true">
                        {sortDir === 'asc' ? '▲' : '▼'}
                      </span>
                    )}
                  </button>
                )
              })}
              <span className="project-sort-dir">{SORT_DIR_LABEL[sortKey][sortDir]}</span>
            </div>

            <div className="project-master" ref={listRef} onKeyDown={onKeyDown}>
              {visibleProjects.length === 0 && (
                <div className="project-master-empty">
                  {query ? `No projects match “${filter}”.` : 'Nothing needs attention.'}
                </div>
              )}
              {visibleProjects.map((project) => {
                const attn = attentionKind(project)
                const gitStatus = gitStatusOf(project.status)
                return (
                  <button
                    key={project.id}
                    id={`project-row-${project.id}`}
                    className={`project-master-row${selected?.id === project.id ? ' active' : ''}${
                      attn ? ` attn${attn === 'danger' ? ' attn-danger' : ''}` : ''
                    }`}
                    onClick={() => selectProject(project.id)}
                  >
                    <span className="project-mark-wrap">
                      <ProjectMark id={project.id} name={project.name} />
                      <span className={`git-dot git-dot-${gitStatus}`} title={GIT_DOT_TITLE[gitStatus]} />
                    </span>
                    <div className="project-master-body">
                      <div className="project-master-name-line">
                        <span className="project-master-name">{project.name}</span>
                        {project.pinned && <span className="pin-badge">Pinned</span>}
                        {project.status && !project.status.pathExists && <span className="badge badge-missing">missing</span>}
                        <span
                          className="project-master-health"
                          title={
                            project.configHealthScore !== null
                              ? `CLAUDE.md health ${project.configHealthScore}`
                              : 'No CLAUDE.md health score for this project'
                          }
                        >
                          <span className={`health-dot ${healthDotClass(project.configHealthScore)}`} />
                          {project.configHealthScore !== null && (
                            <span className="project-master-health-score">{project.configHealthScore}</span>
                          )}
                        </span>
                      </div>
                      <div className="project-master-sub">
                        <span className="project-master-latest" title={project.latestSession?.title}>
                          {project.latestSession ? displaySessionTitle(project.latestSession.title) : 'no sessions yet'}
                        </span>
                        <span className="project-master-when">{compactTime(project.status?.lastActivity ?? null)}</span>
                      </div>
                    </div>
                  </button>
                )
              })}
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
                <button
                  className="drill-back"
                  onClick={() => {
                    setSelectedId(null)
                    location.hash = '#/projects'
                  }}
                >
                  ← All projects
                </button>
              )}
              <ProjectDetail
                key={selected.id}
                project={selected}
                crossProjectFindings={crossProjectFindings}
                crossProjectError={crossProjectError}
                onRemove={handleRemove}
                onTogglePin={handleTogglePin}
              />
            </>
          )}
        </div>
      )}
    </section>
  )
}
