import { useNavigate } from '../shared/useHashRoute'
import { ErrorNotice } from '../shared/ErrorNotice'
import { relativeTime } from '../shared/relative-time'
import { fmtMinutes, fmtTokens } from './model'
import { useUsageSessions, type DrillTarget } from './useUsage'

export function SessionDrill({ target, onClose }: { target: DrillTarget; onClose: () => void }) {
  const { state, retry } = useUsageSessions(target)
  const navigate = useNavigate()
  const now = Date.now()

  return (
    <section className="usage-drill" aria-label={`Sessions for ${target.name}`}>
      <header className="usage-drill-head">
        <div>
          <h3>{target.name}</h3>
          <span className="usage-drill-range">{target.label}</span>
        </div>
        <button type="button" className="btn-ghost" onClick={onClose}>
          Close
        </button>
      </header>
      {state.status === 'loading' && <div className="usage-drill-note">Loading sessions…</div>}
      {state.status === 'error' && <ErrorNotice message={`Couldn't load the sessions: ${state.error}`} onRetry={retry} />}
      {state.status === 'data' && state.data.state !== 'ready' && (
        <ErrorNotice
          message={state.data.state === 'indexing' ? 'The usage index is still being built.' : `The usage index is unavailable: ${state.data.error}`}
          onRetry={retry}
        />
      )}
      {state.status === 'data' && state.data.state === 'ready' && (
        <>
          {state.data.sessions.length === 0 ? (
            <div className="usage-drill-note">No sessions with responses in this range.</div>
          ) : (
            <ol className="usage-drill-list">
              {state.data.sessions.map((s) => (
                <li key={s.sessionId} className="usage-drill-row">
                  <div className="usage-drill-main">
                    <span className="usage-drill-title" title={s.title}>
                      {s.title}
                    </span>
                    <span className="usage-drill-meta" title={s.projectPath}>
                      {s.projectPath || 'no working directory recorded'} · last response {relativeTime(s.lastIso, now)}
                    </span>
                  </div>
                  <span className="usage-drill-num" title="Tokens processed">
                    {fmtTokens(s.processed)}
                  </span>
                  <span className="usage-drill-num" title="Output tokens">
                    {fmtTokens(s.output)} out
                  </span>
                  <span className="usage-drill-num" title="Active time">
                    {fmtMinutes(s.activeMinutes)}
                  </span>
                  {s.headless ? (
                    <span className="usage-drill-link is-none" title="Headless runs are not listed in Sessions">
                      headless
                    </span>
                  ) : (
                    <button type="button" className="btn-ghost usage-drill-link" onClick={() => navigate('sessions', s.sessionId)}>
                      Open
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
          {state.data.total > state.data.sessions.length && (
            <div className="usage-drill-note">
              Showing the {state.data.sessions.length} largest of {state.data.total} sessions.
            </div>
          )}
        </>
      )}
    </section>
  )
}
