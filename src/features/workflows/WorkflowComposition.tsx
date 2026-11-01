import { GLOSSARY } from './glossary'
import type { WorkflowComposition, WorkflowStep } from '../../../shared/ipc-types'

// The always-visible "Structure" rail in the detail's right column: the
// *declared* phase → agent map of a workflow at a glance. Each phase gets a
// dot on the rail; each agent a chip with its model/effort/structured/worktree
// tags and a 2-line-clamped prompt teaser (full prompts live in View source).
// Not a runtime trace — dynamic fan-out (loops / .map) is flagged, not
// enumerated.

function RailStep({ step }: { step: WorkflowStep }) {
  return (
    <div className="wf-agent-node">
      <div className="wf-agent-head">
        <span className="wf-agent-label">{step.label ?? 'agent'}</span>
        {step.model && (
          <span className="wf-tag" title={GLOSSARY.model}>
            {step.model}
          </span>
        )}
        {step.effort && (
          <span className="wf-tag" title={GLOSSARY.effort}>
            {step.effort}
          </span>
        )}
        {step.agentType && (
          <span className="wf-tag" title={GLOSSARY.agentType}>
            {step.agentType}
          </span>
        )}
        {step.structured && (
          <span className="wf-tag wf-tag-accent" title={GLOSSARY.structured}>
            structured
          </span>
        )}
        {step.worktree && (
          <span className="wf-tag wf-tag-accent" title={GLOSSARY.worktree}>
            worktree
          </span>
        )}
      </div>
      {step.prompt ? (
        <div className="wf-agent-prompt">{step.prompt}</div>
      ) : (
        <div className="wf-agent-prompt wf-agent-prompt-computed" title={GLOSSARY['computed-prompt']}>
          prompt built at runtime
        </div>
      )}
    </div>
  )
}

export function WorkflowStructureRail({ composition }: { composition: WorkflowComposition }) {
  const { phases, unphasedSteps, orchestration, agentCount, dynamic } = composition
  const shape: string[] = []
  if (orchestration.usesPipeline) shape.push('pipeline')
  if (orchestration.usesParallel) shape.push('parallel')
  if (orchestration.usesLoop) shape.push('loop')
  if (orchestration.callsSubWorkflow) shape.push('sub-workflow')
  const summary = `${agentCount} agent${agentCount === 1 ? '' : 's'}${dynamic ? '+' : ''} · ${
    shape.length ? shape.join(' · ') : 'sequential'
  }`

  return (
    <>
      <div className="wf-structure-head">
        <span className="wf-structure-label">Structure</span>
        <span className="wf-structure-sum">{summary}</span>
      </div>

      {phases.map((phase) => (
        <div key={phase.title} className="wf-phase-node">
          <div className="wf-phase-node-title" title={phase.detail ?? undefined}>
            {phase.title}
          </div>
          {phase.steps.length > 0 ? (
            phase.steps.map((step, i) => <RailStep key={`${step.label}-${i}`} step={step} />)
          ) : (
            <div className="wf-phase-node-empty">no statically-mapped agents</div>
          )}
        </div>
      ))}

      {unphasedSteps.length > 0 && (
        <div className="wf-phase-node">
          <div className="wf-phase-node-title wf-phase-node-muted">Unphased</div>
          {unphasedSteps.map((step, i) => (
            <RailStep key={`unphased-${i}`} step={step} />
          ))}
        </div>
      )}

      {phases.length === 0 && unphasedSteps.length === 0 && (
        <div className="wf-phase-node-empty">no agent structure detected</div>
      )}
    </>
  )
}
