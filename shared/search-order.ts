import type { SessionSearchMatch } from './ipc-types'

// The order search results are presented in: matches from the project the user
// asked to prioritise first, everything else by date, newest first.
//
// Shared because a "search everything" sweep arrives as several chunks and the
// renderer re-sorts the merged list — sorting each chunk on its own would put
// chunk 2's boosted matches below chunk 1's unboosted ones, so the boost would
// only hold within a chunk. One comparator, both sides.
export function compareSearchMatches(currentProjectId?: string) {
  return (a: SessionSearchMatch, b: SessionSearchMatch): number => {
    if (currentProjectId) {
      const aCurrent = a.projectId === currentProjectId ? 0 : 1
      const bCurrent = b.projectId === currentProjectId ? 0 : 1
      if (aCurrent !== bCurrent) return aCurrent - bCurrent
    }
    return b.date.localeCompare(a.date)
  }
}
