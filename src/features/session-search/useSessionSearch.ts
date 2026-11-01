import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionMessage, SessionSearchMatch, SessionSearchResult } from '../../../shared/ipc-types'
import { compareSearchMatches } from '../../../shared/search-order'
import { usePersistentState } from '../shared/usePersistentState'

const DEBOUNCE_MS = 300
export const MIN_QUERY_LENGTH = 3
// Mirrors GLOBAL_MATCH_CAP in session-search.ts, which caps one call. A sweep
// is many calls, so without this the cap would silently multiply by the number
// of chunks — 50 stays 50 however far back the sweep goes.
const SWEEP_MATCH_CAP = 50
// How many past queries the resting state offers back. Six fits one row of
// chips; the list is a way back into an investigation, not a history log.
const RECENT_CAP = 6

// One session can now contribute several rows — its own turns plus a match in
// each of the agents it spawned — so the agent id is part of a row's identity.
// Without it the rows collide as React keys and selecting one selects another.
export function matchKey(match: SessionSearchMatch): string {
  return `${match.projectPath}:${match.sessionId}:${match.agent?.id ?? ''}`
}

// One more budgeted chunk folded onto what is already on screen. The chunk's
// own counts are for the sessions IT opened, so the scanned count adds up while
// the unscanned count and the cursor are simply replaced — they describe where
// the sweep now stands, not what it just did.
function mergeChunk(
  acc: SessionSearchResult,
  chunk: SessionSearchResult,
  currentProjectId?: string,
): SessionSearchResult {
  return {
    ...chunk,
    matches: [...acc.matches, ...chunk.matches].sort(compareSearchMatches(currentProjectId)),
    scannedSessionCount: acc.scannedSessionCount + chunk.scannedSessionCount,
    truncated: acc.truncated || chunk.truncated,
    oldestScanned: chunk.oldestScanned ?? acc.oldestScanned,
  }
}

export function useSessionSearch() {
  // Persisted so switching views doesn't lose the query mid-investigation.
  const [query, setQuery] = usePersistentState('session-search:query', '')
  // No implicit "currently open project" exists in this app's flat nav
  // (Projects/Search/Sandbox/Skills/Vault are siblings, not nested) — the
  // council's "current project" boost is delivered as an explicit, optional
  // user choice instead of inferred context that doesn't exist here.
  // Persisted like the query: the pair defines one investigation, and a
  // boost that silently resets while the query survives reads as a bug.
  const [boostProjectId, setBoostProjectId] = usePersistentState('session-search:boost', '')
  // Queries that actually reached the corpus, newest first — the resting
  // state's way back into an investigation you left to go read a session.
  const [recent, setRecent] = usePersistentState<string[]>('session-search:recent', [])
  const [result, setResult] = useState<SessionSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latestRequest = useRef(0)

  // "Search everything" is the same budgeted call in a loop, walking its own
  // cursor back through the corpus and appending each chunk. Nothing about the
  // query changes, so there is no deep-vs-shallow state to reset: a new
  // keystroke bumps latestRequest, which the loop checks and stands down on.
  const [sweeping, setSweeping] = useState(false)

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<SessionMessage[] | null>(null)
  const [loadingTranscript, setLoadingTranscript] = useState(false)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const requestedMatchKey = useRef<string | null>(null)

  useEffect(() => {
    if (query.trim().length < MIN_QUERY_LENGTH) {
      // Invalidate any in-flight request too — without this, a request
      // started just before the query was cleared could still resolve
      // later and overwrite this cleared state with stale results.
      ++latestRequest.current
      setResult(null)
      setError(null)
      setLoading(false) // was left stuck true if a request was in flight when the query got cleared
      return
    }

    const requestId = ++latestRequest.current
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const searchResult = await window.hubApi.searchSessions(query, boostProjectId || undefined)
        if (requestId !== latestRequest.current) return // superseded by a newer keystroke
        setResult(searchResult)
        setError(null)
        // Typing forward past the debounce leaves a trail of half-words, so a
        // query supersedes any prefix of itself: "ses" → "sessio" → "session"
        // remembers the question, not the keystrokes on the way to it.
        const asked = query.trim()
        setRecent((list) => [asked, ...list.filter((q) => q !== asked && !asked.startsWith(q))].slice(0, RECENT_CAP))
      } catch (err) {
        // Don't strand the view on a disabled "Searching…" (see useFloorStatus).
        if (requestId !== latestRequest.current) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (requestId === latestRequest.current) setLoading(false)
      }
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [query, boostProjectId, setRecent])

  const searchEverything = useCallback(async () => {
    // The first chunk is the search already on screen, so the sweep starts from
    // its cursor. requestId pins the sweep to the question that started it —
    // one keystroke and every remaining chunk is dropped rather than merged
    // into results for a query the user has moved on from.
    const requestId = latestRequest.current
    let acc = result
    if (!acc?.nextCursor) return
    setSweeping(true)
    try {
      while (acc.nextCursor && acc.matches.length < SWEEP_MATCH_CAP) {
        const chunk = await window.hubApi.searchSessions(query, boostProjectId || undefined, {
          startAfter: acc.nextCursor,
        })
        if (requestId !== latestRequest.current) return
        acc = mergeChunk(acc, chunk, boostProjectId || undefined)
        setResult(acc)
      }
    } catch (err) {
      if (requestId === latestRequest.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSweeping(false)
    }
  }, [query, boostProjectId, result])

  const selectMatch = useCallback(async (match: SessionSearchMatch) => {
    const key = matchKey(match)
    if (requestedMatchKey.current === key) return
    requestedMatchKey.current = key
    setSelectedKey(key)
    setLoadingTranscript(true)
    setTranscriptError(null)
    try {
      // An agent row opens the agent's own transcript, not its parent session's
      // — the matched text is only in the former.
      const messages = match.agent
        ? await window.hubApi.readSubagent(match.projectPath, match.sessionId, match.agent.id)
        : await window.hubApi.readSession(match.projectPath, match.sessionId)
      // A different match may have been requested while this was in flight
      // — same stale-response guard already used in useSessionHistory.
      if (requestedMatchKey.current !== key) return
      setTranscript(messages)
    } catch (err) {
      // Not setTranscript([]) — an empty array is this pane's way of saying
      // the session never spoke, and a read that failed knows nothing about
      // what it said. The spinner is cleared by the finally below, which is
      // what the old comment here was actually reaching for.
      if (requestedMatchKey.current !== key) return
      setTranscriptError(err instanceof Error ? err.message : String(err))
    } finally {
      if (requestedMatchKey.current === key) setLoadingTranscript(false)
    }
  }, [])

  // Master-detail: something is always selected — the first result by
  // default, sticky across re-searches while the selected session is still
  // in the result set.
  useEffect(() => {
    if (!result || result.matches.length === 0) {
      requestedMatchKey.current = null
      setSelectedKey(null)
      setTranscript(null)
      return
    }
    const current = requestedMatchKey.current
    if (current && result.matches.some((m) => matchKey(m) === current)) return
    selectMatch(result.matches[0])
  }, [result, selectMatch])

  return {
    query,
    setQuery,
    boostProjectId,
    setBoostProjectId,
    recent,
    searchEverything,
    result,
    loading,
    sweeping,
    error,
    selectedKey,
    selectMatch,
    transcript,
    loadingTranscript,
    transcriptError,
  }
}
