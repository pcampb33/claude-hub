import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFrontmatter, deriveProject } from './vault-project.ts'

test('parseFrontmatter splits a leading YAML block from the body', () => {
  const { frontmatter, body } = parseFrontmatter('---\nproject: claude-hub\n---\n\n# Title\n\nBody line.\n')
  assert.deepEqual(frontmatter, { project: 'claude-hub' })
  assert.equal(body, '# Title\n\nBody line.\n')
})

test('parseFrontmatter reads multiple flat keys', () => {
  const { frontmatter, body } = parseFrontmatter('---\nproject: skyrim-agent\nfoo: bar baz\n---\n# Heading\n')
  assert.deepEqual(frontmatter, { project: 'skyrim-agent', foo: 'bar baz' })
  assert.equal(body, '# Heading\n')
})

test('parseFrontmatter returns content unchanged when there is no frontmatter', () => {
  const content = '# Just a note\n\nNo frontmatter here.\n'
  const { frontmatter, body } = parseFrontmatter(content)
  assert.deepEqual(frontmatter, {})
  assert.equal(body, content)
})

test('deriveProject returns a registered project named as a word (case-insensitive)', () => {
  assert.equal(deriveProject('Fixed the Bladesbanter combat log', ['bladesbanter']), 'bladesbanter')
})

test('deriveProject maps skyrim jargon to skyrim-agent via the alias map', () => {
  assert.equal(deriveProject('The papyrus script kept regenerating the navmesh', ['bladesbanter']), 'skyrim-agent')
})

test('deriveProject maps vault/workflow jargon to claude-hub via the alias map', () => {
  assert.equal(deriveProject('Queued a candidate to the vault _inbox for review', ['bladesbanter']), 'claude-hub')
})

test('deriveProject returns null for a generic cross-project principle naming no project', () => {
  assert.equal(deriveProject('Always write a failing test before fixing the bug', ['bladesbanter']), null)
})
