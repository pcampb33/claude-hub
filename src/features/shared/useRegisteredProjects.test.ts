import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, stubHubApi } from '../test-dom.ts'

// Round 1's blind-grader find, open through two audit rounds: a rejected
// listProjects left `projects` at [] forever, and both callers render that
// list into a <select> — so a failed read looked exactly like an empty
// registry, with Sessions' Start button disabled and nothing saying why.
installDom()
const { renderHook, act } = await import('@testing-library/react')

async function freshHook() {
  // sharedRead caches per key across the module's lifetime, so each test needs
  // its own module instance or the second one joins the first one's answer.
  const mod = await import(`./useRegisteredProjects.ts?t=${Math.random()}`)
  return mod.useRegisteredProjects as () => { projects: unknown[]; loading: boolean; error: string | null }
}

test('a failed project list reports the error instead of an empty registry', async () => {
  stubHubApi({ listProjects: () => Promise.reject(new Error('registry unreadable')) })
  const useRegisteredProjects = await freshHook()

  const { result } = renderHook(() => useRegisteredProjects())
  await act(async () => {
    await Promise.resolve()
  })

  assert.equal(result.current.error, 'registry unreadable')
  assert.equal(result.current.loading, false)
  assert.deepEqual(result.current.projects, []) // empty, but never on its own
})

test('a successful read is data, not an error', async () => {
  const list = [{ id: 'a', name: 'claude-hub', path: 'C:\\projects\\claude-hub' }]
  stubHubApi({ listProjects: () => Promise.resolve(list) })
  const useRegisteredProjects = await freshHook()

  const { result } = renderHook(() => useRegisteredProjects())
  await act(async () => {
    await Promise.resolve()
  })

  assert.deepEqual(result.current.projects, list)
  assert.equal(result.current.loading, false)
  assert.equal(result.current.error, null)
})
