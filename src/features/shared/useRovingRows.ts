import { useCallback, useRef } from 'react'

// ↑/↓ walk a master list by moving focus between its row buttons; Enter and
// Space then activate the focused row, because the rows are real <button>s.
//
// Lifted verbatim from knowledge/BrowsePane, which had the only implementation
// in the app — every other master list (Sessions, Projects, Skills, Workflows,
// Sandbox, Commands) was tab-per-row, so reaching row 30 of 40 cost 30 presses.
//
// Focus-based rather than a selected-index state on purpose: the row that has
// focus is the row the browser will activate, so there is no second source of
// truth to drift, `:focus-visible` styling comes for free, and a view that
// already tracks a selection does not need to reconcile two of them.
//
// The caller supplies the row selector because each view names its rows
// differently (`.session-master-row`, `.project-master-row`, …); a shared class
// would have meant editing six CSS files to gain nothing.
export function useRovingRows(rowSelector: string) {
  const listRef = useRef<HTMLDivElement>(null)

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const rowEls = listRef.current?.querySelectorAll<HTMLButtonElement>(rowSelector)
      if (!rowEls || rowEls.length === 0) return
      e.preventDefault()
      const current = Array.from(rowEls).indexOf(document.activeElement as HTMLButtonElement)
      const next = e.key === 'ArrowDown' ? Math.min(current + 1, rowEls.length - 1) : Math.max(current - 1, 0)
      rowEls[next]?.focus()
    },
    [rowSelector],
  )

  return { listRef, onKeyDown }
}
