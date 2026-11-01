import { useEffect, useRef, useState } from 'react'
import { MarkdownLite } from '../shared/MarkdownLite'
import { markText } from '../shared/mark-text'
import { flattenTranscript, runSummary, toolLeaf } from './transcript-model'
import type { SessionMessage } from '../../../shared/ipc-types'
import './sessions.css'

// Consecutive tool chips collapse into one roll-up strip once a run hits
// this length; runs of 1-2 read fine inline.
const ROLLUP_MIN = 3

function ToolChip({ name }: { name: string }) {
  return (
    <div className="session-toolchip" title={name}>
      <span className="session-toolchip-mark">✓</span>
      {toolLeaf(name)}
    </div>
  )
}

function ToolRun({ tools, defaultOpen }: { tools: string[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  // A live tail run mounts while it IS the tail, so it mounts open — and
  // would stay open once a newer run appears, leaving a long live session
  // with every strip expanded. Collapse on the true→false transition only;
  // manual toggles are otherwise untouched.
  const wasDefaultOpen = useRef(defaultOpen)
  useEffect(() => {
    if (wasDefaultOpen.current && !defaultOpen) setOpen(false)
    wasDefaultOpen.current = defaultOpen
  }, [defaultOpen])
  return (
    <div className="session-toolrun">
      <button type="button" className="session-toolrun-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="session-toolrun-caret">{open ? '▾' : '▸'}</span>
        <span className="session-toolchip-mark">✓</span>
        <span className="session-toolrun-count">{tools.length} tool calls</span>
        <span className="session-toolrun-tally">— {runSummary(tools)}</span>
      </button>
      {open && (
        <div className="session-toolrun-body">
          {tools.map((tool, i) => (
            <ToolChip key={`${tool}-${i}`} name={tool} />
          ))}
        </div>
      )}
    </div>
  )
}

// The chat renderer shared by the Sessions detail pane and Search's
// transcript pane: prose bubbles, tool chips, and runs of ≥3 consecutive
// chips rolled up into one collapsible inset strip.
//   autoExpandTail — live sessions keep the newest run open; its tail chip
//     is the "what is it doing right now" signal.
//   highlight — case-insensitive query; matching prose turns get accent-
//     marked (Search's ‹ › stepper walks .session-turn-matched nodes).
export function SessionTranscript({
  messages,
  autoExpandTail = false,
  highlight,
}: {
  messages: SessionMessage[]
  autoExpandTail?: boolean
  highlight?: string
}) {
  const items = flattenTranscript(messages)
  let lastRollupIndex = -1
  items.forEach((item, i) => {
    if (item.kind === 'run' && item.tools.length >= ROLLUP_MIN) lastRollupIndex = i
  })
  const q = highlight?.trim().toLowerCase() ?? ''
  return (
    <>
      {items.map((item, i) => {
        if (item.kind === 'prose') {
          const matched = q !== '' && item.text.toLowerCase().includes(q)
          // Assistant prose carries markdown in ~54% of turns and read as
          // literal "**bold**" / "`code`" until this. USER turns stay
          // verbatim, measured over 120 transcripts rather than assumed:
          // they fit the grammar only 53% of the time (vs 96% for assistant)
          // and carry globs — a pasted "**/*.jar" pair is a false bold.
          //
          // A query does NOT drop the pane back to unformatted text: the
          // renderer marks its own leaves, so opening find no longer reflows
          // the whole transcript out from under the reader.
          const asMarkdown = item.role === 'assistant'
          return (
            <div
              key={`p${item.msgIndex}`}
              className={`session-turn session-turn-${item.role}${matched ? ' session-turn-matched' : ''}`}
            >
              {asMarkdown ? (
                // The turns outside the grammar (1 in 2342, measured) fall
                // back to this bubble's own pre-wrap text, not markdown-lite's
                // monospace <pre> — which would be a downgrade from what the
                // transcript rendered before.
                <MarkdownLite
                  source={item.text}
                  className="session-turn-md"
                  highlight={highlight}
                  fallback={matched && highlight ? markText(item.text, highlight) : item.text}
                />
              ) : matched && highlight ? (
                markText(item.text, highlight)
              ) : (
                item.text
              )}
            </div>
          )
        }
        if (item.tools.length < ROLLUP_MIN) {
          // One row, not one row each: two loose chips stacked cost more
          // vertical space than the sentence they sit between.
          return (
            <div className="session-toolrow" key={`r${item.runKey}`}>
              {item.tools.map((tool, j) => (
                <ToolChip key={`${tool}-${j}`} name={tool} />
              ))}
            </div>
          )
        }
        return (
          <ToolRun key={`r${item.runKey}`} tools={item.tools} defaultOpen={autoExpandTail && i === lastRollupIndex} />
        )
      })}
    </>
  )
}
