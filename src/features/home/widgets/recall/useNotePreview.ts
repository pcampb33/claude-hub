import { useEffect, useState } from 'react'
import { useVaultGraphRead } from '../../reads'
import { findNoteId, notePreview } from './recall'

export type NoteRead =
  | { status: 'loading' }
  | { status: 'error'; error: string; retry: () => void }
  | { status: 'missing' } // the graph read fine and has no note by that title
  | { status: 'data'; id: string; text: string; truncated: boolean }

// Title → note id through the vault graph, then the note itself. Each step
// keeps its own failure: "couldn't read the vault" is not "no such note".
export function useNotePreview(title: string): NoteRead {
  const graph = useVaultGraphRead()
  const id = graph.status === 'data' ? findNoteId(graph.data.notes, title) : null
  const [note, setNote] = useState<{ id: string; content?: string; error?: string } | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!id) return
    let alive = true
    setNote(null)
    window.hubApi.readVaultNote(id).then(
      (content) => alive && setNote({ id, content }),
      (err: unknown) => alive && setNote({ id, error: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      alive = false
    }
  }, [id, attempt])

  if (graph.status === 'error') return { status: 'error', error: graph.error, retry: graph.refresh }
  if (graph.status === 'loading') return { status: 'loading' }
  if (!id) return { status: 'missing' }
  if (!note || note.id !== id) return { status: 'loading' }
  if (note.error !== undefined) return { status: 'error', error: note.error, retry: () => setAttempt((n) => n + 1) }
  return { status: 'data', id, ...notePreview(note.content ?? '') }
}
