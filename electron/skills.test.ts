import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { listSkills } from './skills.ts'

// listSkills reads the registry at APP_ROOT (lazily, per call), so a test
// points APP_ROOT at a scratch dir and registers a scratch project rather
// than touching the real registry.json. The global ~/.claude/skills scan
// still runs and contributes real entries — assertions stay scoped to the
// scratch project's skills.
function scratchProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-skills-'))
  process.env.APP_ROOT = root
  const projectPath = path.join(root, 'proj')
  fs.mkdirSync(path.join(projectPath, '.claude', 'skills'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'registry.json'),
    JSON.stringify([{ id: randomUUID(), name: 'scratch', path: projectPath, addedAt: new Date(0).toISOString() }]),
  )
  return projectPath
}

function addSkill(projectPath: string, name: string): void {
  const dir = path.join(projectPath, '.claude', 'skills', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: a scratch skill\n---\n`)
}

// A skill folder symlinked to a since-moved target (the real case: three
// docLearly skills pointing into a OneDrive path that no longer exists)
// survives readdir but throws ENOENT on stat. 'junction' is deliberate —
// Windows refuses unelevated 'dir' symlinks, junctions need no privilege.
function addDanglingLink(projectPath: string, name: string): void {
  const link = path.join(projectPath, '.claude', 'skills', name)
  fs.symlinkSync(path.join(projectPath, 'gone-target'), link, 'junction')
}

test('a dangling skill symlink is skipped, not fatal to the whole scan', () => {
  const projectPath = scratchProject()
  addSkill(projectPath, 'alpha')
  addDanglingLink(projectPath, 'broken')
  addSkill(projectPath, 'omega')

  const scoped = listSkills().filter((s) => s.projectName === 'scratch')
  assert.deepEqual(
    scoped.map((s) => s.name).sort(),
    ['alpha', 'omega'],
    'skills on both sides of the dangling entry must survive',
  )
})

test('listSkills reads name and description from SKILL.md frontmatter', () => {
  const projectPath = scratchProject()
  addSkill(projectPath, 'alpha')

  const skill = listSkills().find((s) => s.projectName === 'scratch' && s.name === 'alpha')
  assert.ok(skill, 'scratch skill should be listed')
  assert.equal(skill.description, 'a scratch skill')
  assert.equal(skill.source, '.claude/skills')
})

// Writes SKILL.md verbatim so the frontmatter cases below are exactly what a
// real skill file contains.
function addRawSkill(projectPath: string, folder: string, frontmatter: string): void {
  const dir = path.join(projectPath, '.claude', 'skills', folder)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\nbody\n`)
}

test('quoted frontmatter values are unwrapped, not rendered with their quotes', () => {
  const projectPath = scratchProject()
  addRawSkill(projectPath, 'quoted', 'name: quoted\ndescription: "Use when the task is quoted."')

  const skill = listSkills().find((s) => s.projectName === 'scratch' && s.name === 'quoted')
  assert.equal(skill?.description, 'Use when the task is quoted.')
})

test('a `>` block-scalar description folds into one line instead of a bare ">"', () => {
  const projectPath = scratchProject()
  addRawSkill(projectPath, 'folded', 'name: folded\ndescription: >\n  First half of the description\n  and the second half.')

  const skill = listSkills().find((s) => s.projectName === 'scratch' && s.name === 'folded')
  assert.equal(skill?.description, 'First half of the description and the second half.')
})

test('a block scalar stops at the next frontmatter key', () => {
  const projectPath = scratchProject()
  addRawSkill(projectPath, 'ordered', 'description: |\n  Body line one.\n\nname: ordered')

  const skill = listSkills().find((s) => s.projectName === 'scratch' && s.name === 'ordered')
  assert.ok(skill, 'name after a block scalar must still parse')
  assert.equal(skill.description, 'Body line one.')
})
