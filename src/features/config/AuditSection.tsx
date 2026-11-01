import { useState } from 'react'
import type { DesktopTargetRef } from '../../../shared/ipc-types'
import { ErrorNotice } from '../shared/ErrorNotice'
import { relativeTime } from '../shared/relative-time'
import { useNavigate } from '../shared/useHashRoute'
import { auditEmptyText, auditSummary, blockedNote, groupCrossings, mixText, unreadableNote } from './config-model.ts'
import { useBoundaryAudit } from './useConfig'

const DAYS = [7, 30] as const

export function AuditSection({ target }: { target: DesktopTargetRef }) {
  const [days, setDays] = useState<number>(30)
  const audit = useBoundaryAudit(target, days)
  const navigate = useNavigate()
  const nowMs = Date.now()

  return (
    <section className="cfg-card" aria-label="Boundary crossings">
      <div className="cfg-card-head">
        <h5>Crossings</h5>
        <div className="cfg-seg cfg-seg-sm" role="radiogroup" aria-label="Audit window">
          {DAYS.map((d) => (
            <button type="button" key={d} role="radio" aria-checked={d === days} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </div>
      </div>
      <p className="cfg-sub">Reads, writes and shell commands in this project’s sessions that reached outside its boundary, from the transcripts.</p>

      {audit.state.status === 'loading' && (
        <div aria-busy="true" aria-label="Scanning transcripts">
          <div className="skeleton cfg-skel" />
        </div>
      )}
      {audit.state.status === 'error' && <ErrorNotice message={`Couldn’t audit the transcripts: ${audit.state.error}`} onRetry={audit.retry} />}
      {audit.state.status === 'data' &&
        (() => {
          const a = audit.state.data
          const summary = auditSummary(a)
          const unreadable = unreadableNote(a)
          const blocked = blockedNote(a)
          return (
            <>
              {a.error && <p className="cfg-note is-warn">Part of the audit failed: {a.error}</p>}
              {unreadable && <p className="cfg-note is-warn">{unreadable}</p>}
              {summary === null ? (
                <p className="cfg-zero">{auditEmptyText(a, days)}</p>
              ) : (
                <>
                  <p className="cfg-summary">{summary}</p>
                  <div className="cfg-groups">
                    {groupCrossings(a.crossings).map((g) => (
                      <details key={g.into} className="cfg-group">
                        <summary>
                          <b>{g.into}</b>
                          <span className="cfg-group-n">{g.count}</span>
                          <span className="cfg-faint">{mixText(g.mix)}</span>
                        </summary>
                        <ul className="cfg-crossings">
                          {g.crossings.map((c, i) => (
                            <li key={`${c.sessionId}-${c.at}-${i}`}>
                              <span className="cfg-access" data-access={c.access}>
                                {c.access}
                              </span>
                              <span className="cfg-tool">{c.tool}</span>
                              <code className="cfg-val cfg-trunc" title={c.detail}>
                                {c.detail}
                              </code>
                              <time dateTime={c.at} title={new Date(c.at).toLocaleString()}>
                                {relativeTime(c.at, nowMs)}
                              </time>
                              <button
                                type="button"
                                className="cfg-link"
                                title={`Open session ${c.sessionId} in History`}
                                onClick={() => navigate('sessions', c.sessionId)}
                              >
                                Session
                              </button>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ))}
                  </div>
                </>
              )}
              {blocked && <p className="cfg-note">{blocked}</p>}
              <p className="cfg-sub">
                {a.sessionsScanned} session{a.sessionsScanned === 1 ? '' : 's'} scanned since {new Date(a.sinceIso).toLocaleDateString()}.
              </p>
            </>
          )
        })()}
    </section>
  )
}
