import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, stubHubApi } from '../test-dom.ts'

// The first renderer-hook test in the codebase (option AT). It pins the bug
// fixed by hand in tick 18: a rejected getConfigHealth left `loading` true
// forever, so the health ring spun for that project and the UI said "still
// scanning" about a scan that had already failed.
installDom()
const { renderHook, act } = await import('@testing-library/react')
const { useConfigHealth } = await import('./useConfigHealth.ts')

test('a failed scan stops loading and reports the error', async () => {
  stubHubApi({ getConfigHealth: () => Promise.reject(new Error('git exploded')) })

  const { result } = renderHook(() => useConfigHealth('C:\\projects\\claude-hub'))
  await act(async () => {
    await result.current.load()
  })

  // The bug: this stayed true, and the caller renders a spinner on it.
  assert.equal(result.current.loading, false)
  assert.equal(result.current.error, 'git exploded')
  assert.equal(result.current.report, null)
})

test('a successful scan clears a previous error', async () => {
  const report = { score: 90, findings: [] }
  let fail = true
  stubHubApi({
    getConfigHealth: () => (fail ? Promise.reject(new Error('transient')) : Promise.resolve(report)),
  })

  const { result } = renderHook(() => useConfigHealth('C:\\projects\\claude-hub'))
  await act(async () => {
    await result.current.load()
  })
  assert.equal(result.current.error, 'transient')

  fail = false
  await act(async () => {
    await result.current.load()
  })
  assert.equal(result.current.report, report)
  assert.equal(result.current.error, null)
  assert.equal(result.current.loading, false)
})
