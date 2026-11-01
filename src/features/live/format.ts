// Time/token formatting shared by the live surfaces (titlebar pills, the
// dashboard's hero session).

// A duration at every magnitude — "42s", "4m 09s", "3h 04m". Zero-padded
// MM:SS read as a wall-clock time at the small end ("04:09") and broke
// outright at the large one: a three-hour session rendered "184:07".
export function formatElapsed(fromIso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(fromIso)) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}
