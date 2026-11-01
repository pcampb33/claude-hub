import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveSessionPaths, sidecarDirFor } from './session-delete-core.ts'

// resolveSessionPaths reaches listProjects(), which joins process.env.APP_ROOT
// — point it at a scratch dir holding an empty registry, the same shape
// launch-core.test.ts uses (and for the same reason: without it registryPath()
// throws a TypeError instead of the rejection each test expects, and
// readRegistry would seed and write the REAL registry.json as a side effect of
// running the suite).
const SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-delete-'))
process.env.APP_ROOT = SCRATCH_ROOT
fs.writeFileSync(path.join(SCRATCH_ROOT, 'registry.json'), '[]')

// This is the delete path, so every guard between "the renderer said a word"
// and "shell.trashItem is called on a real directory" is worth pinning.

test('the sidecar dir is the transcript path minus its extension', () => {
  assert.equal(
    sidecarDirFor(path.join('C:', 'p', 'sess', 'c007389a-de54-4436-8dc3-299f7815ed02.jsonl')),
    path.join('C:', 'p', 'sess', 'c007389a-de54-4436-8dc3-299f7815ed02'),
  )
})

test('deleting refuses an unregistered project before it resolves anything', () => {
  assert.throws(
    () => resolveSessionPaths('no-such-project', 'c007389a-de54-4436-8dc3-299f7815ed02'),
    /No registered project/,
  )
})

test('deleting refuses a session id that is not a UUID', () => {
  const projectPath = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'proj-'))
  fs.writeFileSync(
    path.join(SCRATCH_ROOT, 'registry.json'),
    JSON.stringify([{ id: 'p1', name: 'p1', path: projectPath }]),
  )
  for (const bad of ['', '../../etc/passwd', 'c007389a-de54-4436-8dc3-299f7815ed0']) {
    assert.throws(() => resolveSessionPaths('p1', bad), /Not a session id/, `should reject ${JSON.stringify(bad)}`)
  }
  fs.writeFileSync(path.join(SCRATCH_ROOT, 'registry.json'), '[]')
})

test('deleting refuses a well-formed id with no transcript on disk', () => {
  const projectPath = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'proj-'))
  fs.writeFileSync(
    path.join(SCRATCH_ROOT, 'registry.json'),
    JSON.stringify([{ id: 'p1', name: 'p1', path: projectPath }]),
  )
  assert.throws(
    () => resolveSessionPaths('p1', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    /No session .* recorded in that project/,
  )
  fs.writeFileSync(path.join(SCRATCH_ROOT, 'registry.json'), '[]')
})
