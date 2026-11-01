import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeToast } from './model.ts'
import { noteNameFromPath } from '../capture/model.ts'

// The inbox and capture both act on a VaultWriteResult that RESOLVES on
// failure, so a `.then` that only toasts success would report a refused write
// as saved and drop the card.

test('a resolved write with ok: false is an error, with the reason', () => {
  assert.deepEqual(writeToast({ ok: false, message: 'entry not found' }, 'Added “x”'), {
    kind: 'error',
    message: 'entry not found',
  })
  assert.equal(writeToast({ ok: false }, 'Added “x”').kind, 'error')
})

test('a write whose vault commit failed is not a clean success', () => {
  const t = writeToast({ ok: true, commit: { kind: 'failed', message: 'index.lock exists' } }, 'Added “x”')
  assert.equal(t.kind, 'error')
  assert.match(t.message, /no undo/)
  assert.match(t.message, /index\.lock exists/)
})

test('a committed or repo-less write is a success', () => {
  assert.equal(writeToast({ ok: true, commit: { kind: 'committed', sha: 'abc' } }, 'Added “x”').kind, 'success')
  assert.equal(writeToast({ ok: true, commit: { kind: 'not-a-repo' } }, 'Added “x”').kind, 'success')
})

test('the toast names the note the text landed in, from its path', () => {
  assert.equal(noteNameFromPath('C:\\projects\\claude-hub-vault\\Existing note.md'), 'Existing note')
  assert.equal(noteNameFromPath('/vault/a.b.md'), 'a.b')
  assert.equal(noteNameFromPath(undefined), null)
})
