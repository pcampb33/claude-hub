import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveKnownPath } from './resolve-known-path.ts'

test('resolveKnownPath returns the candidate when it is in the known list', () => {
  const result = resolveKnownPath('C:\\projects\\foo', ['C:\\projects\\foo', 'C:\\projects\\bar'], 'project')
  assert.equal(result, 'C:\\projects\\foo')
})

test('resolveKnownPath throws when the candidate is not in the known list', () => {
  assert.throws(
    () => resolveKnownPath('C:\\projects\\evil', ['C:\\projects\\foo'], 'project'),
    /No known project at path "C:\\projects\\evil"/,
  )
})

test('resolveKnownPath throws on an empty known list', () => {
  assert.throws(() => resolveKnownPath('anything', [], 'thing'))
})

test('resolveKnownPath rejects a path-traversal candidate that is a prefix superset, not an exact match', () => {
  // Guards the exact bug class this helper exists to prevent: a candidate
  // that shares a string prefix with a known-good entry (e.g. a sibling
  // directory) must not be accepted just because it "looks close."
  assert.throws(() => resolveKnownPath('C:\\projects\\foo-evil', ['C:\\projects\\foo'], 'project'))
})

test('resolveKnownPath is case-sensitive (exact match required)', () => {
  assert.throws(() => resolveKnownPath('C:\\Projects\\Foo', ['C:\\projects\\foo'], 'project'))
})
