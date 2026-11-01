import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, stubHubApi } from '../test-dom.ts'

// Pins the two catches that turned a failed read into a confident absence:
// listSessions rejecting set [], which the pane renders as "No sessions
// found.", and readSession rejecting set [], which leaves TranscriptView a
// blank pane. Both are the bug class CLAUDE.md forbids — a failure rendered
// as an answer.
installDom()
const { renderHook, act } = await import('@testing-library/react')
const { useSessionHistory } = await import('./useSessionHistory.ts')

const PROJECT = 'C:\\projects\\claude-hub'

test('a failed session listing reports the error and never claims zero sessions', async () => {
  let fail = true
  const summaries = [{ id: 's1', title: 'a session', date: '2026-08-20T10:00:00.000Z' }]
  stubHubApi({
    listSessions: () => (fail ? Promise.reject(new Error('EPERM reading sessions dir')) : Promise.resolve(summaries)),
  })

  const { result } = renderHook(() => useSessionHistory(PROJECT, 'proj-1'))
  await act(async () => {
    await result.current.loadSessions()
  })

  assert.equal(result.current.loadingSessions, false)
  assert.equal(result.current.sessionsError, 'EPERM reading sessions dir')
  // The bug: this was [], and SessionHistory says "No sessions found." on it.
  assert.equal(result.current.sessions, null)

  // The error path stays retryable — a later success clears it.
  fail = false
  await act(async () => {
    await result.current.loadSessions()
  })
  assert.equal(result.current.sessionsError, null)
  assert.equal(result.current.sessions, summaries)
})

test('a failed transcript read reports the error and never claims an empty transcript', async () => {
  stubHubApi({ readSession: () => Promise.reject(new Error('unreadable jsonl')) })

  const { result } = renderHook(() => useSessionHistory(PROJECT, 'proj-1'))
  await act(async () => {
    result.current.toggleSession('s1')
  })

  assert.equal(result.current.loadingTranscript, false)
  assert.equal(result.current.transcriptError, 'unreadable jsonl')
  // The bug: this was [], which renders as a session that said nothing.
  assert.equal(result.current.transcript, null)
})

// The Projects tab is the only place an older session can be deleted from (the
// Sessions view lists the newest 40 across all projects). A failed delete must
// leave the row and say why; a landed one must re-read the list, not trust it.
test('deleteSession keeps the row on failure and re-reads the list on success', async () => {
  const { getToasts } = await import('../shared/toast.ts')
  let listing = [
    { id: 's1', title: 'keep me', date: '2026-08-20T10:00:00.000Z' },
    { id: 's2', title: 'delete me', date: '2026-08-19T10:00:00.000Z' },
  ]
  let fail = true
  const deleted: Array<[string, string]> = []
  stubHubApi({
    listSessions: () => Promise.resolve(listing),
    readSession: () => Promise.resolve([]),
    deleteSession: (...args: unknown[]) => {
      const [projectId, sessionId] = args as [string, string]
      if (fail) return Promise.reject(new Error('EBUSY: file is open'))
      deleted.push([projectId, sessionId])
      listing = listing.filter((s) => s.id !== sessionId)
      return Promise.resolve()
    },
  })

  const { result } = renderHook(() => useSessionHistory(PROJECT, 'proj-1'))
  await act(async () => {
    await result.current.loadSessions()
    result.current.toggleSession('s2')
  })

  await act(async () => {
    await result.current.deleteSession('s2')
  })
  assert.equal(result.current.sessions?.length, 2, 'a failed delete must not drop the row')
  assert.equal(result.current.openSessionId, 's2')
  assert.ok(getToasts().some((t) => t.kind === 'error' && t.message.includes('EBUSY')))

  fail = false
  await act(async () => {
    await result.current.deleteSession('s2')
  })
  assert.deepEqual(deleted, [['proj-1', 's2']])
  assert.deepEqual(
    result.current.sessions?.map((s) => s.id),
    ['s1'],
  )
  assert.equal(result.current.openSessionId, null, 'the deleted session must not stay open')
})
