import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseWorkflowFile,
  buildWorkflowDeepLink,
  buildWorkflowExplainDeepLink,
  buildWorkflowAuthorDeepLink,
} from './workflows.ts'

// A trimmed-but-faithful copy of .claude/workflows/review-changes.js — the
// real workflow the surface must render. Notably it has ZERO phase() calls:
// phases come from meta and are wired to agents via the `phase:` opt.
const REVIEW_CHANGES = `export const meta = {
  name: 'review-changes',
  description: 'Review a claude-hub diff across dimensions, adversarially verify findings',
  whenToUse:
    'Before calling a nontrivial claude-hub change done. Reviews the working diff by default; pass {range: "<git range>"}.',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const ROOT = 'C:/projects/claude-hub'
const diffStat = await agent(
  \`Run: git -C \${ROOT} diff --stat. Return empty=true if nothing to review.\`,
  { label: 'diff-stat', effort: 'low', schema: { type: 'object', properties: { empty: { type: 'boolean' } } } },
)
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { label: \`review:\${d.key}\`, phase: 'Review', schema: FINDINGS_SCHEMA }),
  async (review, d) => {
    const verified = await parallel(
      (review?.findings ?? []).map((f) => () =>
        agent(\`Adversarially verify \${f.summary}\`, { label: \`verify:\${f.file}\`, phase: 'Verify', schema: VERDICT_SCHEMA }),
      ),
    )
    return { dimension: d.key, findings: verified.filter(Boolean) }
  },
)
`

test('parseWorkflowFile extracts the meta block', () => {
  const { meta } = parseWorkflowFile(REVIEW_CHANGES)
  assert.equal(meta?.name, 'review-changes')
  assert.equal(meta?.description, 'Review a claude-hub diff across dimensions, adversarially verify findings')
  assert.match(meta?.whenToUse ?? '', /working diff by default/)
  assert.deepEqual(
    meta?.phases?.map((p) => p.title),
    ['Review', 'Verify'],
  )
})

test('parseWorkflowFile finds all three agent call sites', () => {
  const { composition } = parseWorkflowFile(REVIEW_CHANGES)
  assert.equal(composition.agentCount, 3)
})

test('parseWorkflowFile maps agents to phases via the phase: opt', () => {
  const { composition } = parseWorkflowFile(REVIEW_CHANGES)
  const review = composition.phases.find((p) => p.title === 'Review')
  const verify = composition.phases.find((p) => p.title === 'Verify')
  assert.equal(review?.steps.length, 1)
  assert.equal(review?.steps[0].label, 'review:${d.key}')
  assert.equal(review?.steps[0].structured, true)
  assert.equal(verify?.steps.length, 1)
  assert.equal(verify?.steps[0].label, 'verify:${f.file}')
})

test('parseWorkflowFile leaves an unphased agent unphased and reads its opts', () => {
  const { composition } = parseWorkflowFile(REVIEW_CHANGES)
  assert.equal(composition.unphasedSteps.length, 1)
  const diffStat = composition.unphasedSteps[0]
  assert.equal(diffStat.label, 'diff-stat')
  assert.equal(diffStat.effort, 'low')
  // schema is present even though it's an inline nested object literal.
  assert.equal(diffStat.structured, true)
})

test('parseWorkflowFile extracts literal prompts and leaves computed ones null', () => {
  const { composition } = parseWorkflowFile(REVIEW_CHANGES)
  // diffStat's prompt is a template literal — unwrapped, ${...} kept verbatim.
  assert.equal(
    composition.unphasedSteps[0].prompt,
    'Run: git -C ${ROOT} diff --stat. Return empty=true if nothing to review.',
  )
  // Review step is agent(d.prompt, ...) — a computed expression, not knowable.
  const review = composition.phases.find((p) => p.title === 'Review')
  assert.equal(review?.steps[0].prompt, null)
  // Verify step is a template literal even though it's nested in .map().
  const verify = composition.phases.find((p) => p.title === 'Verify')
  assert.equal(verify?.steps[0].prompt, 'Adversarially verify ${f.summary}')
})

test('parseWorkflowFile detects arg keys read off args and an alias, and passes meta.example through', () => {
  const src = `export const meta = { name: 'x', example: 'run /x {task: "foo"}' }
const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const TASK = (ARGS && ARGS.task) || 'default'
const scope = args.scope
await agent('go')
`
  const { meta, composition } = parseWorkflowFile(src)
  assert.equal(meta?.example, 'run /x {task: "foo"}')
  // args.scope (direct) + ARGS.task (alias assigned from args) — JSON.parse(args)/typeof args are bare, no key.
  assert.deepEqual(composition.args.sort(), ['scope', 'task'])
})

test('parseWorkflowFile reports no args for a workflow that never reads args', () => {
  const { composition } = parseWorkflowFile(REVIEW_CHANGES)
  assert.deepEqual(composition.args, [])
})

test('buildWorkflowExplainDeepLink encodes cwd, name and script path into an explain prompt', () => {
  const url = buildWorkflowExplainDeepLink('C:\\p', 'parallel-build', 'C:\\p\\.claude\\workflows\\parallel-build.js')
  assert.ok(url.startsWith('claude-cli://open?cwd=C%3A%5Cp&q='), 'cwd encoded')
  assert.ok(!/ /.test(url), 'no literal spaces')
  assert.ok(!/\\/.test(url), 'no literal backslashes')
  const q = decodeURIComponent(url.split('&q=')[1])
  assert.match(q, /Read the workflow script at C:\\p\\\.claude\\workflows\\parallel-build\.js/)
  assert.match(q, /\/parallel-build/)
})

test('buildWorkflowAuthorDeepLink encodes cwd + script path + instruction with nothing hitting a shell', () => {
  const url = buildWorkflowAuthorDeepLink('C:\\p', 'C:\\p\\.claude\\workflows\\x.js', 'adapt it to: review a11y & perf.')
  assert.ok(url.startsWith('claude-cli://open?cwd=C%3A%5Cp&q='), 'cwd encoded')
  assert.ok(!/ /.test(url), 'no literal spaces')
  assert.ok(!/\\/.test(url), 'no literal backslashes')
  assert.ok(url.includes('%26'), 'ampersand in the instruction is encoded, not passed through')
  const q = decodeURIComponent(url.split('&q=')[1])
  assert.match(q, /Open the workflow script at C:\\p\\\.claude\\workflows\\x\.js/)
  assert.match(q, /adapt it to: review a11y & perf\./)
})

test('parseWorkflowFile detects orchestration shape and dynamic fan-out', () => {
  const { composition } = parseWorkflowFile(REVIEW_CHANGES)
  assert.equal(composition.orchestration.usesPipeline, true)
  assert.equal(composition.orchestration.usesParallel, true)
  assert.equal(composition.orchestration.usesLoop, false)
  assert.equal(composition.orchestration.callsSubWorkflow, false)
  // pipeline/parallel over .map() → real agent count exceeds the 3 call sites.
  assert.equal(composition.dynamic, true)
})

test('parseWorkflowFile keeps declared meta phases even with no phase() calls', () => {
  const { composition } = parseWorkflowFile(REVIEW_CHANGES)
  assert.deepEqual(
    composition.phases.map((p) => p.title),
    ['Review', 'Verify'],
  )
})

test('parseWorkflowFile reports a parse error for a missing meta block', () => {
  const { meta, composition } = parseWorkflowFile('const x = 1\nawait agent("hi")\n')
  assert.equal(meta, null)
  assert.equal(composition.agentCount, 1)
})

test('buildWorkflowDeepLink encodes cwd and a Run /name prompt', () => {
  const url = buildWorkflowDeepLink('C:\\projects\\claude-hub', 'review-changes', '')
  assert.equal(url, 'claude-cli://open?cwd=C%3A%5Cprojects%5Cclaude-hub&q=Run%20%2Freview-changes')
})

test('buildWorkflowDeepLink appends trimmed args into the prompt', () => {
  const url = buildWorkflowDeepLink('C:\\p', 'review-changes', '  HEAD~2..HEAD  ')
  // args trimmed; ~ . - stay literal under encodeURIComponent, space→%20, /→%2F
  assert.equal(url, 'claude-cli://open?cwd=C%3A%5Cp&q=Run%20%2Freview-changes%20HEAD~2..HEAD')
})

test('buildWorkflowDeepLink keeps variable content off any shell — no raw spaces or backslashes in the URL', () => {
  const url = buildWorkflowDeepLink('C:\\Program Files\\proj', 'x', 'a & b | c')
  assert.ok(!/ /.test(url), 'no literal spaces')
  assert.ok(!/\\/.test(url), 'no literal backslashes')
  // shell metacharacters in args are percent-encoded, not passed through
  assert.ok(url.includes('%26'), '& encoded')
  assert.ok(url.includes('%7C'), '| encoded')
})

test('parseWorkflowFile detects a loop and a sub-workflow call', () => {
  const src = `export const meta = { name: 'x', phases: [{ title: 'A' }] }
for (const b of bugs) {
  phase('A')
  await agent('find', { model: 'sonnet', isolation: 'worktree' })
}
await workflow('other-flow')
`
  const { composition } = parseWorkflowFile(src)
  assert.equal(composition.orchestration.usesLoop, true)
  assert.equal(composition.orchestration.callsSubWorkflow, true)
  assert.equal(composition.dynamic, true)
  const a = composition.phases.find((p) => p.title === 'A')
  assert.equal(a?.steps[0].model, 'sonnet')
  assert.equal(a?.steps[0].worktree, true)
})
