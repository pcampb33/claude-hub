import type { JobFreshness } from '../../../shared/ipc-types'
import type { FreshnessSummary } from './useJobFreshness'

// One line under the vault card: do the jobs that produce these numbers still
// run? Collapsed to a single sentence (worst state first), one disclosure away
// from the per-job reason, which is `detail` verbatim — the main process wrote
// it to be read, and paraphrasing it here would lose why it says what it says.

export function AutomationFreshness({
  jobs,
  loading,
  error,
  summary,
}: {
  jobs: JobFreshness[] | null
  loading: boolean
  error: string | null
  summary: FreshnessSummary | null
}) {
  if (loading) return <p className="automation-freshness pending">Checking the jobs behind these numbers…</p>

  // Never "all jobs healthy" — the check itself is what failed, so say that and
  // leave the numbers below unvouched-for.
  if (error)
    return (
      <p className="automation-freshness unreachable">
        <span className="automation-dot unknown" />
        Could not check whether the jobs behind these numbers ran — {error}
      </p>
    )

  if (!jobs || !summary) return null

  const anyUnknown = jobs.some((j) => j.state === 'unknown')

  return (
    <details className="automation-freshness">
      <summary className="automation-summary">
        <span className={`automation-dot ${summary.tone}`} />
        {summary.text}
      </summary>
      <ul className="automation-jobs">
        {jobs.map((j) => (
          <li key={j.id} className="automation-job">
            <span className={`automation-state ${j.state}`}>{j.state}</span>
            <span className="automation-label">{j.label}</span>
            <span className="automation-detail">{j.detail}</span>
            {/* `detail` is always a recency sentence. The job's own last dated
                line is the only field that says WHAT happened — it was being
                fetched over IPC and dropped one component short of the screen. */}
            {j.lastLine && <span className="automation-lastline">{j.lastLine}</span>}
          </li>
        ))}
      </ul>
      {anyUnknown && (
        <p className="automation-note">
          <b>unknown</b> is not <i>fine</i>: either the log that would answer it is missing, empty or undated, or a run
          started recently and has not reported an outcome yet — so nobody can tell whether that job ran. Anything it
          feeds is unverified, not current.
        </p>
      )}
    </details>
  )
}
