import { useEffect, useState } from 'react'
import type { VerifyJob } from '../../../shared/ipc-types'

// Live view of running Run-verify jobs — seeded by a pull, kept fresh by the
// floor:verify-jobs-changed push. Same shape as useSandboxJobs; jobs live in
// the main process, so a run survives navigating away from the project pane.
export function useVerifyJobs(): VerifyJob[] {
  const [jobs, setJobs] = useState<VerifyJob[]>([])

  useEffect(() => {
    let disposed = false
    let pushed = false
    const off = window.hubApi.onVerifyJobsChanged((next) => {
      pushed = true
      setJobs(next)
    })
    // A push that lands while the seed pull is in flight is newer than the
    // pull's answer — don't let the slower seed overwrite it.
    window.hubApi.listVerifyJobs().then((initial) => {
      if (!disposed && !pushed) setJobs(initial)
    })
    return () => {
      disposed = true
      off()
    }
  }, [])

  return jobs
}
