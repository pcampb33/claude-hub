import type { ReactNode } from 'react'

// Case-insensitive <mark> highlighting — plain text in, text nodes and <mark>
// elements out. Lives in shared/ because both plain prose (the transcript's
// verbatim turns, a search snippet) and rendered markdown (MarkdownLite's
// inline leaves) highlight through it; a renderer in shared/ must not reach
// up into a feature folder for it.
export function markText(text: string, query: string): ReactNode {
  const q = query.trim().toLowerCase()
  if (!q) return text
  const lower = text.toLowerCase()
  let idx = lower.indexOf(q)
  if (idx === -1) return text
  const parts: ReactNode[] = []
  let pos = 0
  while (idx !== -1) {
    if (idx > pos) parts.push(text.slice(pos, idx))
    parts.push(<mark key={idx}>{text.slice(idx, idx + q.length)}</mark>)
    pos = idx + q.length
    idx = lower.indexOf(q, pos)
  }
  if (pos < text.length) parts.push(text.slice(pos))
  return parts
}
