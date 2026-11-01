import { useState } from 'react'
import { toast } from '../shared/toast'

// Inline quick-capture form — writes straight to the vault via the same
// mechanism as scripts/log-to-vault.mjs (dedup by title against index.md).
// The "+ Note" toggle lives in the Knowledge view header; this is just
// the form body shown beneath it.
export function QuickCapture({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!title.trim() || !body.trim()) return
    setSaving(true)
    try {
      const result = await window.hubApi.quickCaptureVaultNote({ title: title.trim(), content: body.trim() })
      if (result.ok) {
        // Not just `ok`: the vault commit is this note's only undo, so a write
        // that landed without one must not read as a clean save.
        if (result.commit?.kind === 'failed') {
          toast.error(`Saved, but the vault commit failed — no undo for this one. ${result.commit.message}`)
        } else {
          toast.success('Note saved to vault.')
        }
        onSaved()
      } else {
        toast.error(result.message ?? 'Saving the note failed.')
      }
    } catch {
      toast.error('Saving the note failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card quick-capture">
      <input
        type="text"
        placeholder="Note title…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={saving}
      />
      <textarea
        className="quick-capture-body"
        placeholder="Note content (markdown)…"
        rows={4}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={saving}
      />
      <div className="quick-capture-actions">
        <button onClick={handleSave} disabled={saving || !title.trim() || !body.trim()}>
          {saving ? 'Saving…' : 'Save to vault'}
        </button>
        <button className="btn-ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  )
}
