import { useContext, useEffect } from 'react'
import { MIN_QUERY_LENGTH, useSessionSearch } from './useSessionSearch'
import { SessionSearchResults } from './SessionSearchResults'
import { SearchResting } from './SearchResting'
import { useRegisteredProjects } from '../shared/useRegisteredProjects'
import { ProjectListUnavailableOption } from '../shared/ProjectListUnavailable'
import { RouteParamContext } from '../shared/useHashRoute'
import { Skeleton } from '../shared/Skeleton'
import { ErrorNotice } from '../shared/ErrorNotice'
import { ViewHeader } from '../shared/ViewHeader'
import { useReportLoading } from '../shared/appLoading'
import './session-search.css'

export function SessionSearchView() {
  const {
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
  } = useSessionSearch()
  useReportLoading(loading)

  // A query handed over from somewhere that could not answer it — today the
  // palette, whose transcript hits stop at the search budget. Only fires when
  // the param changes, so editing the query here does not fight the hash.
  const routeQuery = useContext(RouteParamContext)
  useEffect(() => {
    if (routeQuery) setQuery(routeQuery)
  }, [routeQuery, setQuery])

  const { projects, error: projectsError } = useRegisteredProjects()

  const trimmedLength = query.trim().length

  return (
    <section className="search-view">
      <ViewHeader
        title="Search"
        subtitle="Full-text search across every Claude Code transcript in every registered project — found sessions continue in the Sessions view."
      />
      <div className="search-controls">
        <input
          className="search-input"
          type="text"
          placeholder="Search across all session history…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="search-boost-select"
          value={boostProjectId}
          onChange={(e) => setBoostProjectId(e.target.value)}
        >
          <option value="">No project boost</option>
          {projectsError ? (
            <ProjectListUnavailableOption />
          ) : (
            projects.map((p) => (
              <option key={p.id} value={p.id}>
                Prioritize: {p.name}
              </option>
            ))
          )}
        </select>
      </div>
      {error && <ErrorNotice message={error} />}
      {/* Only the first search of a query gets skeletons. Re-searching — a
          project boost, or a sweep back through the older corpus — keeps the
          results you are already reading on screen. */}
      {loading && !result && (
        <div className="search-skeletons">
          <Skeleton height={56} />
          <Skeleton height={56} />
          <Skeleton height={56} />
        </div>
      )}
      {!loading && !result && trimmedLength > 0 && trimmedLength < MIN_QUERY_LENGTH && (
        <p className="search-hint">Type at least {MIN_QUERY_LENGTH} characters to search.</p>
      )}
      {!loading && !result && trimmedLength === 0 && (
        <SearchResting
          projects={projects}
          recent={recent}
          onPick={setQuery}
          onBoost={setBoostProjectId}
        />
      )}
      {result && (
        <SessionSearchResults
          result={result}
          selectedKey={selectedKey}
          onSelect={selectMatch}
          transcript={transcript}
          loadingTranscript={loadingTranscript}
          transcriptError={transcriptError}
          searching={loading || sweeping}
          onSearchEverything={searchEverything}
        />
      )}
    </section>
  )
}
