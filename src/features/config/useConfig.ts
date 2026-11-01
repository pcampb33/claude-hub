import { useCallback, useEffect, useState } from 'react'
import type { BoundaryAudit, BoundaryView, DesktopLaunchTargets, DesktopTargetRef, ProjectConfigReport } from '../../../shared/ipc-types'
import { targetParam } from './config-model.ts'

export type Fetched<T> = { status: 'loading' } | { status: 'error'; error: string } | { status: 'data'; data: T }

// IPC rejections arrive as "Error invoking remote method '<channel>': Error: <message>".
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

// One read, three states, re-run whenever `key` changes or on retry. A stale
// answer (the key moved on while it was in flight) is dropped.
function useFetched<T>(key: string | null, load: () => Promise<T>): { state: Fetched<T>; retry: () => void } {
  const [state, setState] = useState<Fetched<T>>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (key === null) return
    let live = true
    setState({ status: 'loading' })
    load().then(
      (data) => live && setState({ status: 'data', data }),
      (err: unknown) => live && setState({ status: 'error', error: errorText(err) }),
    )
    return () => {
      live = false
    }
    // `load` closes over the same inputs `key` encodes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { state, retry }
}

export function useConfigTargets() {
  return useFetched<DesktopLaunchTargets>('targets', () => window.hubApi.listDesktopTargets())
}

export type BoundaryEntry = { status: 'error'; error: string } | { status: 'data'; data: BoundaryView }

// Every target's boundary, read once the list arrives, so the list can show
// tier chips. A missing entry is still loading; an error entry is a read
// that failed, never a default tier.
export function useBoundaries(targets: DesktopTargetRef[] | null) {
  const [entries, setEntries] = useState<Record<string, BoundaryEntry>>({})
  const read = useCallback((t: DesktopTargetRef) => {
    const k = targetParam(t)
    setEntries((prev) => {
      const next = { ...prev }
      delete next[k]
      return next
    })
    window.hubApi.getBoundary(t).then(
      (data) => setEntries((prev) => ({ ...prev, [k]: { status: 'data', data } })),
      (err: unknown) => setEntries((prev) => ({ ...prev, [k]: { status: 'error', error: errorText(err) } })),
    )
  }, [])
  useEffect(() => {
    targets?.forEach(read)
  }, [targets, read])
  const put = useCallback((view: BoundaryView) => {
    setEntries((prev) => ({ ...prev, [targetParam(view.boundary.target)]: { status: 'data', data: view } }))
  }, [])
  return { entries, retry: read, put }
}

export function useProjectConfig(target: DesktopTargetRef | null) {
  return useFetched<ProjectConfigReport>(target && targetParam(target), () => window.hubApi.getProjectConfig(target!))
}

export function useBoundaryAudit(target: DesktopTargetRef | null, days: number) {
  return useFetched<BoundaryAudit>(target && `${targetParam(target)}|${days}`, () => window.hubApi.auditBoundary(target!, days))
}
