import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionSearchMatch, SkillEntry, WorkflowEntry } from '../../../shared/ipc-types'
// Explicit .ts: this module's hook test runs under plain `node`, which does not
// resolve extension-less relative imports the way Vite does. Type-only imports
// are erased before node sees them; a runtime one is not.
import { displayNoteTitle } from '../../../shared/vault-note-name.ts'
import type { PaletteMode } from './mode'

// The corpora behind the global search bar, split by how they have to be
// fetched rather than by what they are:
//
// - Notes, skills and workflows are small, bounded lists. They load once when
//   the palette opens and cmdk filters them client-side, so typing stays
//   instant and costs nothing.
// - Transcripts cannot work that way. sessions:search reads ~1.4GB of JSONL
//   across sessions and subagents, so it is a debounced server call that only
//   fires once the query is long enough to be selective — and only in a mode
//   that can actually show the result.
//
// Every list arrives newest-first: with nothing typed the palette shows only
// the head of each corpus, so the order is the whole ranking.
//
// Everything is best-effort: a corpus that fails to load leaves its group
// empty rather than taking the palette down with it. But an empty group and a
// failed one look identical on screen, and "No matches." is a claim about the
// corpus — so a failure is recorded in `failed` and the palette says it could
// not ask instead of answering for a corpus it never read.

// What the transcript search did NOT reach. sessions:search walks newest-first
// under a byte budget, so a palette hit list is the newest slice of the corpus
// and nothing else — and "No matches." over an unsearched 257 sessions is a
// wrong answer, not a slow one. Kept so the palette can say so and hand the
// question to the Search view, which can sweep.
export interface TranscriptCoverage {
  unscanned: number
  oldestScanned: string | null
}

export interface NoteHit {
  // The raw filename stem — the link target, and what navigation resolves.
  id: string
  // The de-sanitised form, NOT what vault-graph sent: it sends the stem as the
  // title, and rendering that raw labelled the same note two different ways in
  // the app's two search surfaces.
  title: string
  project: string | null
  mtime: string
}

// Below this, sessions:search is both slow (nothing prunes the scan early) and
// useless (every transcript matches "th"). MIN_QUERY_LENGTH in the Sessions
// view draws the same line.
const MIN_TRANSCRIPT_QUERY = 3
// Long enough that a burst of typing is one request, short enough to feel
// immediate once you stop.
const DEBOUNCE_MS = 250

// ISO-8601 UTC from Date#toISOString on every producer, so a string compare is
// a time compare — no Date parsing per element per sort.
function byMtimeDesc<T extends { mtime: string }>(a: T, b: T): number {
  return b.mtime.localeCompare(a.mtime)
}

// getSkillUsage() is the real recency signal for a skill — when it was last
// invoked, not when its folder was last written. It is also the heavier call:
// a persisted incremental index over the whole session corpus, measured at
// ~960ms when a day of sessions has landed since the last scan and ~130ms
// warm. So it is fetched once per app session and shared, off the palette's
// critical path. At most the first open of a run sees folder-mtime order; it
// re-sorts when the index lands, and every open after that has the real order
// in hand before it paints.
//
// Only a success is memoized. A rejection clears the memo and propagates: an
// emptied map here would be indistinguishable from "no skill has ever been
// invoked", and caching it would pin every later open of the run to that same
// wrong answer with no path back to the real ranking.
let usagePromise: Promise<Map<string, string>> | null = null

function skillLastUsed(): Promise<Map<string, string>> {
  usagePromise ??= window.hubApi
    .getSkillUsage()
    .then((rows) => new Map(rows.map((row) => [row.skill, row.lastUsed])))
    .catch((err: unknown) => {
      usagePromise = null
      throw err
    })
  return usagePromise
}

// A skill that has never been invoked has no lastUsed at all, so it cannot be
// interleaved with ones that have — it falls to the back of the list, ordered
// among its own kind by folder mtime.
function bySkillRecency(lastUsed: Map<string, string>) {
  return (a: SkillEntry, b: SkillEntry): number => {
    const aUsed = lastUsed.get(a.name)
    const bUsed = lastUsed.get(b.name)
    if (aUsed && bUsed) return bUsed.localeCompare(aUsed)
    if (aUsed) return -1
    if (bUsed) return 1
    return byMtimeDesc(a, b)
  }
}

export function useGlobalSearch(open: boolean, term: string, mode: PaletteMode) {
  const [notes, setNotes] = useState<NoteHit[]>([])
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [workflows, setWorkflows] = useState<WorkflowEntry[]>([])
  const [transcripts, setTranscripts] = useState<SessionSearchMatch[]>([])
  const [coverage, setCoverage] = useState<TranscriptCoverage | null>(null)
  const [searching, setSearching] = useState(false)
  // Corpora whose fetch rejected this open — "notes" | "skills" | "workflows"
  // | "transcripts". Non-empty means at least one group's emptiness is unknown.
  const [failed, setFailed] = useState<string[]>([])
  const markFailed = useCallback((corpus: string) => {
    setFailed((prev) => (prev.includes(corpus) ? prev : [...prev, corpus]))
  }, [])
  // Loaded once per open, not once per mount: the palette stays mounted.
  const loadedFor = useRef(false)
  const latestSearch = useRef(0)

  useEffect(() => {
    if (!open) {
      loadedFor.current = false
      return
    }
    if (loadedFor.current) return
    loadedFor.current = true
    setFailed([])
    void window.hubApi
      .getVaultGraph()
      .then((graph) =>
        setNotes(
          graph.notes
            // Vault notes only. The same transform over a session, skill or
            // workflow name would corrupt any that legitimately contain "- ".
            .map((n) => ({ id: n.id, title: displayNoteTitle(n.title), project: n.project, mtime: n.mtime }))
            .sort(byMtimeDesc),
        ),
      )
      .catch(() => {
        setNotes([])
        markFailed('notes')
      })
    void window.hubApi
      .listSkills()
      .then((list) => {
        setSkills([...list].sort(byMtimeDesc))
        // Caught here rather than by the outer handler: the skills themselves
        // arrived, so the list stays. What is missing is the ranking — and
        // folder mtime standing in for real usage order, with every skill
        // rendered as never-invoked, is a claim about a scan nobody read. So
        // the fallback order is kept but the palette names what it could not
        // reach instead of letting it pass as the measured one.
        return skillLastUsed()
          .then((lastUsed) => setSkills([...list].sort(bySkillRecency(lastUsed))))
          .catch(() => markFailed('skill usage'))
      })
      .catch(() => {
        setSkills([])
        markFailed('skills')
      })
    void window.hubApi
      .listWorkflows()
      .then((list) => setWorkflows([...list].sort(byMtimeDesc)))
      .catch(() => {
        setWorkflows([])
        markFailed('workflows')
      })
  }, [open, markFailed])

  const trimmed = term.trim()
  const searchable = mode === 'all' || mode === 'transcripts'
  useEffect(() => {
    if (!open || !searchable || trimmed.length < MIN_TRANSCRIPT_QUERY) {
      setTranscripts([])
      setCoverage(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = window.setTimeout(() => {
      const callId = ++latestSearch.current
      void window.hubApi
        .searchSessions(trimmed)
        .then((result) => {
          // A newer keystroke already started its own search; its result is the
          // one that should land.
          if (callId !== latestSearch.current) return
          setTranscripts(result.matches)
          setCoverage({ unscanned: result.unscannedSessionCount, oldestScanned: result.oldestScanned })
          setSearching(false)
          setFailed((prev) => (prev.includes('transcripts') ? prev.filter((c) => c !== 'transcripts') : prev))
        })
        .catch(() => {
          if (callId !== latestSearch.current) return
          setTranscripts([])
          setCoverage(null)
          setSearching(false)
          markFailed('transcripts')
        })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [open, trimmed, searchable, markFailed])

  const reset = useCallback(() => {
    setTranscripts([])
    setCoverage(null)
    setSearching(false)
    // Invalidate any search still in flight so its result cannot land in the
    // next opening of the palette.
    latestSearch.current++
  }, [])

  return {
    failed,
    notes,
    skills,
    workflows,
    transcripts,
    coverage,
    searching,
    reset,
    minTranscriptQuery: MIN_TRANSCRIPT_QUERY,
  }
}
