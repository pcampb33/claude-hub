import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listProjects, addProject, removeProject, setVerifyCommand, setPinned } from './registry.ts'

// The registry is the source of truth every path-validated IPC action resolves
// against: a launch or a write takes an id from the renderer and trusts what
// this module hands back. It had no tests.
//
// APP_ROOT is redirected at a tmpdir and registry.json written up front —
// without the file, readRegistry SEEDS one, and seeding runs `git init` in the
// real C:\projects\claude-hub-sandbox. The seed path is therefore deliberately
// not exercised here; everything below starts from an existing registry.
process.env.APP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-reg-'))
const REGISTRY = path.join(process.env.APP_ROOT, 'registry.json')

const EXISTING = { id: 'reg-existing', name: 'existing', path: 'C:\\proj\\existing', addedAt: '2026-08-01T00:00:00.000Z' }

function reset(entries = [EXISTING]): void {
  fs.writeFileSync(REGISTRY, JSON.stringify(entries, null, 2) + '\n')
}

function makeDir(name: string): string {
  const dir = path.join(process.env.APP_ROOT!, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test('addProject registers a real directory and persists it', () => {
  reset()
  const dir = makeDir('alpha')

  const entry = addProject(dir)

  assert.equal(entry.name, 'alpha', 'the name is the folder basename')
  assert.equal(entry.path, dir)
  assert.ok(entry.id && entry.id !== EXISTING.id, 'a fresh id, not a reused one')
  assert.deepEqual(
    JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).map((e: { id: string }) => e.id),
    [EXISTING.id, entry.id],
    'written through to disk, appended after what was already there',
  )
})

// Every "resolve this id to a path" check downstream assumes the registered
// path is a directory that exists. Rejecting here is what makes that true.
test('addProject refuses a file and a path that is not there', () => {
  reset()
  const file = path.join(process.env.APP_ROOT!, 'not-a-project.txt')
  fs.writeFileSync(file, 'x')

  assert.throws(() => addProject(file), /Not a directory/)
  assert.throws(() => addProject(path.join(process.env.APP_ROOT!, 'absent')), /Not a directory/)
  assert.deepEqual(listProjects().map((e) => e.id), [EXISTING.id], 'a rejected add leaves the registry alone')
})

// Windows paths are case-insensitive, so the same project spelled two ways is
// the same project. Registering it twice would give one directory two ids —
// and two rows in every view that lists projects.
test('addProject rejects the same directory spelled differently', () => {
  reset()
  const dir = makeDir('bravo')
  addProject(dir)

  assert.throws(() => addProject(dir.toUpperCase()), /Already registered as "bravo"/)
  assert.throws(() => addProject(path.join(dir, '.')), /Already registered as "bravo"/)
  assert.equal(listProjects().length, 2)
})

test('removeProject drops only the id it was given', () => {
  const other = { ...EXISTING, id: 'reg-other', name: 'other' }
  reset([EXISTING, other])

  removeProject(EXISTING.id)

  assert.deepEqual(listProjects().map((e) => e.id), [other.id])
})

// Blank must remove the key, not store "". The floor card reads the key's
// presence to decide whether Run verify is offered at all, so an empty string
// would leave a CTA on screen that spawns nothing.
test('setVerifyCommand trims what it stores and blank clears the key entirely', () => {
  reset()

  assert.equal(setVerifyCommand(EXISTING.id, '  npm test  ').verifyCommand, 'npm test')
  assert.equal(listProjects()[0].verifyCommand, 'npm test')

  const cleared = setVerifyCommand(EXISTING.id, '   ')
  assert.ok(!('verifyCommand' in cleared), 'blank deletes the key rather than storing an empty string')
  assert.ok(!('verifyCommand' in listProjects()[0]))
})

// Same invariant on the other setter: unpinning writes an absent key, matching
// the seed shape, not `pinned: false`.
test('setPinned removes the key when unpinning', () => {
  reset()

  assert.equal(setPinned(EXISTING.id, true).pinned, true)
  const unpinned = setPinned(EXISTING.id, false)

  assert.ok(!('pinned' in unpinned))
  assert.ok(!('pinned' in listProjects()[0]))
})

test('the setters refuse an id that is not registered', () => {
  reset()

  assert.throws(() => setVerifyCommand('no-such-id', 'npm test'), /No project with id/)
  assert.throws(() => setPinned('no-such-id', true), /No project with id/)
})
