import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, stubHubApi } from '../test-dom.ts'

// The freshness readout exists because a job that stops running does not
// announce itself. These pin the two ways this feature could rebuild that bug
// at one remove: an `unknown` job summarised as though it were fine, and a
// failed getJobFreshness() rendering as "all jobs reporting".
installDom()
const { renderHook, waitFor } = await import('@testing-library/react')
const { useJobFreshness } = await import('./useJobFreshness.ts')

const job = (over: Partial<{ id: string; label: string; state: string; detail: string }>) => ({
  id: 'linker',
  label: 'Vault linker (daily 04:30)',
  state: 'current',
  detail: 'last output 2.0h ago',
  lastLine: null,
  lastRunIso: null,
  hoursSince: null,
  spend: null,
  ...over,
})

test('an unknown job is neither current nor stale in the summary', async () => {
  stubHubApi({
    getJobFreshness: () =>
      Promise.resolve([
        job({}),
        job({
          id: 'drain',
          label: 'Inbox drain (daily noon)',
          state: 'unknown',
          detail: 'no log at scripts/drain-inbox.log',
        }),
      ]),
  })

  const { result } = renderHook(() => useJobFreshness())
  await waitFor(() => assert.equal(result.current.loading, false))

  assert.equal(result.current.summary?.tone, 'unknown')
  // The reason is shown verbatim, and the healthy job never buys the unknown
  // one a pass ("2 background jobs reporting" would be the bug).
  assert.equal(
    result.current.summary?.text,
    'Cannot tell whether Inbox drain (daily noon) ran — no log at scripts/drain-inbox.log',
  )
})

test('a stale job outranks an unknown one but does not hide it', async () => {
  stubHubApi({
    getJobFreshness: () =>
      Promise.resolve([
        job({ state: 'stale', detail: 'last output 27.4h ago; expected every 24h' }),
        job({ id: 'drain', state: 'unknown', detail: 'log exists but is empty' }),
      ]),
  })

  const { result } = renderHook(() => useJobFreshness())
  await waitFor(() => assert.equal(result.current.loading, false))

  assert.equal(result.current.summary?.tone, 'stale')
  assert.match(result.current.summary!.text, /1 more cannot be checked$/)
})

test('a failed check reports itself instead of vouching for the jobs', async () => {
  stubHubApi({ getJobFreshness: () => Promise.reject(new Error('logs unreadable')) })

  const { result } = renderHook(() => useJobFreshness())
  await waitFor(() => assert.equal(result.current.loading, false))

  assert.equal(result.current.error, 'logs unreadable')
  // Not [] — an empty list renders as "nothing to report" about a read that
  // never happened, and summary must not manufacture a verdict from it.
  assert.equal(result.current.jobs, null)
  assert.equal(result.current.summary, null)
})

test('all jobs reporting is the only case that reads as fine', async () => {
  stubHubApi({
    getJobFreshness: () => Promise.resolve([job({}), job({ id: 'curate', state: 'event-driven' })]),
  })

  const { result } = renderHook(() => useJobFreshness())
  await waitFor(() => assert.equal(result.current.loading, false))

  assert.equal(result.current.summary?.tone, 'current')
  assert.equal(result.current.summary?.text, '2 background jobs reporting')
})
