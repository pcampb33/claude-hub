import type { RecallScorecard } from '../../../../../shared/ipc-types'
import { usePeekTarget } from '../../peek-context'
import { funnelStages } from './recall'
import './recall.css'

// attempts → offers → delivered → read as single-hue bars scaled to attempts,
// with the number beside each. Each stage opens its own peek.
export function Funnel({ scorecard }: { scorecard: RecallScorecard }) {
  const peekTarget = usePeekTarget()
  const stages = funnelStages(scorecard)
  const max = Math.max(1, stages[0].value)
  return (
    <div className="recall-funnel">
      {stages.map((s) => (
        <div key={s.key} className="recall-stage" {...peekTarget('recall', { stage: s.key }, `${s.label}: ${s.value}`)}>
          <span className="recall-stage-label">{s.label}</span>
          <span className="recall-bar">
            <i style={{ width: `${(s.value / max) * 100}%` }} />
          </span>
          <b>{s.value}</b>
        </div>
      ))}
    </div>
  )
}
