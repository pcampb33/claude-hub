import type { RegistryEntry } from '../../../shared/ipc-types'

// What the view shows before a query. There are no results to describe yet,
// but there is plenty to say about the search itself — what it walks, how far
// it reaches on its own, and what you already asked it. The centred glyph this
// replaces said none of it across 800px of empty page, and this view is the
// one place the corpus sweep is allowed to run (the palette deliberately hands
// it over rather than running a five-second walk inside a modal), so its
// resting state is where that job gets explained.
export function SearchResting({
  projects,
  recent,
  onPick,
  onBoost,
}: {
  projects: RegistryEntry[]
  recent: string[]
  onPick: (query: string) => void
  onBoost: (projectId: string) => void
}) {
  return (
    <div className="search-resting">
      {recent.length > 0 && (
        <section className="card search-resting-card">
          <h3>Recent searches</h3>
          <p className="search-resting-note">This run only — cleared when the hub restarts.</p>
          <div className="search-resting-chips">
            {recent.map((query) => (
              <button type="button" key={query} className="search-resting-chip" onClick={() => onPick(query)}>
                {query}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="card search-resting-card">
        <h3>What a search walks</h3>
        <ul className="search-resting-facts">
          <li>Every session transcript in every registered project, plus the subagents those sessions spawned.</li>
          <li>
            Newest first, up to a read budget. The results say how far back the scan reached and how many older
            sessions it never opened — “Search everything” walks the rest.
          </li>
          <li>Plain text, case-insensitive, three characters or more. No operators.</li>
          <li>Ctrl K searches the newest slice inline; when it runs out of budget it hands the query to here.</li>
        </ul>
      </section>

      {/* The project list starts empty and fills in, so a count is only
          printed once there is one to print — "0 registered projects" would
          be the load state wearing an answer's clothes. */}
      {projects.length > 0 && (
        <section className="card search-resting-card">
          <h3>{projects.length} projects in scope</h3>
          <p className="search-resting-note">All of them are searched. Pick one to float its hits to the top.</p>
          <div className="search-resting-chips">
            {projects.map((project) => (
              <button
                type="button"
                key={project.id}
                className="search-resting-chip"
                onClick={() => onBoost(project.id)}
              >
                {project.name}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
