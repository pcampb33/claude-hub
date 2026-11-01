import type { RecallOffer, RecallScorecard } from '../../../shared/ipc-types'

// The verdict strip for the bounded recall experiment: a KPI funnel
// (Attempts → Offers → Delivered → Read) with single-hue proportional bars,
// the decision rule the numbers feed, a started→deadline meter, and the
// per-offer evidence one disclosure away. "Read = 0" is the experiment's
// failure state and carries danger treatment — border + dot + caption, never
// color alone.

const EXPERIMENT_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

function offerStatus(o: RecallOffer): string {
  if (!o.delivered) return 'matched, never delivered'
  if (!o.transcriptFound) return 'delivered, no transcript'
  if (o.readTitles.length > 0) return 'delivered → read'
  return o.markerSeen ? 'delivered → not read' : 'delivered, marker missing'
}

function statusClass(o: RecallOffer): string {
  if (o.readTitles.length > 0) return 'st-read'
  if (o.delivered && o.transcriptFound && o.markerSeen) return 'st-unread'
  return 'st-dead'
}

function shortDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function RecallVerdict({ scorecard }: { scorecard: RecallScorecard }) {
  const attempts = scorecard.attempts
  const offers = scorecard.offers.length
  const read = scorecard.readSessions
  // A 0 here decides whether the hook gets unhooked, so say when part of the
  // evidence could not be read rather than letting it pass as a clean zero.
  const unreadable = scorecard.incompleteScans
  const pct = (n: number) => (attempts > 0 ? Math.round((n / attempts) * 100) : 0)

  const started = scorecard.since ? new Date(scorecard.since) : null
  const deadline = started ? new Date(started.getTime() + EXPERIMENT_DAYS * DAY_MS) : null
  const progress = started
    ? Math.min(Math.max((Date.now() - started.getTime()) / (EXPERIMENT_DAYS * DAY_MS), 0), 1)
    : 0

  return (
    <div className="recall-verdict">
      <div className="verdict-head">
        <h3>Recall experiment</h3>
        {deadline && <span className="badge badge-bounded">bounded · verdict due ~{shortDate(deadline)}</span>}
        <span className="verdict-spend">${scorecard.spendUsd.toFixed(2)} spent · cap 25/day</span>
      </div>

      <div className="verdict-funnel">
        <div className="verdict-stage">
          <div className="stage-lbl">Attempts</div>
          <div className="stage-val">{attempts}</div>
          <div className="stage-sub">worker ran a match</div>
          <div className="stage-bar">
            <i style={{ width: '100%' }} />
          </div>
        </div>
        <span className="stage-arrow">→</span>
        <div className="verdict-stage">
          <div className="stage-lbl">Offers</div>
          <div className="stage-val">{offers}</div>
          <div className="stage-sub">{pct(offers)}% matched the vault</div>
          <div className="stage-bar">
            <i style={{ width: `${pct(offers)}%` }} />
          </div>
        </div>
        <span className="stage-arrow">→</span>
        <div className="verdict-stage">
          <div className="stage-lbl">Delivered</div>
          <div className="stage-val">{scorecard.delivered}</div>
          <div className="stage-sub">reached a later prompt</div>
          <div className="stage-bar">
            <i style={{ width: `${pct(scorecard.delivered)}%` }} />
          </div>
        </div>
        <span className="stage-arrow">→</span>
        <div className={`verdict-stage${read === 0 ? ' danger' : ''}`}>
          <div className="stage-lbl">Read</div>
          <div className="stage-val">{read}</div>
          <div className="stage-sub">
            {read === 0 ? (
              <>
                <span className="stage-dot-danger" />
                {unreadable > 0
                  ? `no note opened — ${unreadable} transcript${unreadable === 1 ? '' : 's'} unreadable`
                  : 'no offered note opened yet'}
              </>
            ) : (
              `session${read === 1 ? '' : 's'} opened an offered note`
            )}
          </div>
          <div className="stage-bar">
            <i style={{ width: `${pct(read)}%` }} />
          </div>
        </div>
      </div>

      {deadline && (
        <div className="verdict-meta">
          <span className="verdict-rule">
            Rule: still <b>{read} read</b> by ~{shortDate(deadline)} → unhook vault-recall, keep manual inbox
            approval.
            {unreadable > 0 && ' Re-check the unreadable transcripts before calling it.'}
          </span>
          <span className="deadline-meter">
            <span>started {started ? shortDate(started) : '—'}</span>
            <span className="deadline-track">
              <i style={{ width: `${Math.max(Math.round(progress * 100), 2)}%` }} />
            </span>
            <span>~{shortDate(deadline)}</span>
          </span>
        </div>
      )}

      {offers > 0 && (
        <details className="verdict-evidence">
          <summary>
            Evidence — {offers} offer{offers === 1 ? '' : 's'}, newest first
          </summary>
          <ul className="verdict-offers">
            {scorecard.offers.map((o) => (
              <li key={`${o.sessionId}-${o.at}`} className="verdict-offer">
                <div className="verdict-offer-meta">
                  {o.at.slice(0, 10)} · {o.project || 'unknown project'} ·{' '}
                  <span className={statusClass(o)}>{offerStatus(o)}</span>
                </div>
                {o.titles.length > 0 && (
                  <ul className="verdict-offer-titles">
                    {o.titles.map((t) => (
                      <li key={t}>
                        <span className={`offer-mark${o.readTitles.includes(t) ? ' read' : ''}`}>
                          {o.readTitles.includes(t) ? '✓' : '·'}
                        </span>
                        {t}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
