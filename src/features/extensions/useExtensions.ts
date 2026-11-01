import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExtensionsSnapshot } from '../../../shared/ipc-types'
import { invalidateHubRead } from '../home/useHubRead'
import { KEYS } from '../home/reads'
import { toast } from '../shared/toast'

// While the main process is still checking servers or scanning transcripts,
// re-read on this cadence so the page fills in by itself. getExtensions is
// cheap (~1s) and never waits for either job.
const POLL_MS = 3000

export type ExtensionsState =
  | { status: 'loading'; data: undefined; error: null }
  | { status: 'error'; data: ExtensionsSnapshot | undefined; error: string }
  | { status: 'data'; data: ExtensionsSnapshot; error: null }

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function useExtensions() {
  const [state, setState] = useState<ExtensionsState>({ status: 'loading', data: undefined, error: null })
  const [rechecking, setRechecking] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const accept = useCallback((snap: ExtensionsSnapshot) => {
    if (alive.current) setState({ status: 'data', data: snap, error: null })
  }, [])
  // Keeps the last snapshot next to the error: a failed refresh doesn't
  // erase what was already known, but it is always shown.
  const fail = useCallback((err: unknown) => {
    if (alive.current) setState((prev) => ({ status: 'error', data: prev.data, error: messageOf(err) }))
  }, [])

  const load = useCallback(() => window.hubApi.getExtensions().then(accept, fail), [accept, fail])

  useEffect(() => {
    void load()
  }, [load])

  const snap = state.data
  const pending = !!snap && (snap.health.state === 'running' || !!snap.usage.running)
  useEffect(() => {
    if (!pending || rechecking) return
    const t = setTimeout(() => void load(), POLL_MS)
    return () => clearTimeout(t)
  }, [pending, rechecking, snap, load])

  const recheck = useCallback(async () => {
    setRechecking(true)
    try {
      accept(await window.hubApi.recheckExtensions())
      invalidateHubRead(KEYS.extensions)
    } catch (err) {
      fail(err)
    } finally {
      if (alive.current) setRechecking(false)
    }
  }, [accept, fail])

  const setPluginEnabled = useCallback(
    async (pluginId: string, enabled: boolean) => {
      setToggling(pluginId)
      try {
        accept(await window.hubApi.setPluginEnabled(pluginId, enabled))
        invalidateHubRead(KEYS.extensions)
        toast.success(`${enabled ? 'Enabled' : 'Disabled'} ${pluginId}. New sessions pick it up.`)
      } catch (err) {
        toast.error(`Couldn’t ${enabled ? 'enable' : 'disable'} ${pluginId}: ${messageOf(err)}`)
      } finally {
        if (alive.current) setToggling(null)
      }
    },
    [accept],
  )

  return { state, rechecking, toggling, reload: load, recheck, setPluginEnabled }
}
