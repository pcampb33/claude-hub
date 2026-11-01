import { useEffect, useRef, useState } from 'react'
import type { ProjectWithStatus } from './useProjectList'
import type { CrossProjectRedundancyFinding } from '../../../shared/ipc-types'
import { useConfigHealth } from './useConfigHealth'
import { useVerifyJobs } from '../shared/useVerifyJobs'
import { SessionHistory } from './SessionHistory'
import { LaunchActions } from './LaunchActions'
import { ConfigHealth } from './ConfigHealth'
import { ProjectFloorCard } from '../floor/ProjectFloorCard'
import { useFloorStatus } from '../floor/useFloorStatus'
import { HealthRing } from '../shared/HealthRing'
import { GitStatusPill, type GitStatus } from '../shared/GitStatusPill'
import { WidgetCard } from '../shared/WidgetCard'
import { ProjectMark } from '../shared/ProjectMark'
import { ConfirmButton } from '../shared/ConfirmButton'
import { relativeTimeOrNever } from '../shared/relative-time'

function gitStatusOf(project: ProjectWithStatus): GitStatus {
  const git = project.status?.git
  if (!git) return 'no-git'
  return git.dirty ? 'dirty' : 'clean'
}

// The wide detail pane for a selected project. Keyed on project.id by the
// parent so every per-project hook (config health, session history) resets
// cleanly on selection change instead of leaking the previous project's data.
//
// Say-it-once layout: the title row (mark + name + branch chip + git pill) is
// the single identity statement. Everything the old byline / StatCards /
// Repository widget repeated now appears exactly once — a facts strip and a
// mono last-commit line under the title (path already lives in the eyebrow).
export function ProjectDetail({
  project,
  crossProjectFindings,
  crossProjectError,
  onRemove,
  onTogglePin,
}: {
  project: ProjectWithStatus
  crossProjectFindings: CrossProjectRedundancyFinding[] | null
  crossProjectError: string | null
  onRemove: (id: string) => void
  onTogglePin: (id: string, pinned: boolean) => void
}) {
  const { report, loading: healthLoading, error: healthError, load } = useConfigHealth(project.path)
  const { report: floorReport, refresh: refreshFloor } = useFloorStatus()
  const [verifying, setVerifying] = useState(false)
  const status = project.status
  const pathExists = status?.pathExists ?? false

  // Auto-load config health once per mounted project (parent remounts via key).
  useEffect(() => {
    if (pathExists) load()
  }, [load, pathExists])

  // getFloorStatus covers every registered project in one call, so this
  // project's row is a lookup, not a fetch.
  const floorProject = floorReport?.projects.find((p) => p.id === project.id) ?? null

  // Live verify run for THIS project, if any — jobs live in the main process,
  // so a run started before navigating away is still visible (and cancellable)
  // here on return.
  const verifyJob = useVerifyJobs().find((j) => j.projectId === project.id) ?? null

  // A run can outlive this pane: if it was still going when the pane
  // unmounted, the runVerify await below never lands, so refresh the floor
  // when the job disappears to pick up the fresh ledger row.
  const hadVerifyJob = useRef(false)
  useEffect(() => {
    if (hadVerifyJob.current && !verifyJob) void refreshFloor()
    hadVerifyJob.current = verifyJob !== null
  }, [verifyJob, refreshFloor])

  const runVerify = async () => {
    setVerifying(true)
    try {
      await window.hubApi.runVerify(project.id)
      // runVerify returns the fresh report, but re-refetch so the hook stays the
      // single source of truth for floor state.
      await refreshFloor()
    } catch {
      // runVerify rejects for unknown / no-verifyCommand projects (the button is
      // already disabled in those cases). Swallow so a rejection can't wedge the
      // `verifying` flag — finally still clears it.
    } finally {
      setVerifying(false)
    }
  }

  // Inline verifyCommand setter (floor card) — write, then refetch so the
  // hook stays the single source of truth. Rethrow so the card keeps its
  // editor open (and Saving… state honest) on a failed write.
  const setVerifyCommand = async (command: string) => {
    await window.hubApi.setVerifyCommand(project.id, command)
    await refreshFloor()
  }

  const git = status?.git
  const sessionCount = status?.sessionCount ?? 0

  // Severity split for the ring's sub line — links down to the Findings card
  // instead of a bare count.
  const warnCount = report?.findings.filter((f) => f.severity === 'warn').length ?? 0
  const infoCount = report ? report.findings.length - warnCount : 0
  const findingsRef = useRef<HTMLDivElement>(null)
  const scrollToFindings = () => findingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  // The excerpt is the CLAUDE.md first line — when that's just the project
  // name again (the usual `# claude-hub` H1), it says nothing new. Drop it.
  const excerpt = status?.claudeMdExcerpt ?? null
  const excerptSaysSomething = excerpt !== null && excerpt.trim().toLowerCase() !== project.name.trim().toLowerCase()

  return (
    <article className="card project-detail">
      <div className="project-detail-eyebrow">{project.path}</div>

      <header className="project-detail-header">
        <div className="project-detail-headline">
          <div className="project-detail-title-row">
            <ProjectMark id={project.id} name={project.name} />
            <strong className="project-detail-name">{project.name}</strong>
            {git && <span className="branch-chip">{git.branch}</span>}
            <GitStatusPill status={gitStatusOf(project)} />
            {project.pinned && <span className="pin-badge">Pinned</span>}
          </div>
          {!status ? (
            <div className="project-detail-facts">
              <span className="fact-label">Status unavailable</span>
            </div>
          ) : !pathExists ? (
            <div className="project-detail-facts">
              <span className="badge badge-missing">Path not found</span>
            </div>
          ) : (
            <>
              <div className="project-detail-facts">
                <span className="fact">
                  <b>{sessionCount}</b> <span className="fact-label">session{sessionCount === 1 ? '' : 's'}</span>
                  {/* The scan excludes directories it could not read, so the count is a
                      floor when any exist. Saying "at least" is the difference between
                      reporting a measurement and reporting a smaller confident claim. */}
                  {status.unreadableSessionDirs > 0 && (
                    <span className="fact-label">
                      {' '}
                      + {status.unreadableSessionDirs} unreadable folder
                      {status.unreadableSessionDirs === 1 ? '' : 's'}
                    </span>
                  )}
                </span>
                <span className="fact">
                  <span className="fact-label">last activity</span> <b>{relativeTimeOrNever(status.lastActivity)}</b>
                </span>
                <span className="fact">
                  <b>{report ? report.combinedEstimatedTokens.toLocaleString() : '—'}</b>{' '}
                  <span className="fact-label">config tokens / session</span>
                </span>
              </div>
              {git?.lastCommitMessage && (
                <div className="project-detail-commit">
                  <span className="project-detail-commit-label">last commit</span>
                  <span className="project-detail-commit-msg" title={git.lastCommitMessage}>
                    {git.lastCommitMessage}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="project-detail-ring">
          <HealthRing score={report?.score ?? null} size={92} />
          <div className="project-detail-ring-meta">
            {/* Names what the score actually scans — the footnote under the
                Findings card already admits MCP/hooks are outside it, so the
                label must not keep claiming the whole config. */}
            <span className="project-detail-ring-label">CLAUDE.md health</span>
            <span className="project-detail-ring-sub">
              {report ? (
                report.findings.length === 0 ? (
                  'no findings'
                ) : (
                  <>
                    {warnCount > 0 && <span className="ring-sub-warn">{warnCount} warn</span>}
                    {warnCount > 0 && infoCount > 0 && ' · '}
                    {infoCount > 0 && <span className="ring-sub-info">{infoCount} info</span>}
                    {' — '}
                    <button type="button" className="ring-sub-view" onClick={scrollToFindings}>
                      view ↓
                    </button>
                  </>
                )
              ) : healthLoading ? (
                'scanning…'
              ) : healthError ? (
                <span className="ring-sub-warn">scan failed</span>
              ) : (
                'not yet scanned'
              )}
            </span>
          </div>
        </div>

        <div className="project-detail-actions">
          <button
            className="btn-ghost"
            onClick={() => onTogglePin(project.id, !project.pinned)}
            aria-pressed={project.pinned ?? false}
          >
            {project.pinned ? 'Unpin' : 'Pin'}
          </button>
          <ConfirmButton label="Remove" onConfirm={() => onRemove(project.id)} />
        </div>
      </header>

      {!status ? null : !pathExists ? (
        <div className="project-detail-missing badge badge-missing">This project's folder is missing on disk.</div>
      ) : (
        <>
          {/* Launch row anchored directly under the header divider. */}
          <LaunchActions id={project.id} />

          {excerptSaysSomething && <p className="project-card-excerpt">{excerpt}</p>}

          <div className="project-detail-columns">
            <div className="project-detail-main">
              <section className="project-detail-floor">
                <h3 className="project-detail-floor-title">Verify floor</h3>
                {floorProject ? (
                  <>
                    <ProjectFloorCard
                      project={floorProject}
                      historyDays={floorReport?.historyDays ?? 0}
                      onRun={runVerify}
                      running={verifying || verifyJob !== null}
                      job={verifyJob}
                      onCancel={() => {
                        if (verifyJob) void window.hubApi.cancelVerifyJob(verifyJob.id)
                      }}
                      onSetCommand={setVerifyCommand}
                    />
                    {/* The card's day strip is colour-only, and grey there means
                        "no run recorded" — never "failed". Say so, reusing the
                        strip's own classes so a swatch can't drift from the dot
                        it explains. */}
                    <div className="floor-legend">
                      <span className="floor-legend-item">
                        <span className="floor-legend-dot floor-strip-green" />
                        passed
                      </span>
                      <span className="floor-legend-item">
                        <span className="floor-legend-dot floor-strip-red" />
                        failed
                      </span>
                      <span className="floor-legend-item">
                        <span className="floor-legend-dot floor-strip-none" />
                        no run recorded
                      </span>
                      <span className="floor-legend-days">
                        one dot per day, oldest first
                        {floorReport ? ` · last ${floorReport.historyDays} days` : ''}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="project-detail-floor-empty">No floor data for this project.</div>
                )}
              </section>

              <WidgetCard title="Recent sessions" padding={false}>
                {sessionCount > 0 ? (
                  <SessionHistory projectPath={project.path} projectId={project.id} />
                ) : (
                  <div className="session-list-empty">No sessions recorded for this project yet.</div>
                )}
              </WidgetCard>
            </div>

            <div className="project-detail-side">
              <div ref={findingsRef}>
                <ConfigHealth
                  report={report}
                  loading={healthLoading}
                  projectId={project.id}
                  projectPath={project.path}
                  crossProjectFindings={crossProjectFindings}
                  crossProjectError={crossProjectError}
                />
              </div>
            </div>
          </div>
        </>
      )}
    </article>
  )
}
