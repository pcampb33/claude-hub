import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useRubricSettings } from './useRubricSettings'
import { parseRubric } from './parseRubric'
import { ErrorNotice } from '../shared/ErrorNotice'
import { ViewHeader } from '../shared/ViewHeader'
import { useReportLoading } from '../shared/appLoading'
import './rubric-settings.css'

// Minimal inline markdown for rubric text: `code`, **bold**, *em*. Anything
// unmatched stays literal — this decorates known RUBRIC.md prose, nothing more.
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let k = 0
  const pushEm = (seg: string) => {
    const re = /\*([^*\n]+)\*/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(seg))) {
      if (m.index > last) out.push(seg.slice(last, m.index))
      out.push(<em key={k++}>{m[1]}</em>)
      last = m.index + m[0].length
    }
    if (last < seg.length) out.push(seg.slice(last))
  }
  const pushBold = (seg: string) => {
    const re = /\*\*(.+?)\*\*/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(seg))) {
      if (m.index > last) pushEm(seg.slice(last, m.index))
      out.push(<strong key={k++}>{m[1]}</strong>)
      last = m.index + m[0].length
    }
    if (last < seg.length) pushEm(seg.slice(last))
  }
  const re = /`([^`\n]+)`/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) pushBold(text.slice(last, m.index))
    out.push(<code key={k++}>{m[1]}</code>)
    last = m.index + m[0].length
  }
  if (last < text.length) pushBold(text.slice(last))
  return out
}

// The intro lines carry their emphasis in caps ("ONLY", "ANY"); the label
// style uppercases everything, so give those words the strong treatment.
function emphasizeCaps(text: string): ReactNode[] {
  return text.split(/\b(ONLY|ANY)\b/).map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part))
}

export function RubricSettingsView() {
  const { rubric, loading, error, refresh, saving, save } = useRubricSettings()
  useReportLoading(loading)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)

  // Load the saved rubric into the editor once it arrives, and re-sync after a
  // save (which updates `rubric` to the persisted text, clearing the dirty flag).
  useEffect(() => {
    if (rubric !== null) setDraft(rubric)
  }, [rubric])

  const parsed = useMemo(() => (rubric !== null ? parseRubric(rubric) : null), [rubric])
  const dirty = rubric !== null && draft !== rubric
  // Structure drift → degrade to the raw textarea (the pre-read-view surface).
  const showEditor = editing || (rubric !== null && parsed === null)

  const handleSave = async () => {
    if (await save(draft)) setEditing(false)
  }
  const handleCancel = () => {
    setDraft(rubric ?? '')
    setEditing(false)
  }

  const tiebreakParts = useMemo(() => {
    if (!parsed?.tiebreak) return null
    const m = /^(.*?)\s*(If no, drop it\.?)$/s.exec(parsed.tiebreak)
    return m ? { body: m[1], verdict: m[2] } : { body: parsed.tiebreak, verdict: null }
  }, [parsed])

  return (
    <section className="rubric-view">
      <ViewHeader
        title="Rubric"
        subtitle="The criteria the auto-curation hook applies when it decides which findings from your sessions are worth queuing to the vault inbox. Edit and save to change what gets flagged — the next session's curation uses it."
        actions={
          showEditor ? (
            <>
              <button className="rubric-save" onClick={handleSave} disabled={!dirty || saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              {parsed !== null && (
                <button className="btn-ghost" onClick={handleCancel}>
                  Cancel
                </button>
              )}
            </>
          ) : (
            <button className="rubric-save" onClick={() => setEditing(true)} disabled={loading || rubric === null}>
              Edit rubric
            </button>
          )
        }
      />
      {error && <ErrorNotice message={error} onRetry={() => refresh()} />}

      {showEditor && (
        <textarea
          className="rubric-editor"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={loading}
          spellCheck={false}
          aria-label="Curation rubric"
        />
      )}

      {!showEditor && parsed !== null && (
        <div className="rubric-read">
          <section>
            <div className="rubric-section-label keep">{emphasizeCaps(parsed.keepIntro)}</div>
            <div className="rubric-keep-grid">
              {parsed.keep.map((k) => (
                <div className="rubric-keep-card" key={k.title}>
                  <h4>{k.title}</h4>
                  <p>{inline(k.desc)}</p>
                  {k.test && <span className="rubric-keep-test">{k.test}</span>}
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="rubric-section-label reject">{emphasizeCaps(parsed.rejectIntro)}</div>
            <div className="rubric-reject-panel">
              <ul className="rubric-reject-list">
                {parsed.reject.map((r, i) => (
                  <li key={i}>
                    <span className="rubric-x">×</span>
                    <span>{inline(r)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          {tiebreakParts && (
            <section className="rubric-tiebreak">
              <span className="rubric-tiebreak-label">Tie-breaker</span>
              <p>
                {inline(tiebreakParts.body)}
                {tiebreakParts.verdict && <em> {tiebreakParts.verdict}</em>}
              </p>
            </section>
          )}

          {parsed.anatomyLead && parsed.anatomy.length > 0 && (
            <section className="rubric-anatomy">
              <span className="rubric-anatomy-lead">{parsed.anatomyLead}</span>
              {parsed.anatomy.map((part, i) => (
                <Fragment key={i}>
                  {i > 0 && <span className="rubric-anatomy-sep">·</span>}
                  <span className="rubric-anatomy-part">{part}</span>
                </Fragment>
              ))}
            </section>
          )}

          <div className="rubric-provenance">
            Stored as RUBRIC.md in the vault · applied by the next session's curation hook
          </div>
        </div>
      )}
    </section>
  )
}
