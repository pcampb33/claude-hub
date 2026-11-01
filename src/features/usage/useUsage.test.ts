import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, stubHubApi } from '../test-dom.ts'
import type { UsageReport } from '../../../shared/ipc-types.ts'

// The two ways this view could render a failure as an absence: a rejected
// getUsage leaving the skeleton up forever (or an empty chart), and an index
// that is still building read as "no usage".
installDom()
const { renderHook, waitFor } = await import('@testing-library/react')
const { useUsage } = await import('./useUsage.ts')

const coverage = { filesIndexed: 3, filesUnreadable: 0, firstIso: null, lastIso: null, indexedSinceIso: null }
const indexing: UsageReport = { state: 'indexing', progress: { done: 10, total: 100 }, error: null, coverage, series: [], buckets: [], totals: {} }
const ready: UsageReport = {
  state: 'ready',
  error: null,
  coverage,
  series: [{ key: 'project:a', name: 'a', kind: 'project' }],
  buckets: [{ startIso: '2026-10-18T00:00:00.000Z', values: { 'project:a': { processed: 5, output: 1, activeMinutes: 1 } } }],
  totals: { 'project:a': { processed: 5, output: 1, activeMinutes: 1, sessions: 1 } },
}

test('a rejected read ends in the error state with the reason, not in loading', async () => {
  stubHubApi({ getUsage: () => Promise.reject(new Error('index unreadable')) })
  const { result } = renderHook(() => useUsage('day', 30))
  await waitFor(() => assert.equal(result.current.state.status, 'error'))
  assert.equal(result.current.state.error, 'index unreadable')
})

test('while the index builds, the hook polls until the report is ready', async () => {
  const calls: unknown[] = []
  stubHubApi({
    getUsage: (q: unknown) => {
      calls.push(q)
      return Promise.resolve(calls.length < 2 ? indexing : ready)
    },
  })
  const { result } = renderHook(() => useUsage('week', 12))
  await waitFor(() => assert.equal(result.current.state.data?.state, 'indexing'))
  await waitFor(() => assert.equal(result.current.state.data?.state, 'ready'), { timeout: 3000 })
  assert.deepEqual(calls[0], { granularity: 'week', periods: 12 })
  assert.equal(result.current.state.data?.totals['project:a'].processed, 5)
})
