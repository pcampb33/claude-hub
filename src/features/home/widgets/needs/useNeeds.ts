import { useCallback, useEffect, useMemo } from 'react'
import { useExtensionsRead, useFloorRead, useGlobalConfigRead, useInboxRead, useRecallRead } from '../../reads'
import { useAllProjectsConfigHealth } from '../../../shared/useAllProjectsConfigHealth'
import { useOnBoard } from '../../frame-context'
import { buildNeeds, type HealthEntry, type NeedsSummary, type SourceKey, type SourceRead } from './needs-core'

// One summary for the widget, its peek and the headline. The reads are
// shared by key, so mounting all three asks each question once.
export function useNeeds(): NeedsSummary & { retry: (source: SourceKey) => void } {
  const inbox = useInboxRead()
  const automations = useGlobalConfigRead()
  const floors = useFloorRead()
  const extensions = useExtensionsRead()
  const recall = useRecallRead()
  const fan = useAllProjectsConfigHealth()

  // A health check runs in the background (~7s); re-read until it lands so
  // "still checking extensions" resolves without leaving Home. Instances
  // share the read, and sharedRead joins in-flight requests.
  const checking = extensions.data?.health.state === 'running'
  const refreshExtensions = extensions.refresh
  useEffect(() => {
    if (!checking) return
    const timer = setTimeout(refreshExtensions, 5000)
    return () => clearTimeout(timer)
  }, [checking, refreshExtensions, extensions.data])

  // The fan-out has its own loading/error flags; fold them into the same
  // three states. A failed refresh is an error even with cached entries.
  const health: SourceRead<HealthEntry[]> = useMemo(() => {
    if (fan.error) return { status: 'error', error: fan.error }
    if (fan.loading && fan.entries.length === 0) return { status: 'loading', error: null }
    return { status: 'data', data: fan.entries, error: null }
  }, [fan.error, fan.loading, fan.entries])

  const inboxOnBoard = useOnBoard('inbox')
  const summary = useMemo(
    () => buildNeeds({ inbox, automations, floors, health, extensions, recall }, Date.now(), { inboxOnBoard }),
    [inbox, automations, floors, health, extensions, recall, inboxOnBoard],
  )

  const refreshFan = fan.refresh
  const retry = useCallback(
    (source: SourceKey) => {
      const refresh = {
        inbox: inbox.refresh,
        automations: automations.refresh,
        floors: floors.refresh,
        extensions: extensions.refresh,
        recall: recall.refresh,
        health: () => void refreshFan(),
      }[source]
      refresh()
    },
    [inbox.refresh, automations.refresh, floors.refresh, extensions.refresh, recall.refresh, refreshFan],
  )

  return { ...summary, retry }
}
