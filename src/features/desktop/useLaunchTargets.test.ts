import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, stubHubApi } from '../test-dom.ts'

installDom()
// jsdom reports a hidden document, which pauses the transcript refresh.
Object.defineProperty(document, 'hidden', { value: false, configurable: true })
const { renderHook, act } = await import('@testing-library/react')
const { useLaunchTargets, useOutsideTranscript } = await import('./useLaunchTargets.ts')

const flush = () =>
  act(async () => {
    await Promise.resolve()
  })

test('a rejected target list is an error state, never an empty launcher', async () => {
  stubHubApi({ listDesktopTargets: () => Promise.reject(new Error('registry unreadable')) })
  const { result } = renderHook(() => useLaunchTargets())
  assert.equal(result.current.state.status, 'loading')
  await flush()
  assert.deepEqual(result.current.state, { status: 'error', error: 'registry unreadable' })
})

test('a transcript read that fails first is an error; one that fails after data keeps the data', async () => {
  let fail = true
  stubHubApi({
    readSession: () => (fail ? Promise.reject(new Error('locked')) : Promise.resolve([{ role: 'user', text: 'hi', timestamp: 't' }])),
  })
  const render = () => renderHook(({ active }) => useOutsideTranscript('C:\\p', 's1', active), { initialProps: { active: true } })

  const first = render()
  try {
    await flush()
    assert.deepEqual(first.result.current, { status: 'error', error: 'locked' })
  } finally {
    first.unmount()
  }

  fail = false
  const second = render()
  try {
    await flush()
    assert.equal(second.result.current.status, 'data')
    // Pause the refresh, then fail the read it makes when it resumes.
    second.rerender({ active: false })
    fail = true
    second.rerender({ active: true })
    await flush()
    assert.equal(second.result.current.status === 'data' && second.result.current.refreshError, 'locked')
  } finally {
    second.unmount()
  }
})
