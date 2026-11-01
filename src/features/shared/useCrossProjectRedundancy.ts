import { useEffect, useState } from 'react'
import type { CrossProjectRedundancyFinding } from '../../../shared/ipc-types'

// getCrossProjectRedundancy() scans and re-shingles every registered
// project's CLAUDE.md — cheap (18ms measured at 16 registered projects,
// 5 with a CLAUDE.md) but global, not per-project. Fetched once here at
// the list level and handed down, rather than each project card's
// ConfigHealth panel independently re-triggering the same full rescan
// every time it's expanded.
//
// Three states, not two. The `.then()` here had no `.catch`, so a rejected
// scan left `findings` at its initial [] — which every consumer renders as
// "no duplicate config found". That is a claim about an overlap nobody
// measured, and it silently deletes the dashboard's own overlap card. The
// `loaded` flag was returned but read by nobody, so there was not even a way
// to tell the two apart downstream.
export function useCrossProjectRedundancy() {
  const [findings, setFindings] = useState<CrossProjectRedundancyFinding[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.hubApi
      .getCrossProjectRedundancy()
      .then((report) => {
        setFindings(report.findings)
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  return { findings, error, loading: findings === null && error === null }
}
