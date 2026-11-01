import { useAllProjectsConfigHealth, type ProjectWithConfigHealth } from '../../../shared/useAllProjectsConfigHealth'
import { useAllProjectsStatus, type ProjectWithStatus } from '../../../shared/useAllProjectsStatus'

// The two per-project fan-outs, folded into the same three states as the
// Home reads. A failed refresh is an error even while cached entries remain:
// the map must not present a stale fleet as current without saying so.
export type FanRead<T> =
  | { status: 'loading'; retry: () => void }
  | { status: 'error'; error: string; retry: () => void }
  | { status: 'data'; data: T; retry: () => void }

function fold<T>(f: { entries: T; loading: boolean; error: string | null; refresh: () => Promise<void> }, empty: boolean): FanRead<T> {
  const retry = () => void f.refresh()
  if (f.error) return { status: 'error', error: f.error, retry }
  if (f.loading && empty) return { status: 'loading', retry }
  return { status: 'data', data: f.entries, retry }
}

export function useHealthFan(): FanRead<ProjectWithConfigHealth[]> {
  const f = useAllProjectsConfigHealth()
  return fold(f, f.entries.length === 0)
}

export function useGitFan(): FanRead<ProjectWithStatus[]> {
  const f = useAllProjectsStatus()
  return fold(f, f.entries.length === 0)
}
