import { useCallback, useRef, useState } from 'react'
import { toast } from '../shared/toast.ts'
import type { SessionMessage, SessionSummary } from '../../../shared/ipc-types'

export function useSessionHistory(projectPath: string, projectId: string) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [sessionsError, setSessionsError] = useState<string | null>(null)
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<SessionMessage[] | null>(null)
  const [loadingTranscript, setLoadingTranscript] = useState(false)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const requestedSessionId = useRef<string | null>(null)

  // Three states, not two. This catch used to `setSessions([])` to clear the
  // spinner — but the finally already does that, so the empty array only ever
  // reached the pane, which renders it as "No sessions found.": a confident
  // claim about a directory nobody managed to read. A failed load keeps the
  // last good list (if any) and says what went wrong instead.
  const loadSessions = useCallback(async () => {
    setLoadingSessions(true)
    try {
      setSessions(await window.hubApi.listSessions(projectPath))
      setSessionsError(null)
    } catch (err) {
      setSessionsError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingSessions(false)
    }
  }, [projectPath])

  const loadTranscript = useCallback(
    async (sessionId: string) => {
      requestedSessionId.current = sessionId
      // Drop the previously open session's messages up front — otherwise a
      // failed read leaves the last session's transcript on screen under the
      // new row, beside an error about a different session.
      setTranscript(null)
      setTranscriptError(null)
      setLoadingTranscript(true)
      try {
        const messages = await window.hubApi.readSession(projectPath, sessionId)
        // A different session may have been requested while this was in
        // flight (e.g. a slow 22MB read overtaken by a click on a smaller
        // session) — discard the stale result rather than overwrite it.
        if (requestedSessionId.current !== sessionId) return
        setTranscript(messages)
      } catch (err) {
        // Same rule as loadSessions: an empty transcript is a claim, and a
        // failed read has not earned it.
        if (requestedSessionId.current !== sessionId) return
        setTranscriptError(err instanceof Error ? err.message : String(err))
      } finally {
        if (requestedSessionId.current === sessionId) setLoadingTranscript(false)
      }
    },
    [projectPath],
  )

  const toggleSession = useCallback(
    (sessionId: string) => {
      if (openSessionId === sessionId) {
        requestedSessionId.current = null
        setOpenSessionId(null)
        setTranscript(null)
        setTranscriptError(null)
        return
      }
      setOpenSessionId(sessionId)
      void loadTranscript(sessionId)
    },
    [openSessionId, loadTranscript],
  )

  const retryTranscript = useCallback(() => {
    if (openSessionId) void loadTranscript(openSessionId)
  }, [openSessionId, loadTranscript])

  // Same recycle-bin delete as the Sessions view, reachable for every session
  // the project holds — the Sessions view lists only the newest 40 across all
  // projects, so older sessions had no delete at all. The list is re-read
  // rather than filtered locally, so a row only drops once the file is gone.
  const deleteSession = useCallback(
    async (sessionId: string) => {
      try {
        await window.hubApi.deleteSession(projectId, sessionId)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not delete that session.')
        return
      }
      toast.success('Session history moved to the recycle bin.')
      if (requestedSessionId.current === sessionId) {
        requestedSessionId.current = null
        setOpenSessionId(null)
        setTranscript(null)
        setTranscriptError(null)
      }
      await loadSessions()
    },
    [projectId, loadSessions],
  )

  return {
    sessions,
    loadingSessions,
    sessionsError,
    loadSessions,
    openSessionId,
    toggleSession,
    transcript,
    loadingTranscript,
    transcriptError,
    retryTranscript,
    deleteSession,
  }
}
