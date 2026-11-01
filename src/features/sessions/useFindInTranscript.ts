import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

// Scroll one node to the middle of its own scrolling pane. scrollIntoView
// would also drag every scrollable ancestor (the whole view) toward the
// node; narrow layouts that lift the pane's max-height and let the page
// scroll instead are the one case where it IS the right call.
export function scrollIntoPane(pane: HTMLElement, node: Element): void {
  if (pane.scrollHeight <= pane.clientHeight) {
    node.scrollIntoView({ block: 'center' })
    return
  }
  const paneRect = pane.getBoundingClientRect()
  const nodeRect = node.getBoundingClientRect()
  pane.scrollTop += nodeRect.top - paneRect.top - (pane.clientHeight - nodeRect.height) / 2
}

// Walks the <mark> nodes a highlighted transcript renders — one step per
// OCCURRENCE, not per turn. A turn can be a screen and a half of prose, so
// landing the reader on the turn still leaves them hunting; this lands them
// on the word.
//
// The count is read from the DOM rather than counted in the message data on
// purpose — a rendered turn is not its source text (markdown syntax, tool
// placeholder lines), so data-side arithmetic would disagree with what the
// reader can actually step to. `revision` is whatever changing value means
// "the transcript re-rendered"; the caller distinguishes a not-yet-loaded
// transcript from a genuine zero, since a count of 0 here means both.
export function useMarkStepper(bodyRef: RefObject<HTMLElement | null>, query: string, revision: unknown) {
  const [index, setIndex] = useState(0)
  const [count, setCount] = useState(0)

  useLayoutEffect(() => {
    const found = bodyRef.current?.querySelectorAll('mark').length ?? 0
    setCount(found)
    setIndex((i) => (i >= found ? 0 : i))
  }, [bodyRef, query, revision])

  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const marks = [...body.querySelectorAll('mark')]
    marks.forEach((node, i) => node.classList.toggle('is-current', i === index))
    const current = marks[index]
    if (current) scrollIntoPane(body, current)
  }, [bodyRef, index, count, query, revision])

  const walk = useCallback(
    (delta: number) => {
      if (count === 0) return
      setIndex((i) => (i + delta + count) % count)
    },
    [count],
  )

  return { index, count, walk, setIndex }
}

// Find-in-transcript: Ctrl+F opens a bar over the session detail and its
// query goes to SessionTranscript as `highlight`. Search's transcript pane
// uses useMarkStepper directly instead — its query already comes from the
// search box, so it needs the stepper without the bar.
export function useFindInTranscript(bodyRef: RefObject<HTMLElement | null>, revision: unknown) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const { index, count, walk, setIndex } = useMarkStepper(bodyRef, query, revision)

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setIndex(0)
  }, [setIndex])

  // preventDefault: Electron has no native find UI to fall back to.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      if (e.key !== 'f' && e.key !== 'F') return
      e.preventDefault()
      setOpen(true)
      // Reopening on an existing query selects it, so a second Ctrl+F
      // retypes rather than appending.
      window.requestAnimationFrame(() => inputRef.current?.select())
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return { open, query, setQuery, index, count, walk, close, inputRef }
}
