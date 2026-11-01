import { useCallback, useEffect, useRef, useState } from 'react'
import type { VaultGraphData } from '../../../shared/ipc-types'
import { usePersistentState } from '../shared/usePersistentState'

export function useVaultGraph() {
  const [graph, setGraph] = useState<VaultGraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Persisted so switching views keeps the selected note.
  const [selectedNoteId, setSelectedNoteId] = usePersistentState<string | null>('knowledge:selected-note', null)
  const [noteContent, setNoteContent] = useState<string | null>(null)
  const [loadingNote, setLoadingNote] = useState(false)
  const requestedNoteId = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.hubApi.getVaultGraph()
      setGraph(result)
      setError(null)
    } catch (err) {
      // Don't strand the view on a disabled "Loading…" (see useFloorStatus).
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const selectNote = useCallback(
    async (id: string) => {
      requestedNoteId.current = id
      setSelectedNoteId(id)
      setLoadingNote(true)
      try {
        const content = await window.hubApi.readVaultNote(id)
        // A different note may have been selected while this was in flight —
        // discard the stale result rather than overwrite the current selection.
        if (requestedNoteId.current !== id) return
        setNoteContent(content)
      } catch (err) {
        // Don't leave the reading pane stuck on a spinner if the read rejects.
        if (requestedNoteId.current !== id) return
        setNoteContent(`Could not load this note: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        if (requestedNoteId.current === id) setLoadingNote(false)
      }
    },
    [setSelectedNoteId],
  )

  // Clears the current selection — used when focusing a whole cluster instead
  // of a single note, so the graph's note-focus doesn't override cluster-focus.
  const clearSelection = useCallback(() => {
    requestedNoteId.current = null
    setSelectedNoteId(null)
    setNoteContent(null)
    setLoadingNote(false)
  }, [setSelectedNoteId])

  // Re-hydrate a persisted selection on mount: the id survives view switches
  // via sessionStorage, but the content does not — fetch it once the graph
  // confirms the note still exists.
  useEffect(() => {
    if (!graph || !selectedNoteId || noteContent !== null || loadingNote) return
    if (graph.notes.some((n) => n.id === selectedNoteId)) {
      selectNote(selectedNoteId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph])

  return { graph, loading, error, refresh, selectedNoteId, selectNote, clearSelection, noteContent, loadingNote }
}
