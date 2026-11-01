import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DesktopSnapshot } from '../../../shared/ipc-types.ts'
import { installDom, stubHubApi } from '../test-dom.ts'

installDom()
const { renderHook, act } = await import('@testing-library/react')
const { useDesktop, useDesktopNeedsCount } = await import('./useDesktop.ts')

const snapshot = (needs: number): DesktopSnapshot => ({
  host: { state: 'up', error: null },
  records: { error: null },
  sessions: Array.from({ length: needs }, (_, i) => ({
    id: `d${i}`,
    claudeSessionId: `c${i}`,
    name: `s${i}`,
    color: 'frost',
    slot: i + 1,
    target: { kind: 'project', key: 'p' },
    targetName: 'p',
    poppedOut: false,
    tier: null,
    createdAtIso: '2026-10-18T10:00:00.000Z',
    alive: true,
    state: 'needs-you',
    stateDetail: null,
    lastActivityIso: null,
    contextPct: null,
    exitCode: null,
  })),
  outside: { sessions: [], error: null },
})

const flush = () =>
  act(async () => {
    await Promise.resolve()
  })

test('a rejected getDesktop is an error state, never an empty desktop', async () => {
  stubHubApi({ onDesktopUpdate: () => () => {}, getDesktop: () => Promise.reject(new Error('host crashed')) })
  const { result } = renderHook(() => useDesktop())
  assert.equal(result.current.state.status, 'loading')
  await flush()
  assert.deepEqual(result.current.state, { status: 'error', error: 'host crashed' })
})

test('a push that lands before the seed resolves wins over the older seed', async () => {
  let push: (s: DesktopSnapshot) => void = () => {}
  let resolveSeed: (s: DesktopSnapshot) => void = () => {}
  stubHubApi({
    onDesktopUpdate: (listener) => {
      push = listener as typeof push
      return () => {}
    },
    getDesktop: () => new Promise((resolve) => (resolveSeed = resolve)),
  })
  const { result } = renderHook(() => useDesktop())
  await act(async () => push(snapshot(2)))
  await act(async () => resolveSeed(snapshot(0)))
  assert.equal(result.current.state.status, 'data')
  assert.equal(result.current.state.status === 'data' && result.current.state.snapshot.sessions.length, 2)
})

test('the rail count is null (hidden) when the read fails, and follows pushes', async () => {
  let push: (s: DesktopSnapshot) => void = () => {}
  stubHubApi({
    onDesktopUpdate: (listener) => {
      push = listener as typeof push
      return () => {}
    },
    getDesktop: () => Promise.reject(new Error('nope')),
  })
  const { result } = renderHook(() => useDesktopNeedsCount())
  await flush()
  assert.equal(result.current, null)
  await act(async () => push(snapshot(3)))
  assert.equal(result.current, 3)
})
