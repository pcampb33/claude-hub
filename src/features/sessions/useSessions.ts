import { useCallback, useEffect, useState } from 'react'
import { toast } from '../shared/toast'
import type { SessionListEntry } from '../../../shared/ipc-types'

// Every recent session read from the transcripts on disk, each with its own
// live state.
export function useSessions() {
  const [entries, setEntries] = useState<SessionListEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setEntries(await window.hubApi.listAllSessions())
      setError(null)
    } catch (err) {
      // Don't strand the view on a disabled "Loading…" (see useFloorStatus).
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Sends the session's transcript (and its subagents) to the recycle bin.
  // Returns whether it actually went — the caller navigates off the detail
  // pane on success, and must not do that when the delete failed and the
  // session is still there.
  const remove = useCallback(
    async (entry: SessionListEntry): Promise<boolean> => {
      try {
        await window.hubApi.deleteSession(entry.projectId, entry.sessionId)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not delete that session.')
        return false
      }
      toast.success('Session history moved to the recycle bin.')
      await refresh()
      return true
    },
    [refresh],
  )

  return { entries, loading, error, refresh, remove }
}
