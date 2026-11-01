import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ExtensionItem } from '../../../shared/ipc-types'
import { RouteParamContext } from '../shared/useHashRoute'
import { visibleItems, type Bucket, type TypeFilter } from './model'

// Filter + selection state for the two-pane list. The route param is either
// a bucket ('broken', from Home's "Can't connect" links) or an item id; it is
// applied once per distinct value after the items arrive, so it can't fight
// the user's own clicks afterwards.
export function useSelection(items: ExtensionItem[] | undefined) {
  const param = useContext(RouteParamContext)
  const [type, setType] = useState<TypeFilter>('all')
  const [bucket, setBucket] = useState<Bucket | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const applied = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    if (!items || applied.current === param) return
    applied.current = param
    if (param === 'broken') {
      setBucket('broken')
      setType('all')
      setSelectedId(null)
    } else if (param) {
      setBucket(null)
      setType('all')
      setSelectedId(param)
    }
  }, [items, param])

  const visible = useMemo(() => (items ? visibleItems(items, type, bucket) : []), [items, type, bucket])
  // A selection hidden by the current filter falls back to the first visible
  // row, never to an item the list isn't showing.
  const selected = visible.find((i) => i.id === selectedId) ?? visible[0] ?? null

  return {
    type,
    bucket,
    visible,
    selected,
    select: setSelectedId,
    setType,
    toggleBucket: (b: Bucket) => setBucket((cur) => (cur === b ? null : b)),
    // The bundled-server → plugin jump: clear filters so the target shows.
    jumpTo: (id: string) => {
      setBucket(null)
      setType('all')
      setSelectedId(id)
    },
  }
}
