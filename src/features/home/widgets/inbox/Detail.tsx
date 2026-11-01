import type { VaultInboxEntry } from '../../../../../shared/ipc-types'
import { PeekContent } from '../../peek'
import { Actions, Btn, Code, Empty, KV, Loading, Row, RowList, Sec, Unreachable } from '../../parts'
import { usePeekTarget } from '../../peek-context'
import { useInboxRead } from '../../reads'
import type { DetailProps } from '../../types'
import { MarkdownLite } from '../../../shared/MarkdownLite'
import { relativeTime } from '../../../shared/relative-time'
import { useNavigate } from '../../../shared/useHashRoute'
import { entryKey } from './model'
import { useResolveInbox } from './useResolveInbox'
import './inbox.css'

const CRUMB = 'Inbox triage'

// { entry: i } opens one entry; no ctx lists them all. After a resolve the
// same index shows the next entry, so a scoped peek walks the queue.
export function InboxDetail({ ctx }: DetailProps) {
  const inbox = useInboxRead()
  const { pending, resolve } = useResolveInbox()
  const navigate = useNavigate()
  const peekTarget = usePeekTarget()
  const entries = inbox.status === 'data' ? inbox.data.entries : null
  const index = typeof ctx?.entry === 'number' ? ctx.entry : null
  const one = entries && index != null ? entries[index] : undefined

  const openInbox = (
    <Sec>
      <Actions>
        <Btn kind={one ? 'ghost' : 'primary'} onClick={() => navigate('inbox')}>
          Open Inbox
        </Btn>
      </Actions>
    </Sec>
  )

  if (!entries) {
    return (
      <PeekContent crumb={CRUMB} title="Vault inbox">
        <Sec>
          {inbox.status === 'loading' && <Loading rows={4} />}
          {inbox.status === 'error' && <Unreachable what="the vault inbox" error={inbox.error} onRetry={inbox.refresh} />}
        </Sec>
        {openInbox}
      </PeekContent>
    )
  }

  if (one) {
    const others = entries.map((e, i) => ({ e, i })).filter(({ i }) => i !== index)
    return (
      <PeekContent crumb={CRUMB} title={one.title}>
        <EntryBody e={one} />
        <Sec>
          <Actions>
            <Btn kind="primary" onClick={() => resolve(one, 'approve')} disabled={pending != null}>
              {pending === entryKey(one) ? 'Working…' : 'Add to vault'}
            </Btn>
            <Btn onClick={() => resolve(one, 'reject')} disabled={pending != null}>
              Discard
            </Btn>
          </Actions>
        </Sec>
        {others.length > 0 && (
          <Sec title={`Also waiting · ${others.length}`}>
            <RowList>
              {others.map(({ e, i }) => (
                <Row
                  key={entryKey(e)}
                  label={e.title}
                  figure={e.project ?? '—'}
                  target={peekTarget('inbox', { entry: i }, `Review “${e.title}”`)}
                />
              ))}
            </RowList>
          </Sec>
        )}
        {openInbox}
      </PeekContent>
    )
  }

  return (
    <PeekContent crumb={CRUMB} title="Vault inbox">
      {entries.length === 0 ? (
        <Sec>
          <Empty title="Inbox clear">
            Nothing waiting. The noon drain merges duplicates and auto-adds high-confidence notes.
          </Empty>
        </Sec>
      ) : (
        entries.map((e) => (
          <Sec key={entryKey(e)}>
            <b className="ib-peek-title">{e.title}</b>
            <p className="sub">{e.justification}</p>
            <div className="sub">{metaLine(e)}</div>
            {e.body && (
              <details className="ib-preview">
                <summary>Preview the note</summary>
                <MarkdownLite source={e.body} />
              </details>
            )}
            <Actions>
              <Btn kind="primary" onClick={() => resolve(e, 'approve')} disabled={pending != null}>
                {pending === entryKey(e) ? 'Working…' : 'Add to vault'}
              </Btn>
              <Btn onClick={() => resolve(e, 'reject')} disabled={pending != null}>
                Discard
              </Btn>
            </Actions>
          </Sec>
        ))
      )}
      {openInbox}
    </PeekContent>
  )
}

function metaLine(e: VaultInboxEntry): string {
  return [
    e.project ?? 'no project',
    e.confidence ? `${e.confidence} confidence` : null,
    `queued ${relativeTime(e.timestamp, Date.now())}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

function EntryBody({ e }: { e: VaultInboxEntry }) {
  return (
    <>
      <Sec>
        <KV
          rows={[
            ['Project', e.project ?? 'not resolved'],
            ['Confidence', e.confidence ?? 'not given (queued before the curator rated entries)'],
            ['Queued', `${relativeTime(e.timestamp, Date.now())} · ${new Date(e.timestamp).toLocaleString()}`],
            ['Session', <Code key="s">{e.sessionId}</Code>],
          ]}
        />
      </Sec>
      <Sec title="Why it was queued">
        <p>{e.justification}</p>
      </Sec>
      <Sec title="The note that will be written">
        {e.body ? (
          <div className="ib-body">
            <MarkdownLite source={e.body} />
          </div>
        ) : (
          <p className="sub">This entry was queued before previews existed; its text isn’t in the inbox payload.</p>
        )}
      </Sec>
    </>
  )
}
