import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// RUBRIC_PATH is resolved at import time from the vault root, so redirect it
// first (see vault-linker-run.test.ts for the same shape).
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rubric-'))
process.env.CLAUDE_HUB_VAULT = VAULT

const { readRubric, writeRubric, DEFAULT_RUBRIC, RUBRIC_PATH } = await import('./rubric-core.ts')

// This file is read fresh on every curate-hook extraction. Every failure mode
// below degrades curation silently — the hook still runs, it just judges by a
// weaker ruleset, and nothing in the app says so.

test('readRubric falls back to the default when the file does not exist', () => {
  fs.rmSync(RUBRIC_PATH, { force: true })
  assert.equal(readRubric(), DEFAULT_RUBRIC)
})

test('readRubric falls back to the default when the file is blank', () => {
  fs.writeFileSync(RUBRIC_PATH, '   \n\n')
  assert.equal(readRubric(), DEFAULT_RUBRIC, 'an empty ruleset must never reach the extractor')
})

test('writeRubric refuses to save an empty rubric', () => {
  fs.writeFileSync(RUBRIC_PATH, 'keep me')
  const result = writeRubric('   \n')
  assert.equal(result.ok, false)
  assert.equal(fs.readFileSync(RUBRIC_PATH, 'utf-8'), 'keep me', 'a refused save leaves the old rubric in place')
})

test('writeRubric round-trips an edited rubric, trimmed and newline-terminated', () => {
  assert.deepEqual(writeRubric('  # Only save gotchas  '), { ok: true })
  assert.equal(fs.readFileSync(RUBRIC_PATH, 'utf-8'), '# Only save gotchas\n')
  assert.equal(readRubric(), '# Only save gotchas')
})

test('writeRubric creates the vault directory when it is missing', () => {
  fs.rmSync(VAULT, { recursive: true, force: true })
  assert.deepEqual(writeRubric('# Rebuilt'), { ok: true })
  assert.equal(readRubric(), '# Rebuilt')
})
