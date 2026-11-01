import { useMemo } from 'react'
import { useWidgetMeta } from '../../frame-context'
import { usePeekTarget } from '../../peek-context'
import { useRecallRead } from '../../reads'
import { Empty, Loading, Row, RowList, Unreachable } from '../../parts'
import type { WidgetProps } from '../../types'
import { neverRead, neverReadFigure, noteStats, shortDate } from './recall'
import { Funnel } from './Funnel'
import './recall.css'

export function RecallWidget({ size }: WidgetProps) {
  const read = useRecallRead()
  const peekTarget = usePeekTarget()
  const card = read.status === 'data' ? read.data : null
  const never = useMemo(() => (card ? neverRead(noteStats(card.offers)) : []), [card])
  useWidgetMeta(card?.since ? `$${card.spendUsd.toFixed(2)} since ${shortDate(card.since)}` : null)

  if (read.status === 'loading') return <Loading rows={4} />
  if (read.status === 'error') return <Unreachable what="the recall scorecard" error={read.error} onRetry={read.refresh} />
  if (!read.data.since) return <Empty title="Recall hasn’t fired yet">No prompt has been checked against the vault.</Empty>

  const top = never[0]
  return (
    <div className="recall-w">
      <Funnel scorecard={read.data} />
      {size === 'S' ? (
        top && (
          <p className="recall-quote" {...peekTarget('recall', { note: top.title }, `${top.title}: offered, no read found`)}>
            Offered {top.offered}×, no read found
            <b>{top.title}</b>
          </p>
        )
      ) : never.length > 0 ? (
        <div className="recall-never">
          <span className="sub">Offered most, no read found</span>
          <RowList>
            {never.slice(0, size === 'L' ? 5 : 3).map((s) => (
              <Row
                key={s.title}
                label={s.title}
                figure={neverReadFigure(s)}
                target={peekTarget('recall', { note: s.title }, `${s.title}: offered, no read found`)}
              />
            ))}
          </RowList>
        </div>
      ) : null}
    </div>
  )
}
