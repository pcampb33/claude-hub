import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promoteCore } from './promote-core.ts'

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('promoteCore copies a skill folder into <target>/.claude/skills', () => {
  const source = makeTempDir('claude-hub-test-source-')
  const target = makeTempDir('claude-hub-test-target-')
  try {
    const skillDir = path.join(source, 'my-skill')
    fs.mkdirSync(skillDir)
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# My Skill')

    const result = promoteCore(skillDir, target)

    assert.equal(result.ok, true)
    const destPath = path.join(target, '.claude', 'skills', 'my-skill')
    assert.equal(result.destPath, destPath)
    assert.equal(fs.readFileSync(path.join(destPath, 'SKILL.md'), 'utf-8'), '# My Skill')
  } finally {
    fs.rmSync(source, { recursive: true, force: true })
    fs.rmSync(target, { recursive: true, force: true })
  }
})

test('promoteCore refuses on a name conflict rather than overwriting', () => {
  const source = makeTempDir('claude-hub-test-source-')
  const target = makeTempDir('claude-hub-test-target-')
  try {
    const skillDir = path.join(source, 'my-skill')
    fs.mkdirSync(skillDir)
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# New content')

    const existingDest = path.join(target, '.claude', 'skills', 'my-skill')
    fs.mkdirSync(existingDest, { recursive: true })
    fs.writeFileSync(path.join(existingDest, 'SKILL.md'), '# Original content')

    const result = promoteCore(skillDir, target)

    assert.equal(result.ok, false)
    assert.equal(result.reason, 'conflict')
    // Original content must be untouched — refuse, don't overwrite.
    assert.equal(fs.readFileSync(path.join(existingDest, 'SKILL.md'), 'utf-8'), '# Original content')
  } finally {
    fs.rmSync(source, { recursive: true, force: true })
    fs.rmSync(target, { recursive: true, force: true })
  }
})

test('promoteCore rejects a missing source path', () => {
  const target = makeTempDir('claude-hub-test-target-')
  try {
    const result = promoteCore(path.join(target, 'does-not-exist'), target)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'source-missing')
  } finally {
    fs.rmSync(target, { recursive: true, force: true })
  }
})

test('promoteCore rejects a missing target project path', () => {
  const source = makeTempDir('claude-hub-test-source-')
  try {
    const skillDir = path.join(source, 'my-skill')
    fs.mkdirSync(skillDir)
    const result = promoteCore(skillDir, path.join(source, 'no-such-project'))
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'target-missing')
  } finally {
    fs.rmSync(source, { recursive: true, force: true })
  }
})

test('promoteCore rejects a source path that is a file, not a directory', () => {
  const source = makeTempDir('claude-hub-test-source-')
  const target = makeTempDir('claude-hub-test-target-')
  try {
    const sourceFile = path.join(source, 'not-a-dir.md')
    fs.writeFileSync(sourceFile, 'oops')
    const result = promoteCore(sourceFile, target)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'source-missing')
  } finally {
    fs.rmSync(source, { recursive: true, force: true })
    fs.rmSync(target, { recursive: true, force: true })
  }
})
