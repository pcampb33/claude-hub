import { useEffect, useState } from 'react'

// Single breakpoint for the phone layout — keep in sync with the
// `@media (max-width: 720px)` blocks in App.css and the feature CSS.
const NARROW_QUERY = '(max-width: 720px)'

// True below the phone breakpoint. Master-detail views use this to switch
// from side-by-side panes to drill-in (list → tap → full-width detail with
// a back button); the auto-select-first-row default is suppressed while
// narrow so landing on a view shows the list, not a detail you never chose.
export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches)
  useEffect(() => {
    const mql = window.matchMedia(NARROW_QUERY)
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return narrow
}
