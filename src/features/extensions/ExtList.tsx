import { useRef } from 'react'
import type { ExtensionItem } from '../../../shared/ipc-types'
import { bucketOf, callsOf, compactTokens, GROUPS, originLabel, statusLabel } from './model'
import { Glyph } from './bits'

const kindShort = (i: ExtensionItem) => (i.kind === 'mcp' ? 'MCP' : i.kind === 'plugin' ? 'Plugin' : 'Connector')

// The right-hand figure: calls if any, else a plugin's always-on cost, else
// the status (a connected server with a scanned zero says "0 calls").
function figure(i: ExtensionItem): { text: string; hot: boolean } {
  if (callsOf(i) > 0) return { text: `${callsOf(i).toLocaleString()} calls`, hot: true }
  if (i.alwaysOnTokens) return { text: `~${compactTokens(i.alwaysOnTokens)} tok`, hot: false }
  if (i.status === 'connected' && i.usage) return { text: '0 calls', hot: false }
  return { text: statusLabel(i), hot: false }
}

export function ExtList({
  items,
  selectedId,
  onPick,
  usageKnown,
}: {
  items: ExtensionItem[]
  selectedId: string | null
  onPick: (id: string) => void
  // Without a usage scan, "never used" would be a claim nobody measured.
  usageKnown: boolean
}) {
  const listRef = useRef<HTMLDivElement>(null)

  // ↑/↓ move the selection itself (not just focus), so the detail follows.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-xid]') ?? [])
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    const next = rows[at < 0 ? 0 : at + (e.key === 'ArrowDown' ? 1 : -1)]
    if (!next) return
    e.preventDefault()
    next.focus()
    onPick(next.dataset.xid!)
  }

  if (items.length === 0) {
    return (
      <div className="ext-list">
        <div className="ext-empty">
          <b>Nothing here</b>
          <span>No extensions match this filter.</span>
        </div>
      </div>
    )
  }

  return (
    <div className="ext-list" role="listbox" aria-label="Extensions" ref={listRef} onKeyDown={onKeyDown}>
      {GROUPS.map((g) => {
        const rows = items.filter((i) => bucketOf(i) === g.key)
        if (!rows.length) return null
        const tokens = g.key === 'idle' ? rows.reduce((a, i) => a + (i.alwaysOnTokens ?? 0), 0) : 0
        const label = g.key === 'idle' && !usageKnown ? 'Loaded, usage unknown' : g.label
        return (
          <div key={g.key} role="group" aria-label={label}>
            <div className="ext-group" data-tone={g.tone}>
              {label} <em>{rows.length}</em>
              {tokens > 0 && <small>~{compactTokens(tokens)} tok every session</small>}
            </div>
            {rows.map((i) => {
              const f = figure(i)
              return (
                <button
                  type="button"
                  key={i.id}
                  className="ext-row"
                  role="option"
                  aria-selected={i.id === selectedId}
                  data-xid={i.id}
                  onClick={() => onPick(i.id)}
                >
                  <Glyph item={i} />
                  <span className="ext-row-text">
                    <b>{i.name}</b>
                    <small>
                      {kindShort(i)} · {originLabel(i)}
                      {f.text !== statusLabel(i) && ` · ${statusLabel(i)}`}
                    </small>
                  </span>
                  <span className={`ext-row-num${f.hot ? ' hot' : ''}`}>{f.text}</span>
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
