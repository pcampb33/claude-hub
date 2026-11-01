import { useEffect, useMemo, useRef, useState } from 'react'
import { useExperiments } from './useExperiments'
import { ExperimentDetail } from './ExperimentDetail'
import { usePersistentState } from '../shared/usePersistentState'
import { useSandboxJobs } from '../shared/useSandboxJobs'
import { EmptyState } from '../shared/EmptyState'
import { ErrorNotice } from '../shared/ErrorNotice'
import { ViewHeader, RefreshAction } from '../shared/ViewHeader'
import { SandboxIcon } from '../shared/icons'
import { useReportLoading } from '../shared/appLoading'
import { useIsNarrow } from '../shared/useIsNarrow'
import { useRovingRows } from '../shared/useRovingRows'
import { relativeTime } from '../shared/relative-time'
import type { ExperimentEntry } from '../../../shared/ipc-types'
import './sandbox.css'

// Rows for experiments with no learnings were three lines of identical grey;
// the ones that produced a document get its size beside the date, so "this is
// a stub" and "this is real" are distinguishable without opening each.
function learningsSize(content: string | null): string {
  const words = content ? content.trim().split(/\s+/).length : 0
  return `${words.toLocaleString()} words`
}

export function SandboxView() {
  const { experiments, loading, error, creating, refresh, createExperiment, openTerminal, draftLearnings, queueToInbox } =
    useExperiments()
  useReportLoading(loading)
  const [newName, setNewName] = usePersistentState('sandbox:new-experiment-name', '')
  // The create form is tucked behind "+ New experiment" in the header
  // (mirrors Workflows); the persistent name draft survives while hidden.
  const [newOpen, setNewOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  // Scoped to the rows container, not the whole master column: the filter
  // input above it keeps the browser's own ↑/↓ caret behaviour untouched. The
  // selector walks both groups — they render into this one container.
  const { listRef, onKeyDown } = useRovingRows('.experiment-master-row')

  // Jobs live in the main process, so a draft started before navigating away
  // is still visible here on return. When one finishes, refresh — the row/detail
  // that awaited the result may have unmounted, but the excerpt/staleness
  // still need to update.
  const jobs = useSandboxJobs()
  const prevJobCount = useRef(0)
  useEffect(() => {
    if (jobs.length < prevJobCount.current) refresh()
    prevJobCount.current = jobs.length
  }, [jobs.length, refresh])

  const query = filter.trim().toLowerCase()
  const visible = useMemo(
    () =>
      query
        ? experiments.filter(
            (e) => e.name.toLowerCase().includes(query) || (e.learningsExcerpt ?? '').toLowerCase().includes(query),
          )
        : experiments,
    [experiments, query],
  )
  // The point of the sandbox is the learnings it produced, and those are a
  // minority — scattered through a date-sorted list of mostly-empty folders,
  // they read as "nothing here ever worked". Group them under counted headings
  // so the list states its own yield before anyone clicks a row.
  const withLearnings = visible.filter((e) => e.hasLearnings)
  const withoutLearnings = visible.filter((e) => !e.hasLearnings)
  const ordered = [...withLearnings, ...withoutLearnings]

  // Selection is local (not routed) — an experiment path holds backslashes and
  // a drive colon, which have no business in a URL hash, and the sandbox tab
  // has no deep-link requirement. Fall back to the first visible row on
  // desktop; when narrow there's no auto-selected detail — landing shows the
  // list, a tap opens the detail full-width, the back button returns to it.
  const isNarrow = useIsNarrow()
  const explicit = experiments.find((e) => e.path === selectedPath) ?? null
  // First VISIBLE row in rendered order, never the unfiltered experiments[0] —
  // a filter matching nothing must clear the detail pane, not strand an
  // unrelated experiment's detail + live actions beside a "No experiments
  // match" list. Rendered order now leads with the learnings, so the pane opens
  // on a real document rather than on an empty one.
  const selected = explicit ?? (isNarrow ? null : ordered[0] ?? null)

  const handleCreate = async () => {
    if (!newName.trim()) return
    const result = await createExperiment(newName.trim())
    if (result.ok) {
      setNewName('')
      setCreateError(null)
      setNewOpen(false)
    } else {
      setCreateError(result.message ?? 'Failed to create experiment.')
    }
  }

  const renderRow = (e: ExperimentEntry) => {
    const rowJob = jobs.find((j) => j.experimentPath === e.path)
    return (
      <button
        key={e.path}
        className={`experiment-master-row${selected?.path === e.path ? ' active' : ''}`}
        onClick={() => setSelectedPath(e.path)}
      >
        <span className="experiment-master-top">
          <span className="experiment-master-name">{e.name}</span>
          {rowJob && (
            <span
              className="experiment-row-spinner"
              aria-hidden="true"
              title={rowJob.phase === 'summarizing' ? 'Summarizing…' : 'Drafting…'}
            />
          )}
          {e.learningsStale && (
            <span className="experiment-row-stale" title="Draft predates latest session">
              stale
            </span>
          )}
        </span>
        {/* Exact date moves to the tooltip: relative age is what you actually
            scan a list of throwaway folders for. */}
        <span className="experiment-master-meta" title={new Date(e.lastModified).toLocaleString()}>
          {relativeTime(e.lastModified, Date.now())}
          {e.hasLearnings && ` · ${learningsSize(e.learningsContent)}`}
        </span>
        {/* No "No learnings yet" filler — the group heading above already says
            it, and repeating it 16 times is what buried the four that worked. */}
        {e.hasLearnings && <span className="experiment-master-hint">{e.learningsExcerpt}</span>}
      </button>
    )
  }

  return (
    <section className="sandbox-view">
      <ViewHeader
        title="Sandbox"
        subtitle="Throwaway Claude Code working dirs. Pick one to read its learnings — draft a summary of what happened, then queue it to the vault inbox for review."
        actions={
          <>
            <button
              className="sandbox-new-toggle"
              onClick={() => {
                setNewOpen((v) => !v)
                setCreateError(null) // a stale failure shouldn't redisplay next open
              }}
              aria-expanded={newOpen}
            >
              + New experiment
            </button>
            <RefreshAction loading={loading} onClick={() => refresh()} />
          </>
        }
      />

      {error && <ErrorNotice message={error} onRetry={() => refresh()} />}

      {newOpen && (
        <div className="new-experiment-form">
          <input
            type="text"
            placeholder="New experiment name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            disabled={creating}
            autoFocus
          />
          <button onClick={handleCreate} disabled={creating || !newName.trim()}>
            {creating ? 'Creating…' : 'Create'}
          </button>
          <button className="btn-ghost" onClick={() => setNewOpen(false)}>
            Cancel
          </button>
        </div>
      )}
      {createError && newOpen && <div className="promote-error">{createError}</div>}

      {loading && experiments.length === 0 && (
        <div className="experiment-panes">
          <div className="experiment-master">
            <div className="skeleton experiment-row-skeleton" />
            <div className="skeleton experiment-row-skeleton" />
            <div className="skeleton experiment-row-skeleton" />
          </div>
          <div className="skeleton experiment-detail-skeleton" />
        </div>
      )}
      {experiments.length === 0 && !loading && (
        <EmptyState glyph={<SandboxIcon />} title="No experiments yet" hint="Start one with + New experiment." />
      )}

      {experiments.length > 0 && (
        <div className="experiment-panes">
          {(!isNarrow || !selected) && (
          <div className="experiment-master-col">
            <div className="experiment-filter">
              <input
                type="search"
                placeholder="Filter experiments…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="Filter experiments"
              />
              <span className="experiment-count">{visible.length}</span>
            </div>

            <div className="experiment-master" ref={listRef} onKeyDown={onKeyDown}>
              {ordered.length === 0 && <div className="experiment-master-empty">No experiments match “{filter}”.</div>}
              {withLearnings.length > 0 && (
                <div className="experiment-group-head">
                  Learnings drafted<span className="experiment-group-count">{withLearnings.length}</span>
                </div>
              )}
              {withLearnings.map(renderRow)}
              {withoutLearnings.length > 0 && (
                <div className="experiment-group-head">
                  No learnings yet<span className="experiment-group-count">{withoutLearnings.length}</span>
                </div>
              )}
              {withoutLearnings.map(renderRow)}
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
                <button className="drill-back" onClick={() => setSelectedPath(null)}>
                  ← All experiments
                </button>
              )}
              <ExperimentDetail
                key={selected.path}
                experiment={selected}
                job={jobs.find((j) => j.experimentPath === selected.path)}
                onOpenTerminal={openTerminal}
                onDraftLearnings={draftLearnings}
                onQueueToInbox={queueToInbox}
                onCancelJob={(id) => window.hubApi.cancelSandboxJob(id)}
              />
            </>
          )}
        </div>
      )}
    </section>
  )
}
