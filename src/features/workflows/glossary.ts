// Plain-English definitions of the shape/badge labels the workflows UI shows.
// Single source of truth for both the chip tooltips (via GLOSSARY) and the
// "What do the labels mean?" legend (via GLOSSARY_GROUPS). When the parser
// (electron/workflows.ts) learns a new orchestration shape or per-agent badge,
// add its term here so the legend stays complete.

export interface GlossaryTerm {
  term: string // lookup key, also the `title` tooltip on the matching chip
  label: string // how it reads in the legend
  def: string
}

export const GLOSSARY_GROUPS: { title: string; terms: GlossaryTerm[] }[] = [
  {
    title: 'Orchestration shape',
    terms: [
      {
        term: 'pipeline',
        label: 'pipeline',
        def: 'Items flow through stages independently — one item can be at a later stage while others are still early. “Do X then Y then Z to each of these.”',
      },
      {
        term: 'parallel',
        label: 'parallel',
        def: 'Several agents run at once; the workflow waits for all of them before continuing. “Do these N independent things, then combine.”',
      },
      {
        term: 'loop',
        label: 'loop',
        def: 'The workflow repeats agents (a for/while) — e.g. keep going until a round turns up nothing new.',
      },
      {
        term: 'sub-workflow',
        label: 'sub-workflow',
        def: 'This workflow runs another whole workflow as one of its steps.',
      },
    ],
  },
  {
    title: 'Scale',
    terms: [
      {
        term: 'agent',
        label: 'N agents',
        def: 'One AI subagent doing one task. The count is how many distinct agent steps the workflow declares.',
      },
      {
        term: 'dynamic',
        label: '+ (dynamic fan-out)',
        def: 'The real number of agents is higher than shown — they’re spawned in a loop or over a list whose size isn’t known until the workflow runs.',
      },
    ],
  },
  {
    title: 'Where it lives',
    terms: [
      {
        term: 'source-project',
        label: '.claude/workflows',
        def: 'A project-local workflow — it lives in that project’s .claude/workflows/ folder and is scoped to it.',
      },
      {
        term: 'source-global',
        label: 'global',
        def: 'A workflow in your home ~/.claude/workflows/ folder, available across every project.',
      },
    ],
  },
  {
    title: 'Per-agent options',
    terms: [
      {
        term: 'model',
        label: 'model (haiku / sonnet / opus)',
        def: 'Which model this agent uses — trading speed and cost for capability.',
      },
      { term: 'effort', label: 'effort (low → high)', def: 'How much reasoning effort this agent spends on its task.' },
      {
        term: 'structured',
        label: 'structured',
        def: 'This agent must return data matching a schema (JSON), not free-form text.',
      },
      {
        term: 'worktree',
        label: 'worktree',
        def: 'This agent runs in its own isolated git checkout, so parallel file edits don’t collide.',
      },
      { term: 'agentType', label: 'agentType', def: 'A specialized agent persona/config instead of the default.' },
      {
        term: 'computed-prompt',
        label: 'prompt built at runtime',
        def: 'This step’s prompt is assembled from code when the workflow runs (e.g. from a list of items), so there’s no fixed text to show here.',
      },
    ],
  },
]

// Flat term → definition map for chip `title` tooltips.
export const GLOSSARY: Record<string, string> = Object.fromEntries(
  GLOSSARY_GROUPS.flatMap((g) => g.terms.map((t) => [t.term, t.def])),
)
