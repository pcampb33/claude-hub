export const meta = {
  name: 'parallel-build',
  description: 'Research→plan fan-out for a substantial, file-separable build: parallel research on distinct lenses, then one synthesis pass into a disjoint-file implementation plan',
  whenToUse:
    'At the START of substantial file-separable work (a feature, redesign, or migration — roughly >3 files). Pass {task: "<what to build>"}. Produces the plan; the worktree-implement → adversarial-review → real-app-verify → polish phases stay separate, human-gated runs (they need judgment this workflow deliberately does not automate).',
  example:
    'You want to add a "cross-project search" feature touching the parser, IPC contract, and several UI files. Run /parallel-build {task: "add cross-project session search"} — four research agents (prior art, techniques, invariants, codebase audit) run in parallel, then one synthesis pass folds them into a disjoint-file plan (a shared foundation + one file-set per owner, each with its own verify command) you review before any code is written.',
  phases: [
    { title: 'Research', detail: 'parallel agents, one per lens — correct false premises before building', model: 'sonnet' },
    { title: 'Synthesize', detail: 'one pass folds the briefs into a disjoint-file plan', model: 'opus' },
  ],
}

// args can arrive as a JSON string instead of an object (same gotcha
// review-changes.js hit on its 2026-07-02 run).
const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const TASK = (ARGS && ARGS.task) || 'the task described in the current session'

// The four lenses from the Multi-agent build playbook. Researching these
// first is where the playbook overturned two false premises on the hybrid-UI
// redesign — the point of this phase is to be wrong on paper, not in code.
const LENSES = [
  { key: 'reference', angle: 'Find prior art and existing in-repo patterns to imitate. What already solves part of this? What conventions must a new solution match?' },
  { key: 'technique', angle: 'Survey concrete techniques/APIs/libraries for the hard parts. Note signatures, gotchas, and version constraints.' },
  { key: 'principle', angle: 'Name the design principles and invariants that must hold. What would make this correct vs. merely working?' },
  { key: 'codebase-audit', angle: 'Audit the actual codebase for how this slots in: files touched, seams, hidden coupling, and any premise the task assumes that the code contradicts.' },
]

const RESEARCH_SCHEMA = {
  type: 'object',
  required: ['findings', 'falsePremises'],
  properties: {
    findings: { type: 'array', items: { type: 'string' } },
    falsePremises: { type: 'array', items: { type: 'string' } },
    filesOfInterest: { type: 'array', items: { type: 'string' } },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['fileSets', 'foundation', 'risks'],
  properties: {
    foundation: { type: 'string' },
    fileSets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['owner', 'files', 'goal', 'verify'],
        properties: {
          owner: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          goal: { type: 'string' },
          verify: { type: 'string' },
        },
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

phase('Research')
const briefs = await parallel(
  LENSES.map((lens) => () =>
    agent(
      `Research lens "${lens.key}" for this build task: ${TASK}\n${lens.angle}\nBe concrete and cite files/APIs. Flag any premise in the task that the codebase or reality contradicts — those go in falsePremises.`,
      { label: `research:${lens.key}`, phase: 'Research', model: 'sonnet', schema: RESEARCH_SCHEMA },
    ),
  ),
)

const paired = LENSES.map((lens, i) => ({ lens, brief: briefs[i] }))
const usable = paired.filter((p) => p.brief)
const dead = paired.filter((p) => !p.brief).map((p) => p.lens.key)
log(`${usable.length}/${LENSES.length} research lenses returned${dead.length ? ` (dead: ${dead.join(', ')})` : ''}`)

phase('Synthesize')
const digest = usable
  .map((p) => `## ${p.lens.key}\nfindings: ${p.brief.findings.join('; ')}\nfalse premises: ${p.brief.falsePremises.join('; ') || 'none'}`)
  .join('\n\n')

const plan = await agent(
  `Synthesize a build plan for: ${TASK}\n\nResearch briefs:\n${digest}\n\nProduce: (1) a foundation step — the shared primitives/types/tokens one agent lays and commits FIRST so parallel work branches from a shared vocabulary; (2) fileSets that are DISJOINT (no two owners touch the same file — that is what makes the later worktree merges conflict-free), each with a one-line goal and its own verify command; (3) the risks and any false premises that survived research.`,
  { label: 'synthesize-plan', phase: 'Synthesize', model: 'opus', effort: 'high', schema: PLAN_SCHEMA },
)

return { task: TASK, plan, deadLenses: dead }
