export const meta = {
  name: 'review-changes',
  description: 'Review a claude-hub diff across dimensions, adversarially verify findings',
  whenToUse:
    'Before calling a nontrivial claude-hub change done. Reviews the working diff by default; pass {range: "<git range>"} (e.g. "HEAD~2..HEAD") to review commits instead.',
  example:
    'You just finished a multi-file change and lint/typecheck/test pass. Run /review-changes to review the uncommitted working diff, or /review-changes {range: "HEAD~2..HEAD"} to review the last two commits instead. It fans out correctness / project-contract / verification reviewers over the diff, then adversarially re-checks each finding (default stance: the finding is wrong) so only findings that survive refutation are reported.',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const ROOT = 'C:/projects/claude-hub'
// args can arrive as a JSON string instead of an object (confirmed by this
// script's own 2026-07-02 run, where {range} silently fell back to HEAD).
const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const TARGET = (ARGS && ARGS.range) || 'HEAD'

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'summary', 'failureScenario'],
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string' },
          failureScenario: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['isReal', 'reasoning'],
  properties: { isReal: { type: 'boolean' }, reasoning: { type: 'string' } },
}

const CONTEXT = `Work in ${ROOT} (claude-hub: an Electron + Vite + React + TS desktop app; read its CLAUDE.md first). Examine the diff with: git -C ${ROOT} diff ${TARGET} (add git -C ${ROOT} status --short for untracked files when reviewing the working tree). Read surrounding source as needed. Report ONLY findings in the changed code — no style nits, no pre-existing issues.`

const DIMENSIONS = [
  {
    key: 'correctness',
    prompt: `${CONTEXT}\nDimension: correctness. Find real bugs in the diff: logic errors, unhandled edge cases, React pitfalls (stale closures, missing effect deps, key misuse, state updates on unmounted components), broken CSS assumptions (overflow, contrast regressions), wrong IPC usage.`,
  },
  {
    key: 'contract',
    prompt: `${CONTEXT}\nDimension: project-contract conformance. claude-hub's load-bearing conventions: logic that runs headless or in the main process lives in Electron-free *-core.ts modules with colocated *.test.ts; IPC stays typed through shared/ipc-types.ts; feature slices under src/features stay self-contained; scripts/ stay thin I/O wrappers over tested core modules. Report violations with the convention named.`,
  },
  {
    key: 'verification',
    prompt: `${CONTEXT}\nDimension: verification. From ${ROOT} run: npm run lint, npm run typecheck, npm test. All green with the diff applied? Does changed logic need coverage it doesn't have (new or changed *-core.ts behavior without a test)? Report failures and untested load-bearing changes.`,
  },
]

// Empty-diff guard (same run's other confirmed finding): a zero-line diff
// makes every reviewer report "no findings", which reads as a clean verdict
// for a change that was never examined. Refuse to review nothing.
const diffStat = await agent(
  `Run: git -C ${ROOT} diff --stat ${TARGET}${TARGET === 'HEAD' ? ` and git -C ${ROOT} status --short` : ''}. Return empty=true only if there are zero changed lines (and, for HEAD, no untracked files) — i.e. nothing to review. stat = the raw output.`,
  { label: 'diff-stat', effort: 'low', schema: { type: 'object', required: ['empty', 'stat'], properties: { empty: { type: 'boolean' }, stat: { type: 'string' } } } },
)
if (diffStat && diffStat.empty) {
  log(`empty diff for ${TARGET} — nothing was reviewed`)
  return { confirmed: [], unverified: [], deadDimensions: [], emptyDiff: `no changes in ${TARGET} — nothing was reviewed; check the range` }
}

const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA }),
  async (review, d) => {
    const verified = await parallel(
      (review?.findings ?? []).map((f) => () =>
        agent(
          `Adversarially verify this ${d.key} finding about the diff (${TARGET}) in ${ROOT} — your default stance is that it is WRONG; try to refute it by reading the actual code and, for verification findings, running the checks yourself.\nFinding: ${f.summary}\nFile: ${f.file}${f.line ? ':' + f.line : ''}\nClaimed failure: ${f.failureScenario}\nReturn isReal=true only if you could not refute it.`,
          { label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA },
        ).then((v) => ({ ...f, dimension: d.key, verdict: v })),
      ),
    )
    return { dimension: d.key, reviewRan: review != null, findings: verified.filter(Boolean) }
  },
)

// Fail closed (confirmed finding from this script's first real run in
// skyrim-agent): agent() resolves null when a subagent dies — a null
// verdict means UNVERIFIED, not refuted, and a dead dimension reviewer
// means that dimension never ran. Surface both instead of silently
// folding them into "clean".
const dims = results.filter(Boolean)
const deadDimensions = DIMENSIONS.map((d) => d.key).filter(
  (k) => !dims.some((r) => r.dimension === k && r.reviewRan),
)
const findings = dims.flatMap((r) => r.findings)
const confirmed = findings.filter((f) => f.verdict && f.verdict.isReal)
const unverified = findings.filter((f) => !f.verdict)
log(
  `${confirmed.length} confirmed, ${unverified.length} unverified, ${deadDimensions.length} dead dimension(s)`,
)
return { confirmed, unverified, deadDimensions }
