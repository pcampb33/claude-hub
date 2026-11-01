import { useCallback, useEffect, useState } from 'react'
import { toast } from '../shared/toast'
import type { VaultInboxEntry, VaultInboxReport, VaultWriteResult } from '../../../shared/ipc-types'

export function useInbox() {
  const [inbox, setInbox] = useState<VaultInboxReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setInbox(await window.hubApi.getVaultInbox())
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

  // Failure toasts live here; success feedback is the caller's (the view owns
  // the approve toast with its "View in Knowledge →" stitch and the tally).
  const resolve = useCallback(
    async (entry: VaultInboxEntry, action: 'approve' | 'reject'): Promise<VaultWriteResult> => {
      const res = await window.hubApi.resolveInboxEntry(entry.sessionId, entry.title, action)
      // Await the refetch so the caller's busy flag holds until the queue
      // reflects the resolve — otherwise a double-press in the stale window
      // re-resolves the removed entry ("Entry not found" right after success).
      if (res.ok) await refresh()
      else toast.error(res.message ?? 'Could not resolve entry.')
      return res
    },
    [refresh],
  )

  return { inbox, loading, error, refresh, resolve }
}
