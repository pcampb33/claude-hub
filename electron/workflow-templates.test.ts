import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listWorkflowTemplates, sanitizeWorkflowName, createWorkflowFile } from './workflow-templates.ts'
import { parseWorkflowFile } from './workflows.ts'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wf-templates-'))
}

test('listWorkflowTemplates returns the starter shapes without content', () => {
  const templates = listWorkflowTemplates()
  assert.deepEqual(
    templates.map((t) => t.key).sort(),
    ['blank', 'map-over-items', 'research-fan-out', 'review-pipeline'],
  )
  // The private content field must not leak to the renderer.
  assert.ok(templates.every((t) => !('content' in t)))
})

test('sanitizeWorkflowName produces a kebab-case slug', () => {
  assert.equal(sanitizeWorkflowName('  My New Workflow!  '), 'my-new-workflow')
  assert.equal(sanitizeWorkflowName('a11y_review'), 'a11y-review')
  assert.equal(sanitizeWorkflowName('---'), '')
})

test('createWorkflowFile scaffolds each template into a valid, parseable workflow', () => {
  for (const template of listWorkflowTemplates()) {
    const dir = tmpDir()
    const res = createWorkflowFile(dir, 'demo workflow', template.key)
    assert.equal(res.ok, true, `template ${template.key} should scaffold`)
    assert.equal(res.name, 'demo-workflow')
    assert.equal(res.path, path.join(dir, 'demo-workflow.js'))

    const content = fs.readFileSync(res.path as string, 'utf-8')
    // The name placeholder is substituted...
    assert.match(content, /name: 'demo-workflow'/)
    assert.ok(!content.includes('__NAME__'))
    // ...and the result is a workflow the hub's own parser accepts.
    const { meta, composition } = parseWorkflowFile(content)
    assert.equal(meta?.name, 'demo-workflow')
    assert.ok(composition.agentCount >= 1, `${template.key} should declare an agent`)
  }
})

test('createWorkflowFile refuses to overwrite an existing workflow', () => {
  const dir = tmpDir()
  assert.equal(createWorkflowFile(dir, 'dup', 'blank').ok, true)
  const second = createWorkflowFile(dir, 'dup', 'blank')
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'conflict')
})

test('createWorkflowFile rejects an empty name and an unknown template', () => {
  const dir = tmpDir()
  assert.equal(createWorkflowFile(dir, '   ', 'blank').reason, 'invalid-name')
  assert.equal(createWorkflowFile(dir, 'ok', 'nope').reason, 'unknown-template')
})
