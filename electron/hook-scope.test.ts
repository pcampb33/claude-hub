import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hookScope, inHookScope } from './hook-scope.ts'

const roots = ['C:\\projects', 'C:\\Users\\J_doe\\Desktop\\claude projects\\Rational']

test('inHookScope: the workspace, its subfolders and registered projects are in', () => {
  assert.equal(inHookScope('C:\\projects', roots), true)
  assert.equal(inHookScope('C:\\projects\\claude-hub-sandbox\\company-compare', roots), true)
  assert.equal(inHookScope('c:/PROJECTS/trading-bot/', roots), true) // case, slashes, trailing separator
  assert.equal(inHookScope('C:\\Users\\J_doe\\Desktop\\claude projects\\Rational\\src', roots), true)
})

test('inHookScope: everything else is out, including a sibling that shares a prefix', () => {
  assert.equal(inHookScope('C:\\Users\\J_doe\\OneDrive\\Desktop\\claude projects\\empty folder', roots), false)
  assert.equal(inHookScope('C:\\projects-old\\thing', roots), false)
  assert.equal(inHookScope('C:\\Users\\J_doe\\Desktop\\claude projects\\Rational2', roots), false)
  assert.equal(inHookScope('', roots), false)
})

test('hookScope: an unreadable registry narrows the scope to the workspace and says why', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-scope-'))
  const saved = process.env.APP_ROOT
  process.env.APP_ROOT = appRoot
  try {
    fs.writeFileSync(path.join(appRoot, 'registry.json'), '{ not json')
    const scope = hookScope(appRoot)
    assert.match(scope.error ?? '', /registry/)
    assert.equal(scope.roots.length, 2) // workspace + sandbox, nothing wider
    assert.equal(inHookScope(path.join(path.dirname(appRoot), 'x'), scope.roots), true)

    fs.writeFileSync(path.join(appRoot, 'registry.json'), JSON.stringify([{ id: 'a', name: 'ext', path: 'D:\\elsewhere\\ext', addedAt: '' }]))
    const ok = hookScope(appRoot)
    assert.equal(ok.error, null)
    assert.equal(inHookScope('D:\\elsewhere\\ext\\sub', ok.roots), true)
  } finally {
    process.env.APP_ROOT = saved
    fs.rmSync(appRoot, { recursive: true, force: true })
  }
})
