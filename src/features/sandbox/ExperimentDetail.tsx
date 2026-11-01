import { useMemo, useState } from 'react'
import { toast } from '../shared/toast'
import { MarkdownLite } from '../shared/MarkdownLite'
import { parseMarkdownLite } from '../shared/markdown-lite'
import { EmptyState } from '../shared/EmptyState'
import { SandboxIcon } from '../shared/icons'
import type { DraftLearningsResult, ExperimentEntry, QueueToInboxResult, SandboxJob } from '../../../shared/ipc-types'

// The wide detail pane for the selected experiment. Keyed on experiment.path
// by the parent so the transient draft-result / busy state resets on
// selection change. The action cluster (terminal/draft ghosts + the
// Queue-to-Inbox accent CTA) lives in the header so the one vault path out is
// visible without scrolling (no per-project promote — the sandbox's output
// is learnings → vault, reviewed by a human first).

// The detail header already names the experiment — drop a single leading
// "# ..." title line from the rendered learnings so it doesn't repeat. The
// raw view keeps the file verbatim.
function stripLeadingTitle(md: string): string {
  return md.replace(/^# [^\n]*\n+/, '')
}
export function ExperimentDetail({
  experiment,
  job,
  onOpenTerminal,
  onDraftLearnings,
  onQueueToInbox,
  onCancelJob,
}: {
  experiment: ExperimentEntry
  // The main-process job for this experiment, if a draft is running — the
  // source of truth for busy state, so it survives unmount/remount.
  job?: SandboxJob
  onOpenTerminal: (experimentPath: string) => Promise<void>
  onDraftLearnings: (experimentPath: string) => Promise<DraftLearningsResult>
  onQueueToInbox: (experimentPath: string) => Promise<QueueToInboxResult>
  onCancelJob: (id: string) => void
}) {
  // Local `drafting` only bridges the gap until the job push arrives — the
  // job prop is what keeps busy state correct across navigation.
  const [drafting, setDrafting] = useState(false)
  const [draftResult, setDraftResult] = useState<DraftLearningsResult | null>(null)
  const [queuing, setQueuing] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const busy = drafting || job !== undefined
  const draftLabel = busy ? (job?.phase === 'summarizing' ? 'Summarizing…' : 'Drafting…') : 'Draft Learnings'

  // Learnings render as markdown-lite when the whole file fits its grammar;
  // otherwise the raw <pre> is all there is and the toggle disappears.
  const rendered = useMemo(
    () => (experiment.learningsContent !== null ? stripLeadingTitle(experiment.learningsContent) : null),
    [experiment.learningsContent],
  )
  const renderable = useMemo(() => rendered !== null && parseMarkdownLite(rendered) !== null, [rendered])

  const handleDraft = async () => {
    setDrafting(true)
    const result = await onDraftLearnings(experiment.path)
    setDraftResult(result)
    setDrafting(false)
    if (result.ok) toast.success('LEARNINGS.md updated.')
    else toast.error(result.message ?? 'Draft learnings failed.')
  }

  const handleQueue = async () => {
    setQueuing(true)
    const result = await onQueueToInbox(experiment.path)
    setQueuing(false)
    if (!result.ok) toast.error(result.message ?? 'Queue to inbox failed.')
    else if (result.skippedDuplicate) toast.success('Already waiting in the inbox — nothing added.')
    else toast.success('Queued to the vault inbox for review.')
  }

  return (
    <article className="card experiment-detail">
      <div className="experiment-detail-eyebrow">{experiment.path}</div>

      <header className="experiment-detail-header">
        <div className="experiment-detail-headline">
          <div className="experiment-detail-title-row">
            <strong className="experiment-detail-name">{experiment.name}</strong>
            {experiment.hasLearnings && <span className="learnings-badge">learnings drafted</span>}
            {experiment.learningsStale && (
              <span
                className="stale-badge"
                title="A session progressed after LEARNINGS.md was drafted — re-draft to capture the ending."
              >
                draft predates latest session
              </span>
            )}
          </div>
          <div className="experiment-detail-byline">Last modified: {new Date(experiment.lastModified).toLocaleString()}</div>
        </div>
        <div className="experiment-action-cluster">
          <div className="experiment-action-row">
            <button className="btn-ghost" onClick={() => onOpenTerminal(experiment.path)}>
              Open Terminal
            </button>
            <button className="btn-ghost" onClick={handleDraft} disabled={busy}>
              {draftLabel}
            </button>
            {job && (
              <button className="btn-ghost" onClick={() => onCancelJob(job.id)}>
                Cancel
              </button>
            )}
            <button
              className="experiment-queue"
              onClick={handleQueue}
              disabled={queuing || !experiment.hasLearnings}
              title={!experiment.hasLearnings ? 'Draft learnings first' : undefined}
            >
              {queuing ? 'Queuing…' : 'Queue to Inbox'}
            </button>
          </div>
          <span className="experiment-cta-hint">
            Sends LEARNINGS.md to the vault inbox for review — nothing is written to the vault directly.
          </span>
        </div>
      </header>

      {draftResult?.ok &&
        (draftResult.title ||
          (draftResult.bullets?.length ?? 0) > 0 ||
          (draftResult.critical?.length ?? 0) > 0 ||
          draftResult.stats) && (
          <div className="draft-summary">
            {draftResult.title && <strong className="draft-summary-title">{draftResult.title}</strong>}
            {draftResult.bullets && draftResult.bullets.length > 0 && (
              <ul className="draft-bullets">
                {draftResult.bullets.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            )}
            {draftResult.critical && draftResult.critical.length > 0 && (
              <ul className="draft-critical">
                {draftResult.critical.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            )}
            {draftResult.stats && (
              <div className="draft-stats">
                Drafted from {draftResult.stats.sessions} session{draftResult.stats.sessions === 1 ? '' : 's'} ·{' '}
                {draftResult.stats.chars.toLocaleString()} chars
                {draftResult.stats.truncated && ' · older material truncated'}
              </div>
            )}
          </div>
        )}

      <div className="experiment-detail-learnings">
        <div className="experiment-learnings-head">
          <span className="experiment-detail-label">Learnings</span>
          {experiment.hasLearnings && renderable && (
            <button type="button" className="experiment-raw-toggle" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? 'view formatted' : 'view raw'}
            </button>
          )}
        </div>
        {experiment.hasLearnings ? (
          showRaw || !renderable ? (
            <pre className="experiment-learnings-body">{experiment.learningsContent}</pre>
          ) : (
            <div className="experiment-learnings-scroll">
              <MarkdownLite source={rendered ?? ''} className="experiment-learnings-prose" />
            </div>
          )
        ) : (
          // Says what the action actually reads, so a run that comes back
          // "nothing to summarize" is explicable rather than a dead button —
          // an empty folder and an undrafted one look identical from here.
          <EmptyState
            glyph={<SandboxIcon />}
            title="No LEARNINGS.md in this folder"
            hint="Draft Learnings reads this experiment's Claude Code sessions and git history and writes the file. If nothing has happened here yet, open a terminal and do the work first — there'd be nothing to read."
            action={
              <button className="btn-ghost" onClick={handleDraft} disabled={busy}>
                {draftLabel}
              </button>
            }
          />
        )}
      </div>
    </article>
  )
}
