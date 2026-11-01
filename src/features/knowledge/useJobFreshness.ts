import { useEffect, useState } from 'react'
import type { JobFreshness } from '../../../shared/ipc-types'

// Freshness of the background jobs that produce this view's numbers (electron/
// job-freshness.ts). Three states, not two: on 2026-08-22 the vault linker's
// scheduled task fired, wrote no log line, and the Knowledge view showed its
// edge count as though current. A failed read here must not repeat that at one
// remove — "could not check" is its own answer, never "all jobs healthy".

export type FreshnessTone = 'current' | 'stale' | 'unknown'

export interface FreshnessSummary {
  tone: FreshnessTone
  text: string
}

// Worst state first, and name the job when only one is at fault — the log line
// it failed to write IS the finding, so the collapsed line should already say
// it. `unknown` is counted apart from `current` on purpose: folding it into
// either one rebuilds the bug this whole feature exists to surface.
function summarize(jobs: JobFreshness[]): FreshnessSummary {
  const stale = jobs.filter((j) => j.state === 'stale')
  const unknown = jobs.filter((j) => j.state === 'unknown')

  if (stale.length > 0) {
    const text =
      stale.length === 1
        ? `${stale[0].label} is stale — ${stale[0].detail}`
        : `${stale.length} background jobs are stale`
    return { tone: 'stale', text: unknown.length > 0 ? `${text} · ${unknown.length} more cannot be checked` : text }
  }

  if (unknown.length > 0) {
    return {
      tone: 'unknown',
      text:
        unknown.length === 1
          ? `Cannot tell whether ${unknown[0].label} ran — ${unknown[0].detail}`
          : `${unknown.length} of ${jobs.length} background jobs cannot be checked`,
    }
  }

  return { tone: 'current', text: `${jobs.length} background jobs reporting` }
}

export function useJobFreshness() {
  const [jobs, setJobs] = useState<JobFreshness[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.hubApi.getJobFreshness().then(
      (result) => {
        if (cancelled) return
        setJobs(result)
        setLoading(false)
      },
      (err) => {
        if (cancelled) return
        // jobs stays null: there is no partial truth to show, and an empty
        // list would render as "nothing to report" about a read that failed.
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  return { jobs, loading, error, summary: jobs ? summarize(jobs) : null }
}
