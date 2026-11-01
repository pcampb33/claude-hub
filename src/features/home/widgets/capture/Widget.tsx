import { useRef, useState } from 'react'
import type { WidgetProps } from '../../types'
import { invalidateHubRead } from '../../useHubRead'
import { KEYS } from '../../reads'
import { toast } from '../../../shared/toast'
import { shortTitle, writeToast } from '../inbox/model'
import { noteNameFromPath } from './model'
import './capture.css'

// Write a note straight into the vault. No project picker: the capture IPC
// carries only { title, content }, and a project only becomes durable as
// `project:` frontmatter that writeVaultNote writes from its own argument —
// text in the body can't reach it.
export function CaptureWidget({ size }: WidgetProps) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  const save = () => {
    const t = title.trim()
    if (!t) {
      titleRef.current?.focus()
      return
    }
    if (saving) return
    setSaving(true)
    window.hubApi
      .quickCaptureVaultNote({ title: t, content: body.trim() })
      .then(
        (result) => {
          const name = noteNameFromPath(result.notePath) ?? t
          const msg = writeToast(result, `Saved “${shortTitle(name)}” to the vault`)
          toast[msg.kind](msg.message)
          if (result.ok) {
            setTitle('')
            setBody('')
            invalidateHubRead(KEYS.vaultGraph)
            titleRef.current?.focus()
          }
        },
        (err: unknown) => toast.error(`Couldn’t save the note: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => setSaving(false))
  }

  return (
    <form
      className="cap"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <input
        ref={titleRef}
        type="text"
        aria-label="Note title"
        placeholder="Jot a finding for the vault…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        readOnly={saving}
      />
      <textarea
        aria-label="Note body (optional)"
        placeholder="Details, optional · Ctrl+Enter saves"
        rows={size === 'S' ? 2 : 4}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            save()
          }
        }}
        readOnly={saving}
      />
      <div className="cap-row">
        <span className="sub">Enter saves · linked in the background</span>
        <button type="submit" className="hbtn hbtn-primary" disabled={saving || !title.trim()}>
          {saving ? 'Saving…' : 'Save note'}
        </button>
      </div>
    </form>
  )
}
