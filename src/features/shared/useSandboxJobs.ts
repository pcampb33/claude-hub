import { useEffect, useState } from 'react'
import type { SandboxJob } from '../../../shared/ipc-types'

// Live view of running Draft Learnings jobs — seeded by a pull, kept fresh
// by the sandbox:jobs-changed push. Lives in shared/ because both the app
// shell (nav indicator) and the sandbox view subscribe.
export function useSandboxJobs(): SandboxJob[] {
  const [jobs, setJobs] = useState<SandboxJob[]>([])

  useEffect(() => {
    let disposed = false
    let pushed = false
    const off = window.hubApi.onSandboxJobsChanged((next) => {
      pushed = true
      setJobs(next)
    })
    // A push that lands while the seed pull is in flight is newer than the
    // pull's answer — don't let the slower seed overwrite it.
    window.hubApi.listSandboxJobs().then((initial) => {
      if (!disposed && !pushed) setJobs(initial)
    })
    return () => {
      disposed = true
      off()
    }
  }, [])

  return jobs
}
