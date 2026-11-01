import { useRef } from 'react'
import { relativeTime } from '../shared/relative-time'
import { useNavigate } from '../shared/useHashRoute'
import { SessionTranscript } from '../sessions/SessionTranscript'
import { markText } from '../shared/mark-text'
import { useMarkStepper } from '../sessions/useFindInTranscript'
import type { SessionMessage, SessionSearchMatch, SessionSearchResult } from '../../../shared/ipc-types'

import { matchKey } from './useSessionSearch'

// Mirrors MATCH_PER_FILE_CAP in electron/session-search.ts (the renderer can't
// import from electron/) — the scan breaks out of a file's line loop there, so
// a count that reached the cap is a floor, not a total: the biggest hit for
// "session" on this corpus is 60 matching turns arriving here as 3. Agent rows
// come out of the same scan, so they saturate the same way. `×3+` is the row's
// version of what the meta line already does for the result and byte budgets —
// print the number, and say when it's the limit talking.
const MATCH_PER_FILE_CAP = 3

function matchCountLabel(matchCount: number): string {
  return matchCount >= MATCH_PER_FILE_CAP ? `×${MATCH_PER_FILE_CAP}+` : `×${matchCount}`
}

// An agent row is headed by what the agent was asked to do. Its type already
// sits in the chip beside it, so a meta with no description (every workflow
// agent) falls back to the parent session's title instead of repeating the
// type back twice.
function rowTitle(match: SessionSearchMatch): string {
  if (!match.agent) return match.title
  return match.agent.description || match.title
}

// The transcript pane: the same chat renderer Sessions uses (roll-ups and
// all), matched prose turns accent-marked, a ‹ › stepper to walk them, and
// a header CTA deep-linking to the Sessions detail where adopt/steer lives.
function SearchDetail({
  match,
  query,
  transcript,
  loading,
  error,
}: {
  match: SessionSearchMatch
  query: string
  transcript: SessionMessage[] | null
  loading: boolean
  error: string | null
}) {
  const navigate = useNavigate()
  const bodyRef = useRef<HTMLDivElement>(null)
  // One step per occurrence, not per matched turn: a turn can be a screen of
  // prose, and stopping at the turn leaves the reader hunting inside it —
  // the exact chore this stepper exists to remove.
  const { index: step, count: matchedCount, walk } = useMarkStepper(bodyRef, query, transcript)

  return (
    <article className="card search-detail">
      <header className="search-detail-head">
        <span className="session-pulse" />
        <div className="search-detail-head-txt">
          <div className="search-detail-title">{rowTitle(match)}</div>
          <div className="search-detail-sub">
            {/* The title above is already the parent's when the agent has no
                description of its own — don't print it a second time here. */}
            {match.agent && (
              <>
                {match.agent.agentType} subagent
                {match.agent.description ? ` of ${match.title}` : ''} ·{' '}
              </>
            )}
            {match.projectName} · {relativeTime(match.date, Date.now())}
          </div>
        </div>
        <button className="btn-ghost" onClick={() => navigate('projects', match.projectId)}>
          Open in Projects
        </button>
        <button className="search-continue" onClick={() => navigate('sessions', match.sessionId)}>
          Continue in Sessions →
        </button>
      </header>

      <div className="search-match-nav">
        <button type="button" onClick={() => walk(-1)} disabled={matchedCount === 0} aria-label="Previous match">
          ‹
        </button>
        <button type="button" onClick={() => walk(1)} disabled={matchedCount === 0} aria-label="Next match">
          ›
        </button>
        <span>
          {transcript === null
            ? 'loading transcript…'
            : matchedCount === 0
              ? `no prose matches — “${query}” may only appear in tool calls`
              : `match ${step + 1} of ${matchedCount} — “${query}”`}
        </span>
      </div>

      <div className="search-detail-body" ref={bodyRef}>
        {error !== null && <div className="session-loading">Couldn't read this transcript — {error}</div>}
        {loading && <div className="session-loading">Loading transcript…</div>}
        {!loading && error === null && transcript?.length === 0 && (
          <div className="session-loading">No conversation recorded yet.</div>
        )}
        {!loading && transcript && transcript.length > 0 && (
          <SessionTranscript messages={transcript} highlight={query} />
        )}
      </div>
    </article>
  )
}

export function SessionSearchResults({
  result,
  selectedKey,
  onSelect,
  transcript,
  loadingTranscript,
  transcriptError,
  searching,
  onSearchEverything,
}: {
  result: SessionSearchResult
  selectedKey: string | null
  onSelect: (match: SessionSearchMatch) => void
  transcript: SessionMessage[] | null
  loadingTranscript: boolean
  transcriptError: string | null
  searching: boolean
  onSearchEverything: () => void
}) {
  const selected = result.matches.find((m) => matchKey(m) === selectedKey) ?? null
  const nowMs = Date.now()
  // Subagent transcripts became searchable in the same pass that added the
  // per-session agent cap, so a query can legitimately return fewer agent hits
  // than exist. Saying how many came from agents is the only signal that the
  // sidechain half of the corpus was searched at all.
  const agentCount = result.matches.filter((match) => match.agent).length

  return (
    <div className="search-results">
      <div className="search-results-meta">
        {result.matches.length} result{result.matches.length === 1 ? '' : 's'} across {result.scannedSessionCount}{' '}
        sessions
        {agentCount > 0 && `, ${agentCount} from subagents`}
        {result.truncated && ' (more results exist — narrow your search)'}
        {searching && <span className="search-results-working"> · searching…</span>}
      </div>

      {/* The scan stops at a byte budget, newest first. Saying so — with the
          date it reached and the way to go further — is the difference between
          a fast search and a quietly incomplete one. */}
      {result.unscannedSessionCount > 0 && (
        <div className="search-results-coverage">
          Searched back to {new Date(result.oldestScanned ?? Date.now()).toLocaleDateString()} ·{' '}
          {result.unscannedSessionCount} older session{result.unscannedSessionCount === 1 ? '' : 's'} not scanned
          <button type="button" className="btn btn-ghost btn-sm" onClick={onSearchEverything} disabled={searching}>
            Search everything
          </button>
        </div>
      )}

      {result.matches.length === 0 && <div className="search-results-empty">No matches.</div>}

      {result.matches.length > 0 && (
        <div className="search-panes">
          <div className="search-result-list">
            {result.matches.map((match) => {
              const key = matchKey(match)
              return (
                <button
                  type="button"
                  key={key}
                  className={`search-result-row${selectedKey === key ? ' active' : ''}`}
                  onClick={() => onSelect(match)}
                >
                  <span className="search-result-top">
                    <span className="badge badge-neutral">{match.projectName}</span>
                    {match.agent && <span className="search-result-agent">{match.agent.agentType}</span>}
                    <span className="search-result-date">{relativeTime(match.date, nowMs)}</span>
                    <span className="search-result-count">{matchCountLabel(match.matchCount)}</span>
                  </span>
                  <span className="search-result-title">{rowTitle(match)}</span>
                  {match.agent?.description && <span className="search-result-parent">in {match.title}</span>}
                  <span className="search-result-snippet">{markText(match.snippet, result.query)}</span>
                </button>
              )
            })}
          </div>

          {selected && (
            <SearchDetail
              match={selected}
              query={result.query}
              transcript={transcript}
              loading={loadingTranscript}
              error={transcriptError}
            />
          )}
        </div>
      )}
    </div>
  )
}
