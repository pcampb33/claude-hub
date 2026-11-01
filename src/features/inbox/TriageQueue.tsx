import { useEffect, useRef } from 'react'
import type { VaultInboxEntry } from '../../../shared/ipc-types'

// The triage queue: a single-column sequential list. Collapsed row = one calm
// line (confidence dot · title · project chip · date; hover swaps the date for
// quiet inline actions). The selected row expands in place into the decision
// card: full justification, a closed-by-default preview of the note body an
// approval would write, and the two actions with their key hints. All state
// (selection, preview, busy) lives in the view — this component is
// presentational so the view's keyboard handler and the rows can't drift.

export function TriageQueue({
  entries,
  selectedIndex,
  onSelect,
  previewOpen,
  onTogglePreview,
  onResolve,
  busy,
}: {
  entries: VaultInboxEntry[]
  selectedIndex: number
  onSelect: (index: number) => void
  previewOpen: boolean
  onTogglePreview: () => void
  onResolve: (entry: VaultInboxEntry, action: 'approve' | 'reject') => void
  busy: boolean
}) {
  // Keep the selected row visible as ↑/↓ walk the queue.
  const rowRefs = useRef<(HTMLDivElement | null)[]>([])
  useEffect(() => {
    rowRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  return (
    <div className="triage-queue">
      {entries.map((entry, i) => {
        const selected = i === selectedIndex
        return (
          <div
            key={entry.sessionId + entry.title}
            ref={(el) => {
              rowRefs.current[i] = el
            }}
            className={`q-row${selected ? ' selected' : ''}`}
          >
            <div className="q-line" onClick={() => !selected && onSelect(i)}>
              <span className={`conf-dot conf-${entry.confidence ?? 'none'}`} />
              <span className="q-title">{entry.title}</span>
              <span className="q-meta">
                {selected && entry.confidence && (
                  <span className={`badge conf-${entry.confidence}`}>suggested · {entry.confidence}</span>
                )}
                {!selected && (
                  <span className="q-quick">
                    <button
                      className="btn-tiny q-quick-add"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation()
                        onResolve(entry, 'approve')
                      }}
                    >
                      Add
                    </button>
                    <button
                      className="btn-tiny"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation()
                        onResolve(entry, 'reject')
                      }}
                    >
                      Discard
                    </button>
                  </span>
                )}
                {entry.project && <span className="inbox-tag">{entry.project}</span>}
                <span className="q-when">{entry.timestamp.slice(0, 10)}</span>
              </span>
            </div>

            {selected && (
              <div className="q-open">
                <div className="q-why">{entry.justification}</div>
                <button className="q-preview-toggle" onClick={onTogglePreview} aria-expanded={previewOpen}>
                  <span className={`q-preview-tri${previewOpen ? ' open' : ''}`}>▶</span>
                  Preview the note that will be written
                </button>
                {previewOpen && (
                  <pre className="q-preview-body">{entry.body || 'No note body was queued for this entry.'}</pre>
                )}
                <div className="q-actions">
                  <button className="inbox-approve" disabled={busy} onClick={() => onResolve(entry, 'approve')}>
                    Add to vault
                  </button>
                  <button className="inbox-reject" disabled={busy} onClick={() => onResolve(entry, 'reject')}>
                    Discard
                  </button>
                  <span className="q-keys">
                    <kbd>⏎</kbd> add&ensp;<kbd>D</kbd> discard&ensp;<kbd>Space</kbd> preview
                  </span>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
