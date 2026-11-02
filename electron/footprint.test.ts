import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { countLogLines, getFootprint } from './footprint.ts'

const NOW = Date.parse('2026-11-01T12:00:00.000Z')

function tmpRoot(): string {
  // <tmp>/<ws>/claude-hub, so the workspace (the install's parent) is <tmp>/<ws>.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-footprint-'))
  const root = path.join(ws, 'claude-hub')
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  return root
}

test('countLogLines: only the window counts; a missing log is zero, not unknown', () => {
  const root = tmpRoot()
  const log = path.join(root, 'scripts', 'x.log')
  fs.writeFileSync(
    log,
    [
      "2026-09-01T00:00:00.000Z [pid 1] exit: outside claude-hub's scope (session=old)",
      "2026-10-30T00:00:00.000Z [pid 2] exit: outside claude-hub's scope (session=a)",
      '2026-10-31T00:00:00.000Z [pid 3] start session=b transcript=x',
      '2026-10-31T00:01:00.000Z [pid 3] done: triage=no-candidate (cost=$0.0100)',
      'a continuation line with cost=$1 but no stamp',
    ].join('\n'),
  )
  assert.deepEqual(countLogLines(log, ['cost=', "outside claude-hub's scope"], NOW), [1, 1])
  assert.deepEqual(countLogLines(path.join(root, 'scripts', 'missing.log'), ['x'], NOW), [0])
  // A directory where the log should be: unreadable, so null.
  fs.mkdirSync(path.join(root, 'scripts', 'dir.log'))
  assert.equal(countLogLines(path.join(root, 'scripts', 'dir.log'), ['x'], NOW), null)
})

test('getFootprint: lists projects outside the workspace and the hub-written deny rules', () => {
  const root = tmpRoot()
  const ws = path.dirname(root)
  const saved = process.env.APP_ROOT
  process.env.APP_ROOT = root
  try {
    fs.writeFileSync(
      path.join(root, 'registry.json'),
      JSON.stringify([
        { id: 'in', name: 'inside', path: path.join(ws, 'inside'), addedAt: '' },
        { id: 'out', name: 'elsewhere', path: 'D:\\elsewhere', addedAt: '' },
      ]),
    )
    fs.writeFileSync(
      path.join(root, 'boundaries.json'),
      JSON.stringify({ version: 1, targets: { 'project:out': { tier: 'guarded', localGuard: { rules: ['Read(//d/x/**)', 'Edit(//d/x/**)'] } }, 'project:in': { tier: 'audit' } } }),
    )
    const f = getFootprint(NOW)
    assert.equal(f.scope.error, null)
    assert.equal(path.resolve(f.scope.workspace), path.resolve(ws))
    assert.deepEqual(f.scope.outside.map((p) => p.name), ['elsewhere'])
    assert.deepEqual(f.denyRules, [{ name: 'elsewhere', rules: 2 }])
    assert.deepEqual(f.curate, { reviewed: 0, outside: 0 }) // no logs yet

    // An unreadable boundaries file is an error, never "no deny rules".
    fs.writeFileSync(path.join(root, 'boundaries.json'), '{ broken')
    const broken = getFootprint(NOW)
    assert.equal(broken.denyRules, null)
    assert.match(broken.denyRulesError ?? '', /boundaries\.json/)
  } finally {
    process.env.APP_ROOT = saved
  }
})

test('getFootprint: reports whether the Start Menu shortcut is there', () => {
  const root = tmpRoot()
  const saved = { APP_ROOT: process.env.APP_ROOT, APPDATA: process.env.APPDATA }
  process.env.APP_ROOT = root
  process.env.APPDATA = path.join(path.dirname(root), 'appdata')
  try {
    const missing = getFootprint(NOW).startMenuShortcut
    assert.equal(missing.present, false)
    assert.ok(missing.path.startsWith(process.env.APPDATA))
    fs.mkdirSync(path.dirname(missing.path), { recursive: true })
    fs.writeFileSync(missing.path, '')
    assert.equal(getFootprint(NOW).startMenuShortcut.present, true)
  } finally {
    process.env.APP_ROOT = saved.APP_ROOT
    process.env.APPDATA = saved.APPDATA
  }
})
