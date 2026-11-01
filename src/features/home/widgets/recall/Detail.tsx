import { useMemo, type ReactNode } from 'react'
import type { RecallOffer, RecallScorecard } from '../../../../../shared/ipc-types'
import { PeekContent } from '../../peek'
import { usePeekTarget } from '../../peek-context'
import { Actions, Btn, Empty, KV, Loading, Row, RowList, Sec, Unreachable } from '../../parts'
import { useRecallRead } from '../../reads'
import type { DetailProps } from '../../types'
import { useNavigate } from '../../../shared/useHashRoute'
import { MarkdownLite } from '../../../shared/MarkdownLite'
import { mostRead, neverRead, noteStats, rate, shortDate, unknownReads, type NoteStat, type StageKey } from './recall'
import { useNotePreview } from './useNotePreview'
import { Funnel } from './Funnel'
import './recall.css'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// Delivered offers whose reads can't be checked. The funnel counts them as
// not read; the peek says they're unknown.
const uncheckable = (offers: RecallOffer[]) =>
  offers.filter((o) => o.delivered && o.readTitles.length === 0 && (!o.transcriptFound || o.unparsedLines > 0))

function offerState(o: RecallOffer): string {
  if (!o.delivered) return 'not delivered'
  if (o.readTitles.length > 0) return 'read'
  if (!o.transcriptFound || o.unparsedLines > 0) return 'unknown'
  return o.markerSeen ? 'unread' : 'marker missing'
}

// One offer as a row: its titles, the project, and what happened to it. The
// first title opens that note's peek.
function OfferRows({ offers }: { offers: RecallOffer[] }) {
  const peekTarget = usePeekTarget()
  return (
    <RowList>
      {offers.map((o) => (
        <Row
          key={`${o.sessionId}-${o.at}`}
          label={
            <>
              {o.titles.join(' + ') || '(no titles)'} <span className="sub">· {o.project || 'unknown project'}</span>
            </>
          }
          figure={`${offerState(o)} · ${shortDate(o.at)}`}
          target={o.titles[0] ? peekTarget('recall', { note: o.titles[0] }, `${o.titles[0]} details`) : undefined}
        />
      ))}
    </RowList>
  )
}

function NoteRows({ stats, figure }: { stats: NoteStat[]; figure: (s: NoteStat) => string }) {
  const peekTarget = usePeekTarget()
  return (
    <RowList>
      {stats.map((s) => (
        <Row key={s.title} label={s.title} figure={figure(s)} target={peekTarget('recall', { note: s.title }, `${s.title} details`)} />
      ))}
    </RowList>
  )
}

function Overview({ card, stats }: { card: RecallScorecard; stats: NoteStat[] }) {
  const never = neverRead(stats)
  const most = mostRead(stats)
  const offers = card.offers.length
  const unknown = uncheckable(card.offers).length
  return (
    <>
      <Sec title={`Funnel since ${card.since ? shortDate(card.since) : '—'}`}>
        <Funnel scorecard={card} />
        <p className="sub">
          {rate(offers, card.attempts)} of checked prompts matched a note; {rate(card.delivered, offers)} of offers reached
          a later prompt; {rate(card.readSessions, card.delivered)} of those sessions opened an offered note. $
          {card.spendUsd.toFixed(2)} spent on the matcher.
          {card.errors > 0 && ` The matcher errored ${plural(card.errors, 'time')}.`}
        </p>
        {unknown > 0 && (
          <p className="sub">
            {plural(unknown, 'delivered session')} can’t be checked (transcript pruned from disk or unparseable), so the
            read count is a floor. Of the {card.delivered - unknown} that can, {card.readSessions} read an offered note (
            {rate(card.readSessions, card.delivered - unknown)}).
          </p>
        )}
      </Sec>
      <Sec title="Read most">
        {most.length > 0 ? (
          <NoteRows stats={most.slice(0, 6)} figure={(s) => `read ${s.read} of ${s.delivered}`} />
        ) : (
          <p className="sub">No offered note has been opened yet.</p>
        )}
      </Sec>
      <Sec title="Offered, no read found">
        {never.length > 0 ? (
          <NoteRows stats={never.slice(0, 8)} figure={(s) => `${s.offered}× · ${unknownReads(s) ? `${unknownReads(s)} unknown` : '0 read'}`} />
        ) : (
          <p className="sub">Every note that reached a session was opened at least once.</p>
        )}
      </Sec>
      <Sec title="Latest offers">{offers > 0 ? <OfferRows offers={card.offers.slice(0, 6)} /> : <p className="sub">No offers yet.</p>}</Sec>
    </>
  )
}

const STAGE_TITLE: Record<StageKey, string> = {
  attempts: 'Prompts checked',
  offers: 'Notes offered',
  delivered: 'Offers that reached a session',
  read: 'Sessions that read an offer',
}

function Stage({ stage, card }: { stage: StageKey; card: RecallScorecard }) {
  const offers = card.offers.length
  if (stage === 'attempts')
    return (
      <Sec title="What this counts">
        <p>Each check is one session’s task matched against vault note titles by a haiku worker.</p>
        <KV
          rows={[
            ['Checked', card.attempts],
            ['Matched a note', `${offers} (${rate(offers, card.attempts)})`],
            ['Matched nothing', card.noMatch],
            ['Matcher errors', card.errors],
            ['Spend', `$${card.spendUsd.toFixed(2)}`],
            ['Since', card.since ? shortDate(card.since) : '—'],
          ]}
        />
      </Sec>
    )
  if (stage === 'offers')
    return (
      <Sec title={`${plural(offers, 'offer')}, newest first`}>
        {offers > 0 ? <OfferRows offers={card.offers.slice(0, 12)} /> : <p className="sub">No offers yet.</p>}
      </Sec>
    )
  if (stage === 'delivered') {
    const missed = card.offers.filter((o) => !o.delivered)
    return (
      <>
        <Sec>
          <KV
            rows={[
              ['Delivered', `${card.delivered} of ${offers} (${rate(card.delivered, offers)})`],
              ['Not delivered', `${missed.length}: the session ended before a second prompt`],
            ]}
          />
        </Sec>
        <Sec title="Latest delivered">
          <OfferRows offers={card.offers.filter((o) => o.delivered).slice(0, 10)} />
        </Sec>
      </>
    )
  }
  const hits = card.offers.filter((o) => o.readTitles.length > 0)
  return (
    <>
      <Sec>
        <KV
          rows={[
            ['Sessions that read', `${card.readSessions} of ${card.delivered} delivered (${rate(card.readSessions, card.delivered)})`],
            ['Read status unknown', `${uncheckable(card.offers).length} (transcript pruned from disk or unparseable)`],
          ]}
        />
      </Sec>
      <Sec title="Reads">
        {hits.length > 0 ? <OfferRows offers={hits.slice(0, 12)} /> : <p className="sub">No offered note has been opened yet.</p>}
      </Sec>
    </>
  )
}

function NotePreview({ title }: { title: string }) {
  const note = useNotePreview(title)
  if (note.status === 'loading') return <Loading rows={3} />
  if (note.status === 'error') return <Unreachable what="the vault" error={note.error} onRetry={note.retry} />
  if (note.status === 'missing')
    return <p className="sub">No vault note has this title any more; it may have been renamed or merged since it was offered.</p>
  return (
    <>
      <MarkdownLite
        source={note.text}
        className="peek-recall-preview"
        fallback={<p className="peek-recall-preview peek-recall-plain">{note.text}</p>}
      />
      {note.truncated && <span className="sub">Preview cut short; the full note is in Notes.</span>}
    </>
  )
}

function NoteOpen({ title }: { title: string }) {
  const note = useNotePreview(title)
  const navigate = useNavigate()
  return (
    <Btn
      kind="primary"
      disabled={note.status !== 'data'}
      title={note.status === 'missing' ? 'No vault note has this title' : undefined}
      onClick={() => note.status === 'data' && navigate('knowledge', note.id)}
    >
      Open in Notes
    </Btn>
  )
}

function Note({ title, stat }: { title: string; stat: NoteStat | undefined }) {
  if (!stat)
    return (
      <Sec>
        <p className="sub">The scorecard has no offer of this note.</p>
      </Sec>
    )
  const unknown = unknownReads(stat)
  const rows: [ReactNode, ReactNode][] = [
    ['Offered', plural(stat.offered, 'time')],
    ['Reached a session', stat.delivered],
    ['Opened', stat.read],
    ['Seen, not opened', stat.unread],
  ]
  if (unknown > 0) rows.push(['Unknown', `${unknown} (transcript pruned from disk or unparseable)`])
  rows.push(['Projects', stat.projects.join(', ') || '—'])
  rows.push(['Offered on', stat.dates.map(shortDate).join(', ')])
  return (
    <>
      <Sec>
        <h4 className="peek-recall-h">{title}</h4>
        <KV rows={rows} />
      </Sec>
      {stat.read === 0 && stat.delivered > 0 && (
        <Sec title="Why this happens">
          <p className="sub">
            Recall matches the session’s task against note titles only, so a broad title can match many prompts without
            being what the session needs. A sharper title makes it match less often and more usefully.
          </p>
        </Sec>
      )}
    </>
  )
}

export function RecallDetail({ ctx }: DetailProps) {
  const read = useRecallRead()
  const navigate = useNavigate()
  const card = read.status === 'data' ? read.data : null
  const stats = useMemo(() => (card ? noteStats(card.offers) : []), [card])
  const noteTitle = typeof ctx?.note === 'string' ? ctx.note : null
  const stage = typeof ctx?.stage === 'string' && ctx.stage in STAGE_TITLE ? (ctx.stage as StageKey) : null

  const title = noteTitle ? 'Offered note' : stage ? STAGE_TITLE[stage] : 'Vault recall'
  let body: ReactNode
  if (read.status === 'loading') body = <Loading rows={5} />
  else if (read.status === 'error')
    body = <Unreachable what="the recall scorecard" error={read.error} onRetry={read.refresh} />
  else if (!read.data.since) body = <Empty title="Recall hasn’t fired yet">No prompt has been checked against the vault.</Empty>
  else if (noteTitle) body = <Note title={noteTitle} stat={stats.find((s) => s.title === noteTitle)} />
  else if (stage) body = <Stage stage={stage} card={read.data} />
  else body = <Overview card={read.data} stats={stats} />

  return (
    <PeekContent crumb="Vault recall" title={title}>
      {body}
      {noteTitle && (
        <Sec title="Note">
          <NotePreview title={noteTitle} />
        </Sec>
      )}
      <Sec bare>
        <Actions>
          {noteTitle ? (
            <NoteOpen title={noteTitle} />
          ) : (
            <Btn kind="primary" onClick={() => navigate('knowledge')}>
              Open Notes
            </Btn>
          )}
          {(noteTitle || stage) && <Btn onClick={() => navigate('knowledge')}>Full scorecard in Notes</Btn>}
        </Actions>
      </Sec>
    </PeekContent>
  )
}
