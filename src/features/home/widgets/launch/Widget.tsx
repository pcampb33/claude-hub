import { useMemo } from 'react'
import { useWidgetMeta } from '../../frame-context'
import { usePeekTarget } from '../../peek-context'
import { useWorkflowsRead } from '../../reads'
import { Loading, Unreachable } from '../../parts'
import type { WidgetProps, WidgetSize } from '../../types'
import { recentWorkflows } from './launch'
import { useRankedSkills } from './builtin'
import './launch.css'

const SKILL_CHIPS: Record<WidgetSize, number> = { S: 5, M: 8, L: 12, XL: 16 }
const WORKFLOW_CHIPS: Record<WidgetSize, number> = { S: 2, M: 3, L: 4, XL: 6 }

export function LaunchWidget({ size }: WidgetProps) {
  const { usage, launchable } = useRankedSkills()
  const workflows = useWorkflowsRead()
  const peekTarget = usePeekTarget()
  const flows = useMemo(() => (workflows.status === 'data' ? recentWorkflows(workflows.data) : []), [workflows.status, workflows.data])
  useWidgetMeta(usage.status === 'data' ? 'last 30 days' : null)

  return (
    <div className="launch-w">
      <div className="launch-group">
        <span className="sub">Skills, by uses</span>
        {usage.status === 'loading' ? (
          <Loading rows={2} />
        ) : usage.status === 'error' ? (
          <Unreachable what="skill usage" error={usage.error} onRetry={usage.refresh} />
        ) : launchable.length === 0 ? (
          <span className="launch-none">No skill invoked in the last 30 days.</span>
        ) : (
          <div className="launch-chips">
            {launchable.slice(0, SKILL_CHIPS[size]).map((s) => (
              <span key={s.name} className="launch-chip" {...peekTarget('launch', { cmd: `/${s.name}` }, `/${s.name}, ${s.uses30} uses in 30 days`)}>
                /{s.name}
                <small>{s.uses30}×</small>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="launch-group">
        <span className="sub">Workflows, recently edited</span>
        {workflows.status === 'loading' ? (
          <Loading rows={1} />
        ) : workflows.status === 'error' ? (
          <Unreachable what="workflows" error={workflows.error} onRetry={workflows.refresh} />
        ) : flows.length === 0 ? (
          <span className="launch-none">No workflows in ~/.claude or any project.</span>
        ) : (
          <div className="launch-chips">
            {flows.slice(0, WORKFLOW_CHIPS[size]).map((w) => (
              <span key={w.id} className="launch-chip launch-chip-wf" {...peekTarget('launch', { workflow: w.id }, `Workflow ${w.name}`)}>
                {w.name}
                <small>{w.projectName}</small>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
