import type { VaultNote } from '../../../shared/ipc-types'
import { displayNoteTitle } from './note-title'

interface NoteDetailProps {
  note: VaultNote | null
  content: string | null
  loading: boolean
  onSelect: (id: string) => void
  // Returns the pane to the Browse list (clears the selection).
  onBack: () => void
}

export function NoteDetail({ note, content, loading, onSelect, onBack }: NoteDetailProps) {
  if (!note) return <p className="vault-empty">Select a note to view it.</p>

  return (
    <div className="note-detail">
      <button className="note-back" onClick={onBack}>
        ← Browse
      </button>
      <div className="note-detail-head">
        <h3 title={note.id}>{displayNoteTitle(note.title)}</h3>
        <span className="note-detail-meta">
          {note.backlinks.length} backlink{note.backlinks.length === 1 ? '' : 's'} · {note.outgoingLinks.length} link
          {note.outgoingLinks.length === 1 ? '' : 's'}
        </span>
      </div>
      {loading || content === null ? (
        <p className="vault-loading">Loading…</p>
      ) : (
        <pre className="note-detail-content">{content}</pre>
      )}

      {note.outgoingLinks.length > 0 && (
        <div className="note-links">
          <span className="note-links-label">Links to:</span>
          {note.outgoingLinks.map((id) => (
            <button key={id} className="note-link-chip" onClick={() => onSelect(id)} title={id}>
              {displayNoteTitle(id)}
            </button>
          ))}
        </div>
      )}

      {note.backlinks.length > 0 && (
        <div className="note-links">
          <span className="note-links-label">Backlinks:</span>
          {note.backlinks.map((id) => (
            <button key={id} className="note-link-chip" onClick={() => onSelect(id)} title={id}>
              {displayNoteTitle(id)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
