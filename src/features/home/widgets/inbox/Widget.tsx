import { useRelevance, useWidgetMeta } from '../../frame-context'
import { Btn, Empty, Loading, Unreachable } from '../../parts'
import { usePeekTarget } from '../../peek-context'
import { useInboxRead } from '../../reads'
import type { WidgetProps } from '../../types'
import { relativeTime } from '../../../shared/relative-time'
import { useResolveInbox } from './useResolveInbox'
import './inbox.css'

// Glance: the waiting vault candidates as a card stack. The top card is the
// oldest entry, with real Add to vault / Discard; the card body opens it in
// the peek with its full justification and the note that would be written.
export function InboxWidget({ size }: WidgetProps) {
  // S clamps the justification to two lines; wider cards have room for four.
  const inbox = useInboxRead()
  const { pending, resolve } = useResolveInbox()
  const peekTarget = usePeekTarget()
  const entries = inbox.status === 'data' ? inbox.data.entries : null

  useWidgetMeta(
    inbox.status === 'error' ? 'couldn’t read' : entries ? (entries.length ? `${entries.length} waiting` : 'clear') : null,
  )
  // Only a successful read may say "nothing waiting"; loading and a failed
  // read both stay visible.
  useRelevance(entries ? entries.length > 0 : null)

  if (inbox.status === 'loading') return <Loading rows={3} />
  if (inbox.status === 'error') return <Unreachable what="the vault inbox" error={inbox.error} onRetry={inbox.refresh} />
  if (!entries?.length) {
    return <Empty title="Inbox clear">New findings land here after a session ends.</Empty>
  }

  const e = entries[0]
  const behind = Math.min(2, entries.length - 1)
  return (
    <div className="ib-stack" style={{ paddingBottom: behind * 8 }}>
      {behind > 1 && <div className="ib-card ib-back2" aria-hidden="true" />}
      {behind > 0 && <div className="ib-card ib-back" aria-hidden="true" />}
      <div className={`ib-card ib-top${size === 'S' ? '' : ' ib-roomy'}`}>
        <div className="ib-hit" {...peekTarget('inbox', { entry: 0 }, `Review “${e.title}”`)}>
          <b>{e.title}</b>
          <span className="ib-meta">
            {e.project ?? 'no project'}
            {e.confidence && <> · {e.confidence} confidence</>} · {relativeTime(e.timestamp, Date.now())}
          </span>
          {e.justification && <p className="ib-why">{e.justification}</p>}
        </div>
        <div className="ib-acts">
          <Btn kind="primary" onClick={() => resolve(e, 'approve')} disabled={pending != null}>
            Add to vault
          </Btn>
          <Btn onClick={() => resolve(e, 'reject')} disabled={pending != null}>
            Discard
          </Btn>
          {entries.length > 1 && <span className="ib-count">1 of {entries.length}</span>}
        </div>
      </div>
    </div>
  )
}
