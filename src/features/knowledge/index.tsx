import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useVaultInfo } from './useVaultInfo'
import { useRecallScorecard } from './useRecallScorecard'
import { RecallVerdict } from './RecallScorecard'
import { useJobFreshness } from './useJobFreshness'
import { AutomationFreshness } from './AutomationFreshness'
import { useVaultGraph } from './useVaultGraph'
import { NoteDetail } from './NoteDetail'
import { BrowsePane } from './BrowsePane'
import { LivingWebGraph } from './LivingWebGraph'
import { isLightColor, projectColorMap, tintCluster } from './community'
import { useTheme } from '../shared/theme'
import { displayNoteTitle } from './note-title'
import { SkeletonList } from '../shared/Skeleton'
import { ErrorNotice } from '../shared/ErrorNotice'
import { ViewHeader, RefreshAction } from '../shared/ViewHeader'
import { useReportLoading } from '../shared/appLoading'
import { RouteParamContext, useNavigate } from '../shared/useHashRoute'
import { QuickCapture } from './QuickCapture'
import { toast } from '../shared/toast'
import { useIsNarrow } from '../shared/useIsNarrow'
import './knowledge.css'

export function KnowledgeView() {
  const vault = useVaultInfo()
  const scorecard = useRecallScorecard()
  const freshness = useJobFreshness()
  const { graph, loading, error, refresh, selectedNoteId, selectNote, clearSelection, noteContent, loadingNote } =
    useVaultGraph()
  useReportLoading(loading)
  const navigate = useNavigate()
  const [captureOpen, setCaptureOpen] = useState(false)
  const [focusProject, setFocusProject] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [relinking, setRelinking] = useState(false)
  // A Browse-row hover lights the matching node on the canvas.
  const [browseHover, setBrowseHover] = useState<string | null>(null)

  // Pending-inbox chip: the capture pipeline surfaces where its output lands.
  // One call, passive — absence (or a failed read) just hides the chip.
  const [inboxCount, setInboxCount] = useState(0)
  useEffect(() => {
    window.hubApi.getVaultInbox().then(
      (report) => setInboxCount(report.count),
      () => setInboxCount(0),
    )
  }, [])

  // Per-note sonnet calls, serial — seconds per stale note. Fire, report,
  // refetch; the button just guards double-submission.
  const handleRelink = async () => {
    setRelinking(true)
    try {
      const result = await window.hubApi.recomputeLinks()
      // `message` on a successful run means notes were SKIPPED — the linker now
      // refuses to write an unparseable reply rather than wiping a note's edges.
      // Reporting that as "all notes already linked" would restate the very
      // claim-from-an-absence the skip exists to prevent.
      if (!result.ok) toast.error(result.message ?? 'Relink failed.')
      else if (result.message) toast.success(result.message)
      else if (result.linkedNotes === 0) toast.success('All notes already linked.')
      else toast.success(`Re-linked ${result.linkedNotes} note(s) — ${result.edgeCount} edges total.`)
      refresh()
    } finally {
      setRelinking(false)
    }
  }

  const selectedNote = graph?.notes.find((n) => n.id === selectedNoteId) ?? null

  // Phone: the reading pane stacks BELOW the canvas — a tap on a node would
  // otherwise appear to do nothing. Bring the pane into view on selection.
  const isNarrow = useIsNarrow()
  const detailRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (isNarrow && selectedNoteId) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [isNarrow, selectedNoteId])

  // Project → color, the same deterministic map the canvas derives, so a
  // legend swatch and its nodes always paint the identical color.
  const projectColors = useMemo(() => projectColorMap(graph?.notes.map((n) => n.project) ?? []), [graph])
  // Legend dots re-tint for the current ground, like the canvas and Browse.
  useTheme()
  const lightGround = isLightColor(getComputedStyle(document.documentElement).getPropertyValue('--bg-base'))

  // Legend: one swatch per project with >1 note (a lone-note project isn't worth
  // a swatch), name + count, most notes first. Unprojected notes are counted but
  // never a swatch — they're cross-project principles, not a group.
  const legend = useMemo(() => {
    if (!graph) return { projects: [] as { project: string; count: number }[], unprojected: 0 }
    const counts = new Map<string, number>()
    let unprojected = 0
    for (const n of graph.notes) {
      if (n.project) counts.set(n.project, (counts.get(n.project) ?? 0) + 1)
      else unprojected++
    }
    const projects = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1])
      .map(([project, count]) => ({ project, count }))
    return { projects, unprojected }
  }, [graph])

  // Selecting a note and focusing a project are mutually exclusive lenses.
  const handleSelect = useCallback(
    (id: string) => {
      setFocusProject(null)
      setBrowseHover(null)
      selectNote(id)
    },
    [selectNote],
  )

  // Deep-link support (e.g. the Inbox approve toast's "View in Knowledge →"):
  // select the routed note once the graph confirms it exists. Case-insensitive
  // fallback because the note id is derived from a title client-side.
  const routeNoteId = useContext(RouteParamContext)
  const appliedRoute = useRef<string | null>(null)
  useEffect(() => {
    if (!graph || !routeNoteId || appliedRoute.current === routeNoteId) return
    const match =
      graph.notes.find((n) => n.id === routeNoteId) ??
      graph.notes.find((n) => n.id.toLowerCase() === routeNoteId.toLowerCase())
    if (match) {
      appliedRoute.current = routeNoteId
      handleSelect(match.id)
    }
  }, [graph, routeNoteId, handleSelect])

  const handleSwatch = (project: string) => {
    setFocusProject((prev) => {
      const next = prev === project ? null : project
      if (next !== null) clearSelection()
      return next
    })
  }

  // As-you-type dim lens: matching nodes stay lit, the rest dim. null (no
  // query) leaves the canvas untouched; Enter still focuses the best match.
  const searchMatches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q || !graph) return null
    // Match the title as DISPLAYED as well as the raw id — typing the colon
    // you can see on screen must not miss the note it belongs to.
    return new Set(
      graph.notes
        .filter((n) => displayNoteTitle(n.title).toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
        .map((n) => n.id),
    )
  }, [search, graph])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    const q = search.trim().toLowerCase()
    if (!q || !graph) return
    const match =
      graph.notes.find((n) => displayNoteTitle(n.title).toLowerCase() === q || n.id.toLowerCase() === q) ??
      graph.notes.find((n) => displayNoteTitle(n.title).toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
    if (match) handleSelect(match.id)
  }

  const showVerdict = scorecard !== null && scorecard.attempts > 0

  return (
    <section className="knowledge-view">
      <ViewHeader
        title="Knowledge Vault"
        subtitle={
          <>
            One note per finding the capture hook kept, plus the links a nightly job computes between them. On the
            canvas each dot is a note, coloured by the project it was <em>discovered</em> in (origin, not topic) and
            sized by its authored links; the chips above it filter to one origin. The funnel at the top scores the
            bounded recall experiment: of the prompts the matcher ran on, how many produced a vault match, how many
            reached a session, and how many of those notes were actually opened.
          </>
        }
        actions={
          <>
            {inboxCount > 0 && (
              <button className="inbox-chip" onClick={() => navigate('inbox')}>
                Inbox <span className="inbox-chip-n">{inboxCount}</span>
              </button>
            )}
            <button onClick={() => setCaptureOpen((open) => !open)}>+ Note</button>
            <button
              onClick={handleRelink}
              disabled={relinking}
              title="Re-link new/changed notes (LLM, a few seconds per note)"
            >
              {relinking ? 'Relinking…' : 'Relink'}
            </button>
            <RefreshAction loading={loading} onClick={() => refresh()} />
          </>
        }
      />

      {error && <ErrorNotice message={error} onRetry={() => refresh()} />}

      {captureOpen && (
        <QuickCapture
          onSaved={() => {
            setCaptureOpen(false)
            refresh()
          }}
          onCancel={() => setCaptureOpen(false)}
        />
      )}

      {!vault && !graph && <SkeletonList rows={2} rowHeight={96} />}

      {vault && (
        <div className={`card vault-card${showVerdict ? ' with-verdict' : ''}`}>
          <div className="vault-id">
            <div className="vault-path">{vault.path}</div>
            {/* Was the first line of index.md, which is the `# Knowledge Vault
                Index` heading and therefore the same string on every visit —
                prime space above the fold spent restating the view's own title.
                The corpus size is what the identity block can actually tell
                you. Rendered only once the graph has loaded: "0 notes" while
                it is still in flight would be a count nobody has taken. */}
            {graph && (
              <div className="vault-excerpt">
                {graph.notes.length} notes · {graph.edges.length} links
              </div>
            )}
            <button className="vault-open" onClick={() => window.hubApi.openVault()}>
              Open Vault in Obsidian
            </button>
          </div>
          {showVerdict && scorecard && <RecallVerdict scorecard={scorecard} />}
        </div>
      )}

      {/* Sits with the vault's identity, not the graph: it qualifies every
          number on this page, including the edge count the canvas draws. */}
      <AutomationFreshness {...freshness} />

      {graph && (
        <div className="vault-body">
          <div className="graph-toolbar">
            <form className="graph-search" onSubmit={handleSearch}>
              <input
                type="search"
                placeholder="Search notes — Enter to focus…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search notes"
              />
            </form>
            {legend.projects.length > 0 && (
              <div className="cluster-legend">
                {legend.projects.map((l) => (
                  <button
                    key={l.project}
                    type="button"
                    className={`cluster-swatch${focusProject === l.project ? ' active' : ''}`}
                    onClick={() => handleSwatch(l.project)}
                    title={`${l.count} notes in ${l.project}`}
                  >
                    <span className="cluster-dot" style={{ backgroundColor: tintCluster(projectColors.get(l.project) ?? '', lightGround) }} />
                    {l.project} {l.count}
                  </button>
                ))}
                {/* "unlinked" until it collided with the Browse pane's Unlinked
                    lens, which is about edges — these notes have no origin
                    project, which is a different (and blameless) thing. */}
                {legend.unprojected > 0 && (
                  <span className="cluster-unprojected">· {legend.unprojected} without a project</span>
                )}
              </div>
            )}
          </div>

          <div className="vault-panes">
            <LivingWebGraph
              graph={graph}
              selectedNoteId={selectedNoteId}
              onSelect={handleSelect}
              focusProject={focusProject}
              highlightNoteId={browseHover}
              searchMatches={searchMatches}
            />
            <div ref={detailRef}>
              {selectedNote ? (
                <NoteDetail
                  note={selectedNote}
                  content={noteContent}
                  loading={loadingNote}
                  onSelect={handleSelect}
                  onBack={clearSelection}
                />
              ) : (
                <BrowsePane
                  notes={graph.notes}
                  edges={graph.edges}
                  projectColors={projectColors}
                  onOpen={handleSelect}
                  onHover={setBrowseHover}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
