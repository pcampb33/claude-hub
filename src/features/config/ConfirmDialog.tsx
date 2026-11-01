import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'

// A modal yes/no for an action that writes a file outside the hub. Escape or
// the backdrop cancels; focus starts on Cancel and returns to the opener.
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string
  children: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    return () => {
      if (opener && document.contains(opener)) opener.focus()
    }
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    } else if (e.key === 'Tab') {
      const items = panelRef.current?.querySelectorAll<HTMLElement>('button')
      if (!items || items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  return (
    <div
      className="cfg-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="cfg-dialog" role="alertdialog" aria-modal="true" aria-labelledby="cfg-dialog-title" ref={panelRef} onKeyDown={onKeyDown}>
        <h4 id="cfg-dialog-title">{title}</h4>
        <div className="cfg-dialog-body">{children}</div>
        <div className="cfg-dialog-actions">
          <button type="button" autoFocus onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="cfg-primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
