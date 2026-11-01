import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, stubHubApi } from '../test-dom.ts'

// Pins tick 24's AR: four .catch handlers set their corpus to [] on failure,
// which cmdk then renders as "No matches." — a claim about a corpus nobody
// managed to read. The fix records WHICH corpus failed; this test is the only
// automated thing standing between that and a silent regression.
installDom()
const { renderHook, act, waitFor } = await import('@testing-library/react')
const { useGlobalSearch } = await import('./useGlobalSearch.ts')

const ok = {
  getVaultGraph: () => Promise.resolve({ notes: [{ id: 'n', title: 'N', project: null, mtime: '2026-01-01' }] }),
  listSkills: () => Promise.resolve([]),
  listWorkflows: () => Promise.resolve([]),
  getSkillUsage: () => Promise.resolve([]),
  searchSessions: () => Promise.resolve({ matches: [], unscannedSessionCount: 0, oldestScanned: null }),
}

// The two usage tests have to run before the rest of the file: the usage index
// is memoized in module state, so a test that let it cache a success first
// would never reach the stub it is testing. In-file order is load-bearing here
// either way — stubHubApi swaps one global.
const twoSkills = [
  { name: 'older', mtime: '2026-01-01' },
  { name: 'newer', mtime: '2026-02-01' },
]

test('a failed usage fetch is named, not shown as every skill never used', async () => {
  stubHubApi({
    ...ok,
    listSkills: () => Promise.resolve(twoSkills),
    getSkillUsage: () => Promise.reject(new Error('usage index gone')),
  })

  const { result } = renderHook(() => useGlobalSearch(true, '', 'all'))
  await waitFor(() => assert.deepEqual(result.current.failed, ['skill usage']))

  // The skills themselves loaded — only their ranking is unknown. Emptying the
  // list, or passing folder-mtime order off as the measured one, would each be
  // the same wrong answer in a different shape.
  assert.deepEqual(
    result.current.skills.map((s) => s.name),
    ['newer', 'older'],
  )
})

test('a transient usage failure does not poison the rest of the session', async () => {
  let fail = true
  stubHubApi({
    ...ok,
    listSkills: () => Promise.resolve(twoSkills),
    getSkillUsage: () =>
      fail ? Promise.reject(new Error('transient')) : Promise.resolve([{ skill: 'older', lastUsed: '2026-03-01' }]),
  })

  const { result, rerender } = renderHook(({ open }: { open: boolean }) => useGlobalSearch(open, '', 'all'), {
    initialProps: { open: true },
  })
  await waitFor(() => assert.deepEqual(result.current.failed, ['skill usage']))

  // The rejection must not have been memoized: the next open asks again, and
  // the real ranking lands — 'older' was invoked, 'newer' never was.
  fail = false
  await act(async () => {
    rerender({ open: false })
  })
  await act(async () => {
    rerender({ open: true })
  })
  await waitFor(() =>
    assert.deepEqual(
      result.current.skills.map((s) => s.name),
      ['older', 'newer'],
    ),
  )
  assert.deepEqual(result.current.failed, [])
})

test('a corpus that fails to load is named, not silently emptied', async () => {
  stubHubApi({ ...ok, getVaultGraph: () => Promise.reject(new Error('vault gone')) })

  const { result } = renderHook(() => useGlobalSearch(true, '', 'all'))
  await waitFor(() => assert.deepEqual(result.current.failed, ['notes']))

  // The corpora that DID load are unaffected — the message must name only what
  // actually broke, not degrade the whole palette.
  assert.deepEqual(result.current.notes, [])
  assert.deepEqual(result.current.skills, [])
})

test('nothing failed means nothing to report', async () => {
  stubHubApi(ok)

  const { result } = renderHook(() => useGlobalSearch(true, '', 'all'))
  await waitFor(() => assert.equal(result.current.notes.length, 1))
  assert.deepEqual(result.current.failed, [])
})

// vault-graph sends a note's filename stem AS its title, so the palette used to
// label the same note differently from the Knowledge view — "Session JSONL- the
// entrypoint discriminator" against "Session JSONL: the entrypoint
// discriminator". Only vault notes get the transform: it would corrupt a
// session, skill or workflow name that legitimately contains "- ".
test('a note title arrives de-sanitised, the way the Knowledge view shows it', async () => {
  stubHubApi({
    ...ok,
    getVaultGraph: () =>
      Promise.resolve({
        // vault-graph sets title from the id, so the stubs do too.
        notes: ['Session JSONL- the entrypoint discriminator', 'Worktree removal- 64-nearest cap'].map(
          (id, i) => ({ id, title: id, project: null, mtime: `2026-01-0${2 - i}` }),
        ),
      }),
  })

  const { result } = renderHook(() => useGlobalSearch(true, '', 'all'))
  await waitFor(() => assert.equal(result.current.notes.length, 2))
  assert.deepEqual(
    result.current.notes.map((n) => n.title),
    ['Session JSONL: the entrypoint discriminator', 'Worktree removal: 64-nearest cap'],
  )
  // The id is the link target and must stay exactly as it is on disk — it is
  // what onNavigate resolves against.
  assert.equal(result.current.notes[0].id, 'Session JSONL- the entrypoint discriminator')
})

test('a failed transcript search clears once a later search succeeds', async () => {
  let fail = true
  stubHubApi({
    ...ok,
    searchSessions: () =>
      fail
        ? Promise.reject(new Error('search died'))
        : Promise.resolve({ matches: [], unscannedSessionCount: 0, oldestScanned: null }),
  })

  const { result, rerender } = renderHook(({ term }: { term: string }) => useGlobalSearch(true, term, 'all'), {
    initialProps: { term: 'judder' },
  })
  await waitFor(() => assert.deepEqual(result.current.failed, ['transcripts']))

  // A stale failure must not outlive the condition that caused it, or the
  // palette keeps apologising for a search that now works.
  fail = false
  await act(async () => {
    rerender({ term: 'judders' })
  })
  await waitFor(() => assert.deepEqual(result.current.failed, []))
})
