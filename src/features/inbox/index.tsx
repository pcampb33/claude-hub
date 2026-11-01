import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInbox } from './useInbox'
import { TriageQueue } from './TriageQueue'
import { SkeletonList } from '../shared/Skeleton'
import { EmptyState } from '../shared/EmptyState'
import { ErrorNotice } from '../shared/ErrorNotice'
import { InboxIcon } from '../shared/icons'
import { ViewHeader, RefreshAction } from '../shared/ViewHeader'
import { useReportLoading } from '../shared/appLoading'
import { useNavigate } from '../shared/useHashRoute'
import { relativeTime } from '../shared/relative-time'
import { toast } from '../shared/toast'
import { vaultNoteNameFor } from '../../../shared/vault-note-name'
import type { VaultInboxEntry } from '../../../shared/ipc-types'
import './inbox.css'

type ConfidenceFilter = 'all' | 'high' | 'medium' | 'low'

// Renderer-local record of the last approve/discard so the empty state can say
// what happened last (there's no history channel — resolved entries leave
// _inbox.md). UI-only, so localStorage is the right home (see useHashRoute).
const LAST_RESOLUTION_KEY = 'claude-hub:inbox-last-resolution'

interface LastResolution {
  action: 'approve' | 'reject'
  title: string
  at: string
}

function readLastResolution(): LastResolution | null {
  try {
    const raw = localStorage.getItem(LAST_RESOLUTION_KEY)
    return raw ? (JSON.parse(raw) as LastResolution) : null
  } catch {
    return null
  }
}

// Why an empty queue is not the end of the feature: the daily drain promotes
// only the high-confidence cluster reps (inbox-drain-core), so everything
// below that bar still lands here for the human gate.
const REFILL_HINT =
  'Session-end curation queues candidates here, and the drain job only auto-promotes the high-confidence ones — medium and low still wait for your call.'

const entryKey = (e: VaultInboxEntry) => e.sessionId + e.title

export function InboxView() {
  const { inbox, loading, error, refresh, resolve } = useInbox()
  useReportLoading(loading)
  const navigate = useNavigate()

  const [filter, setFilterState] = useState<ConfidenceFilter>('all')
  // Selection pins the entry's key: a row resolving away ABOVE the selection
  // must not shift it onto a different entry. The index is the fallback queue
  // position for when the pinned entry itself resolves — the next candidate
  // slides into the same slot.
  const [selected, setSelected] = useState<{ key: string | null; index: number }>({ key: null, index: 0 })
  // Switching lenses restarts the walk at the top of the queue.
  const setFilter = (next: ConfidenceFilter) => {
    setFilterState(next)
    setSelected({ key: null, index: 0 })
  }
  const [previewOpen, setPreviewOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // Session tally for the footer — client-side since mount, by design.
  const [tally, setTally] = useState({ added: 0, discarded: 0 })
  // The approve toast is local (not shared toast.success) because it carries
  // an action: "View in Knowledge →" deep-links to the note just written.
  const [approveToast, setApproveToast] = useState<{ title: string; noteId: string } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const entries = useMemo(() => inbox?.entries ?? [], [inbox])
  const counts = useMemo(() => {
    const c = { high: 0, medium: 0, low: 0 }
    for (const e of entries) if (e.confidence) c[e.confidence]++
    return c
  }, [entries])
  const visible = useMemo(
    () => (filter === 'all' ? entries : entries.filter((e) => e.confidence === filter)),
    [entries, filter],
  )

  // Resolve the selection key-first: while the pinned entry is in the queue
  // it keeps the selection wherever it moves; once it's gone, fall back to
  // its old index (clamped) so the next candidate lands on the same slot.
  const keyedIndex = selected.key === null ? -1 : visible.findIndex((e) => entryKey(e) === selected.key)
  const selectedIndex = keyedIndex !== -1 ? keyedIndex : Math.min(selected.index, Math.max(visible.length - 1, 0))
  const selectedEntry = visible[selectedIndex] ?? null
  const selectedKey = selectedEntry ? entryKey(selectedEntry) : null

  const selectIndex = useCallback(
    (i: number) => setSelected({ key: visible[i] ? entryKey(visible[i]) : null, index: i }),
    [visible],
  )

  // Re-pin after the queue shifts under the selection, so the stored key and
  // index always describe the entry actually selected (guard stops the loop;
  // converges in one pass).
  useEffect(() => {
    if (selected.key !== selectedKey || selected.index !== selectedIndex) {
      setSelected({ key: selectedKey, index: selectedIndex })
    }
  }, [selected.key, selected.index, selectedKey, selectedIndex])

  // Preview is per-entry and closed by default — moving selection closes it.
  useEffect(() => {
    setPreviewOpen(false)
  }, [selectedKey])

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
    },
    [],
  )

  const handleResolve = useCallback(
    async (entry: VaultInboxEntry, action: 'approve' | 'reject') => {
      if (busy) return
      setBusy(true)
      try {
        const res = await resolve(entry, action)
        if (!res.ok) return
        // A write can succeed while its vault commit fails, which means the
        // note landed with no undo behind it. `ok` alone cannot say that, which
        // is why the writer returns a typed `commit` — reading it is the whole
        // point of it being typed.
        if (res.commit?.kind === 'failed') {
          toast.error(`Saved, but the vault commit failed — no undo for this one. ${res.commit.message}`)
        }
        localStorage.setItem(
          LAST_RESOLUTION_KEY,
          JSON.stringify({ action, title: entry.title, at: new Date().toISOString() } satisfies LastResolution),
        )
        if (action === 'approve') {
          setTally((t) => ({ ...t, added: t.added + 1 }))
          // The resolve result carries no notePath, so derive the note id the
          // same way the writer names new files — via the shared mapping, not a
          // fourth copy of the regex. The copy that used to sit here is exactly
          // how the writer and its own matcher drifted apart in the first place.
          const noteId = vaultNoteNameFor(entry.title)
          setApproveToast({ title: entry.title, noteId })
          if (toastTimer.current) clearTimeout(toastTimer.current)
          toastTimer.current = setTimeout(() => setApproveToast(null), 8000)
        } else {
          setTally((t) => ({ ...t, discarded: t.discarded + 1 }))
          toast.success('Discarded.')
        }
      } finally {
        setBusy(false)
      }
    },
    [busy, resolve],
  )

  // Keyboard triage: ↑/↓ move, Enter approve, D discard, Space preview.
  // Skips typing contexts, and leaves Enter/Space alone when a real button has
  // focus so native activation still wins there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // No key-repeat: a held Enter/D would re-fire as the next entry slides
      // into the freed slot — serial auto-resolve over a one-way, no-undo op.
      if (e.repeat) return
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        t.isContentEditable
      )
        return
      if (visible.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        selectIndex(Math.min(selectedIndex + 1, visible.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        selectIndex(Math.max(selectedIndex - 1, 0))
      } else if (e.key === 'd' || e.key === 'D') {
        const entry = visible[selectedIndex]
        if (entry) {
          e.preventDefault()
          handleResolve(entry, 'reject')
        }
      } else if (e.key === 'Enter' && t.tagName !== 'BUTTON') {
        const entry = visible[selectedIndex]
        if (entry) {
          e.preventDefault()
          handleResolve(entry, 'approve')
        }
      } else if (e.key === ' ' && t.tagName !== 'BUTTON') {
        e.preventDefault()
        setPreviewOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, selectedIndex, selectIndex, handleResolve])

  const last = inbox && inbox.count === 0 ? readLastResolution() : null

  return (
    <section className="inbox-view">
      <ViewHeader
        title="Vault Inbox"
        subtitle="Curator suggestions from your sessions — you approve or discard them here, and the daily drain job auto-promotes the high-confidence ones on its own."
        actions={<RefreshAction loading={loading} onClick={() => refresh()} />}
      />

      {error && <ErrorNotice message={error} onRetry={() => refresh()} />}

      {loading && inbox === null && <SkeletonList rows={5} rowHeight={44} />}

      {/* An empty queue is the steady state here, so the empty state has to
          earn its space: say what refills it, not just that it is empty. The
          !error gate is the point — a failed read must not be reported as
          "Inbox clear", which is a claim nobody actually verified. */}
      {inbox && inbox.count === 0 && !loading && !error && (
        <EmptyState
          glyph={<InboxIcon />}
          title="Inbox clear"
          hint={
            REFILL_HINT +
            (last
              ? ` Last decision: ${last.action === 'approve' ? 'added' : 'discarded'} "${last.title}" ${relativeTime(last.at, Date.now())}.`
              : '')
          }
          action={<button onClick={() => navigate('knowledge')}>Open Knowledge Vault</button>}
        />
      )}

      {inbox && inbox.count > 0 && (
        <div className="inbox-body">
          <div className="triage-bar">
            <button className={`chip${filter === 'all' ? ' active' : ''}`} onClick={() => setFilter('all')}>
              All <span className="chip-n">{entries.length}</span>
            </button>
            {(['high', 'medium', 'low'] as const).map(
              (level) =>
                counts[level] > 0 && (
                  <button
                    key={level}
                    className={`chip${filter === level ? ' active' : ''}`}
                    onClick={() => setFilter(level)}
                  >
                    <span className={`conf-dot conf-${level}`} />
                    {level} <span className="chip-n">{counts[level]}</span>
                  </button>
                ),
            )}
            <span className="triage-count">
              {visible.length === 0 ? 0 : selectedIndex + 1} / {visible.length}
            </span>
          </div>

          {visible.length === 0 ? (
            <p className="triage-none">No {filter}-confidence candidates queued.</p>
          ) : (
            <TriageQueue
              entries={visible}
              selectedIndex={selectedIndex}
              onSelect={selectIndex}
              previewOpen={previewOpen}
              onTogglePreview={() => setPreviewOpen((v) => !v)}
              onResolve={handleResolve}
              busy={busy}
            />
          )}

          <div className="queue-foot">
            <span className="q-keys">
              <kbd>↑</kbd>
              <kbd>↓</kbd> move
            </span>
            <span className="q-keys">
              <kbd>⏎</kbd> add to vault
            </span>
            <span className="q-keys">
              <kbd>D</kbd> discard
            </span>
            <span className="q-keys">
              <kbd>Space</kbd> preview
            </span>
            <span className="queue-tally">
              today: <b>{tally.added} added</b> · {tally.discarded} discarded
            </span>
          </div>
        </div>
      )}

      {approveToast && (
        <div className="inbox-toast" role="status">
          <span className="inbox-toast-dot" />
          <span className="inbox-toast-msg">
            Added to vault — <b>{approveToast.title}</b>
          </span>
          <button className="inbox-toast-link" onClick={() => navigate('knowledge', approveToast.noteId)}>
            View in Knowledge →
          </button>
        </div>
      )}
    </section>
  )
}
