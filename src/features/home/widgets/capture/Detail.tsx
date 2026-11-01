import type { KeyboardEvent } from 'react'
import { PeekContent } from '../../peek'
import { Actions, Btn, Empty, KV, Loading, Row, RowList, Sec, Unreachable } from '../../parts'
import { useInboxRead } from '../../reads'
import { relativeTime } from '../../../shared/relative-time'
import { useNavigate } from '../../../shared/useHashRoute'
import { useVaultGraphRead } from '../../reads'

// What capture does, the vault it writes into, and its newest notes. No IPC
// says which notes came from capture rather than an inbox approve, so the
// list is "newest in the vault", not "your captures".
export function CaptureDetail() {
  const graph = useVaultGraphRead()
  const inbox = useInboxRead()
  const navigate = useNavigate()

  const newest = graph.data
    ? [...graph.data.notes].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 6)
    : []
  const link = (id: string, label: string) => ({
    role: 'button',
    tabIndex: 0,
    'aria-label': label,
    onClick: () => navigate('knowledge', id),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        navigate('knowledge', id)
      }
    },
  })

  return (
    <PeekContent crumb="Quick capture" title="Quick capture">
      <Sec>
        <p>
          Saving writes a note straight into the shared vault — no inbox, no review — and commits it to the vault’s git
          repo, which is its undo. A note whose title matches an existing one is appended to that note instead. The linker then
          connects it to related notes in the background.
        </p>
        <p className="sub">
          Not tagged to a project: the capture call carries only a title and body. The graph infers a project from
          the text when it names one.
        </p>
      </Sec>
      <Sec title="Vault">
        {graph.status === 'loading' && <Loading rows={2} />}
        {graph.status === 'error' && <Unreachable what="the vault" error={graph.error} onRetry={graph.refresh} />}
        {graph.data && (
          <KV
            rows={[
              ['Notes', graph.data.notes.length],
              ['Links', graph.data.edges.length],
              [
                'Waiting in the inbox',
                inbox.status === 'data' ? inbox.data.entries.length : inbox.status === 'error' ? 'couldn’t read' : '…',
              ],
            ]}
          />
        )}
      </Sec>
      {graph.data && (
        <Sec title="Newest notes">
          {newest.length === 0 ? (
            <Empty title="The vault has no notes yet" />
          ) : (
            <RowList>
              {newest.map((n) => (
                <Row
                  key={n.id}
                  label={n.title}
                  figure={relativeTime(n.createdAt, Date.now())}
                  target={link(n.id, `Open ${n.title}`)}
                />
              ))}
            </RowList>
          )}
        </Sec>
      )}
      <Sec>
        <Actions>
          <Btn kind="primary" onClick={() => navigate('knowledge')}>
            Open Notes
          </Btn>
        </Actions>
      </Sec>
    </PeekContent>
  )
}
