import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Both roots redirected before the import: USERPROFILE so the global skills
// scan (and promoteSkillToGlobal's ~/.claude/skills destination) land in a
// tmpdir rather than the real one, APP_ROOT for registry.json. Dynamic import
// so listSkills/listProjects resolve them after they are set.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-promote-home-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.APP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-promote-root-'))

const source = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-promote-src-'))
const target = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-promote-dst-'))
const SOURCE_PROJECT = { id: 'promote-src', name: 'src', path: source, addedAt: '2026-08-01T00:00:00.000Z' }
const TARGET_PROJECT = { id: 'promote-dst', name: 'dst', path: target, addedAt: '2026-08-01T00:00:00.000Z' }
fs.writeFileSync(
  path.join(process.env.APP_ROOT, 'registry.json'),
  JSON.stringify([SOURCE_PROJECT, TARGET_PROJECT]),
)

// One real skill, in the only place listSkills() looks: a registered
// project's root .claude/skills.
const SKILL_PATH = path.join(source, '.claude', 'skills', 'demo')
fs.mkdirSync(SKILL_PATH, { recursive: true })
fs.writeFileSync(path.join(SKILL_PATH, 'SKILL.md'), '---\nname: demo\ndescription: a demo\n---\nbody\n')

const { promoteToProject, promoteSkillToGlobal } = await import('./promote.ts')

function resetTarget(): void {
  fs.rmSync(path.join(target, '.claude'), { recursive: true, force: true })
  fs.rmSync(path.join(home, '.claude', 'skills'), { recursive: true, force: true })
}

test('promoteToProject copies a known skill into the target project', () => {
  resetTarget()

  const result = promoteToProject(SKILL_PATH, TARGET_PROJECT.id)

  assert.equal(result.ok, true, result.message)
  // Asserted on disk, not on the returned shape: destPath is internal to
  // promote-core and deliberately absent from the renderer's PromoteResult.
  assert.ok(fs.existsSync(path.join(target, '.claude', 'skills', 'demo', 'SKILL.md')))
})

// The one that matters. The renderer sends a path; the main process must not
// copy from wherever it is told. Only paths listSkills()/listExperimentPaths()
// already enumerated are legal sources — a directory that plainly exists but
// was never enumerated is still refused.
test('promoteToProject refuses a source it did not enumerate, however real', () => {
  resetTarget()
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-promote-outside-'))
  fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), 'not enumerated')

  const result = promoteToProject(elsewhere, TARGET_PROJECT.id)

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'source-missing')
  assert.ok(!fs.existsSync(path.join(target, '.claude')), 'nothing was copied')
})

test('promoteToProject refuses a target that is not a registered id', () => {
  resetTarget()

  const result = promoteToProject(SKILL_PATH, 'no-such-project')

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'target-missing')
})

// Refuse-on-conflict, not overwrite: the same semantics register-skill.mjs
// gives agents. A promote that silently replaced a project's edited copy of a
// skill would lose work with no way to notice.
test('promoteToProject refuses rather than overwriting an existing copy', () => {
  resetTarget()
  assert.equal(promoteToProject(SKILL_PATH, TARGET_PROJECT.id).ok, true)

  const second = promoteToProject(SKILL_PATH, TARGET_PROJECT.id)

  assert.equal(second.ok, false)
  assert.equal(second.reason, 'conflict')
  assert.equal(fs.readFileSync(path.join(target, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf-8').trim().endsWith('body'), true)
})

// The global promote writes OUTSIDE any registered project, so there is no
// registry id to validate against — the source enumerator is the only guard
// there is, which makes it load-bearing rather than belt-and-braces.
test('promoteSkillToGlobal validates the source against the skills enumerator', () => {
  resetTarget()
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-promote-global-'))

  const refused = promoteSkillToGlobal(elsewhere)
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'source-missing')

  const allowed = promoteSkillToGlobal(SKILL_PATH)
  assert.equal(allowed.ok, true, allowed.message)
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'demo', 'SKILL.md')))
})
