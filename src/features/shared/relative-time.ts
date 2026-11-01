// Compact relative timestamp — shared by the dashboard rows and the
// Verify Floor cards.
export function relativeTime(iso: string, nowMs: number): string {
  const ms = new Date(iso).getTime()
  // An empty/unparseable date is NaN, which slips past every comparison below
  // and renders "NaNd ago" — guard it to a plain label instead.
  if (Number.isNaN(ms)) return 'unknown'
  const minutes = Math.round((nowMs - ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

// Same, tolerant of a missing timestamp (never-active projects) and clocking
// off Date.now() at call time — for the Projects list/detail, which have no
// shared now-tick to thread through. Replaces two divergent local copies that
// rendered "3h" in the master row while the detail pane rendered "3h ago".
export function relativeTimeOrNever(iso: string | null): string {
  return iso ? relativeTime(iso, Date.now()) : 'never'
}
