import fs from 'node:fs'
import path from 'node:path'
import { listProjects } from './registry.ts'
import type { CreateWorkflowResult, WorkflowTemplate } from '../shared/ipc-types'

// Starter workflow shapes offered by "New workflow". Each `content` is a valid,
// parseable Workflow DevKit script with a `__NAME__` placeholder for meta.name.
// Content deliberately avoids backticks / ${...} / escape sequences so it can
// live inside these plain template literals without escaping; the scaffolded
// file is the user's to expand (prompts as template literals, etc.).
interface Template extends WorkflowTemplate {
  content: string
}

const TEMPLATES: Template[] = [
  {
    key: 'blank',
    label: 'Blank',
    description: 'Minimal meta + one agent() call. Build from scratch.',
    shape: [],
    content: `export const meta = {
  name: '__NAME__',
  description: 'One-line summary shown in the hub.',
  phases: [{ title: 'Work' }],
}

phase('Work')
const result = await agent('Describe the task here. Return what you need.', {
  schema: { type: 'object', properties: { output: { type: 'string' } } },
})

return { result }
`,
  },
  {
    key: 'review-pipeline',
    label: 'Review pipeline',
    description: 'Dimensions reviewed in parallel, each finding adversarially verified.',
    shape: ['pipeline', 'parallel'],
    content: `export const meta = {
  name: '__NAME__',
  description: 'Review a diff across dimensions, then verify each finding.',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const DIMENSIONS = [
  { key: 'correctness', prompt: 'Review the diff for real bugs and logic errors.' },
  { key: 'quality', prompt: 'Review the diff for clarity, duplication, and simplification.' },
]

const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } } } }
const VERDICT = { type: 'object', properties: { real: { type: 'boolean' } } }

const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { label: 'review:' + d.key, phase: 'Review', schema: FINDINGS }),
  (review, d) =>
    parallel(
      (review?.findings ?? []).map((f) => () =>
        agent('Adversarially verify: ' + f + '. Default to real=false unless certain.', {
          label: 'verify:' + d.key,
          phase: 'Verify',
          schema: VERDICT,
        }),
      ),
    ),
)

return { results }
`,
  },
  {
    key: 'research-fan-out',
    label: 'Research fan-out',
    description: 'Several lenses researched in parallel, then one synthesis pass.',
    shape: ['parallel'],
    content: `export const meta = {
  name: '__NAME__',
  description: 'Research several lenses in parallel, then synthesize one answer.',
  phases: [{ title: 'Research' }, { title: 'Synthesize' }],
}

const LENSES = ['prior art', 'techniques and APIs', 'risks and invariants']
const BRIEF = { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } } } }

phase('Research')
const briefs = await parallel(
  LENSES.map((lens) => () =>
    agent('Research this lens: ' + lens + '. Be concrete and cite sources.', {
      label: 'research:' + lens,
      phase: 'Research',
      model: 'sonnet',
      schema: BRIEF,
    }),
  ),
)

phase('Synthesize')
const synthesis = await agent('Synthesize a single answer from these briefs: ' + JSON.stringify(briefs), {
  label: 'synthesize',
  phase: 'Synthesize',
  model: 'opus',
  effort: 'high',
})

return { briefs, synthesis }
`,
  },
  {
    key: 'map-over-items',
    label: 'Map over items',
    description: 'Run each item through a multi-stage pipeline independently.',
    shape: ['pipeline'],
    content: `export const meta = {
  name: '__NAME__',
  description: 'Run each item through a multi-stage pipeline independently.',
  phases: [{ title: 'Process' }],
}

// Replace with the real list you want to process.
const ITEMS = ['item-a', 'item-b', 'item-c']

const processed = await pipeline(
  ITEMS,
  (item) => agent('First pass on ' + item + '.', { label: 'pass1:' + item, phase: 'Process' }),
  (prev, item) => agent('Second pass on ' + item + ', using the first result.', { label: 'pass2:' + item, phase: 'Process' }),
)

return { processed }
`,
  },
]

// Wire shape (drop the private `content`) for the renderer's template gallery.
export function listWorkflowTemplates(): WorkflowTemplate[] {
  return TEMPLATES.map(({ key, label, description, shape }) => ({ key, label, description, shape }))
}

// A workflow name doubles as its `/invocation` and its filename, so normalize
// to a kebab-case slug (letters/digits/dashes). Empty result = invalid input.
export function sanitizeWorkflowName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function renderTemplate(template: Template, name: string): string {
  return template.content.replace(/__NAME__/g, name)
}

// Core scaffold write — Electron-free and registry-free so it's unit-testable
// against a temp dir. Refuses to overwrite (same discipline as promote).
export function createWorkflowFile(destDir: string, rawName: string, templateKey: string): CreateWorkflowResult {
  const template = TEMPLATES.find((t) => t.key === templateKey)
  if (!template) return { ok: false, reason: 'unknown-template', message: `No template "${templateKey}"` }

  const name = sanitizeWorkflowName(rawName)
  if (!name) return { ok: false, reason: 'invalid-name', message: 'Enter a name using letters, numbers, or dashes.' }

  const destPath = path.join(destDir, `${name}.js`)
  if (fs.existsSync(destPath)) {
    return { ok: false, reason: 'conflict', message: `"${name}.js" already exists in ${destDir}` }
  }
  try {
    fs.mkdirSync(destDir, { recursive: true })
    fs.writeFileSync(destPath, renderTemplate(template, name), 'utf-8')
    return { ok: true, path: destPath, name }
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

// Registry-resolving wrapper: scaffold the template into a known project's
// .claude/workflows/. targetProjectId is a registry id (never a raw path).
export function createWorkflowFromTemplate(
  templateKey: string,
  rawName: string,
  targetProjectId: string,
): CreateWorkflowResult {
  const target = listProjects().find((p) => p.id === targetProjectId)
  if (!target) return { ok: false, reason: 'target-missing', message: `No registered project with id "${targetProjectId}"` }
  if (!fs.existsSync(target.path)) {
    return { ok: false, reason: 'target-missing', message: `Target project path not found: ${target.path}` }
  }
  return createWorkflowFile(path.join(target.path, '.claude', 'workflows'), rawName, templateKey)
}
