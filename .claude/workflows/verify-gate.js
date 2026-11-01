export const meta = {
  name: 'verify-gate',
  description:
    'Definition-of-done gate for a claude-hub change: floor (lint+typecheck+test) → drive the affected flow in the real app → an evidence-backed done / not-done verdict',
  whenToUse: `Before calling a nontrivial claude-hub change done. Pass {change: "<what you changed>"} to focus the drive; defaults to the working tree. Runs the floor FIRST and short-circuits to NOT DONE if it is red, so you never "verify" a change that does not compile. Complements /review-changes (which reads the diff) by actually exercising the change.`,
  example: `You just wired a new IPC channel and its UI. Run /verify-gate {change: "sandbox queue-to-inbox button"} — it runs npm run lint / typecheck / test, and only if all three are green does it build the app and drive the sandbox view (scripts/screenshot-app.mjs launches the REAL built Electron app against real data) to observe the button actually queuing a note, then returns done / not-done with the floor output and screenshot paths as evidence.`,
  phases: [{ title: 'Floor' }, { title: 'Drive' }, { title: 'Verdict' }],
}

const ROOT = 'C:/projects/claude-hub'
// args can arrive as a JSON string instead of an object (confirmed gotcha in
// review-changes.js / parallel-build.js — {range}/{task} silently fell back).
const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const CHANGE = (ARGS && ARGS.change) || 'the current uncommitted working-tree changes'

const FLOOR_SCHEMA = {
  type: 'object',
  required: ['passed', 'output'],
  properties: {
    passed: { type: 'boolean' },
    output: { type: 'string' },
    failedCommand: { type: 'string' },
  },
}

const DRIVE_SCHEMA = {
  type: 'object',
  required: ['behaved', 'droveWhat', 'evidence'],
  properties: {
    behaved: { type: 'boolean' },
    droveWhat: { type: 'string' },
    evidence: { type: 'string' },
    artifacts: { type: 'array', items: { type: 'string' } },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['done', 'reasoning'],
  properties: {
    done: { type: 'boolean' },
    reasoning: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
}

// Phase 1 — the floor. claude-hub's CLAUDE.md contract is "not done until
// green" = lint + typecheck + test all exit 0. It is a deterministic gate, so
// run it first: a red floor short-circuits before the expensive drive phase.
phase('Floor')
const floor = await agent(
  `From ${ROOT}, run the project floor exactly, in order: npm run lint, then npm run typecheck, then npm test. Set passed=true ONLY if all three exit 0. On failure, set failedCommand to the first that failed and put its relevant failing output (not the whole log) in output. On success, output is a one-line summary such as the passing test count.`,
  { label: 'floor', phase: 'Floor', schema: FLOOR_SCHEMA },
)

// Fail closed: a dead floor agent (null) is UNVERIFIED, never a pass — same
// lesson review-changes.js learned when a subagent died (null != clean).
if (!floor) {
  log('floor agent died — the floor could not be confirmed; treating as NOT DONE')
  return {
    done: false,
    floor: null,
    drive: null,
    verdict: {
      done: false,
      reasoning: 'The floor check did not run to completion, so the change is unverified.',
      blockers: ['floor check did not complete'],
    },
  }
}
if (!floor.passed) {
  log(`floor RED (${floor.failedCommand || 'unknown command'}) — short-circuiting; drive skipped`)
  return {
    done: false,
    floor,
    drive: null,
    verdict: {
      done: false,
      reasoning: `The floor is red: ${floor.failedCommand || 'a check'} failed. Fix it before driving the app.`,
      blockers: [floor.failedCommand || 'floor check failed'],
    },
  }
}
log('floor GREEN — driving the affected flow in the real app')

// Phase 2 — drive the real app. The floor proves it compiles and units pass;
// this proves the CHANGE actually behaves. Prefer the real-Electron harness
// (scripts/screenshot-app.mjs launches the built app against real data) for
// UI/IPC surfaces; exercise Electron-free *-core.ts changes directly via node.
phase('Drive')
const drive = await agent(
  `In ${ROOT}, verify that this change actually works by EXERCISING it end-to-end, not by re-running tests: ${CHANGE}\n` +
    `First run git -C ${ROOT} diff (and git -C ${ROOT} status --short for untracked files) to see the affected surface. Then drive it:\n` +
    `- UI / IPC surface: build with npx vite build, then run node scripts/screenshot-app.mjs <outDir> (read its header for usage — it launches the REAL built Electron app against real registry/session/vault data) and inspect the relevant view or screenshot for the expected behavior.\n` +
    `- Electron-free *-core.ts logic: call it directly via node against a realistic input and check the output.\n` +
    `Report behaved=true ONLY if you OBSERVED the expected behavior. droveWhat = what flow you exercised and how; evidence = the concrete observation; artifacts = any screenshot or output paths you produced.`,
  { label: 'drive', phase: 'Drive', effort: 'high', schema: DRIVE_SCHEMA },
)

// Phase 3 — verdict. Fail closed again: a dead drive agent means the behavior
// was never observed, so a green floor alone is not "done".
phase('Verdict')
if (!drive) {
  log('drive agent died — floor is green but behavior was never observed; NOT DONE')
  return {
    done: false,
    floor,
    drive: null,
    verdict: {
      done: false,
      reasoning: 'The floor is green but the change was never exercised in the app, so its behavior is unverified.',
      blockers: ['drive phase did not complete'],
    },
  }
}

const verdict = await agent(
  `Decide whether this change is DONE by claude-hub's definition of done: the floor is green AND the change observably behaves.\n` +
    `Change: ${CHANGE}\n` +
    `Floor: passed=${floor.passed}; ${floor.output}\n` +
    `Drive: behaved=${drive.behaved}; drove ${drive.droveWhat}; evidence: ${drive.evidence}\n` +
    `Return done=true ONLY if the floor passed and the drive observed the expected behavior. List any blockers that keep it from being done.`,
  { label: 'verdict', phase: 'Verdict', schema: VERDICT_SCHEMA },
)

// Combine defensively: even an over-generous verdict cannot flip done unless
// the floor passed and the drive actually observed correct behavior.
const done = Boolean(verdict && verdict.done && floor.passed && drive.behaved)
log(done ? 'DONE — floor green + behavior observed' : 'NOT DONE — see blockers')
return { done, floor, drive, verdict }
