import { useCallback, useState } from 'react'
import type { VaultInboxEntry } from '../../../../../shared/ipc-types'
import { KEYS } from '../../reads'
import { invalidateHubRead } from '../../useHubRead'
import { toast } from '../../../shared/toast'
import { entryKey, shortTitle, writeToast } from './model'

// Add to vault / Discard for one inbox entry. One write at a time: while it
// is in flight `pending` holds its key and every button disables. On success
// the inbox read is invalidated, so this card, Needs you and the headline all
// move together; on failure the entry stays where it is.
export function useResolveInbox() {
  const [pending, setPending] = useState<string | null>(null)

  const resolve = useCallback((e: VaultInboxEntry, action: 'approve' | 'reject') => {
    setPending(entryKey(e))
    const name = shortTitle(e.title)
    window.hubApi
      .resolveInboxEntry(e.sessionId, e.title, action)
      .then(
        (result) => {
          const t = writeToast(result, action === 'approve' ? `Added “${name}” to the vault` : `Discarded “${name}”`)
          toast[t.kind](t.message)
          if (result.ok) {
            invalidateHubRead(KEYS.inbox)
            if (action === 'approve') invalidateHubRead(KEYS.vaultGraph)
          }
        },
        (err: unknown) =>
          toast.error(
            `Couldn’t ${action === 'approve' ? 'add' : 'discard'} “${name}”: ${err instanceof Error ? err.message : String(err)}`,
          ),
      )
      .finally(() => setPending(null))
  }, [])

  return { pending, resolve }
}
