import test from 'node:test'
import assert from 'node:assert/strict'
import { PRESETS, parseLayout } from './layout.ts'

const valid = new Set(PRESETS.everything.items.map((i) => i.id))

test('a saved named preset follows the preset as the code defines it now, keeping widget modes', () => {
  // Saved when Balanced still had Pace on its when-relevant rule.
  const saved = {
    preset: 'balanced',
    items: [
      { id: 'projects', size: 'L', auto: false, mode: 'activity' },
      { id: 'pace', size: 'S', auto: true },
    ],
  }
  const layout = parseLayout(JSON.stringify(saved), valid)
  assert.equal(layout.preset, 'balanced')
  assert.deepEqual(
    layout.items.map((i) => i.id),
    PRESETS.balanced.items.map((i) => i.id),
  )
  assert.equal(layout.items.find((i) => i.id === 'pace')?.auto, false)
  assert.equal(layout.items.find((i) => i.id === 'projects')?.mode, 'activity')
})

test('a custom layout is kept as saved, minus widgets that no longer exist', () => {
  const saved = { preset: 'custom', items: [{ id: 'pace', size: 'S', auto: true }, { id: 'gone', size: 'S', auto: false }] }
  assert.deepEqual(parseLayout(JSON.stringify(saved), valid), { preset: 'custom', items: [{ id: 'pace', size: 'S', auto: true }] })
})

test('nothing saved or a corrupt save is Balanced', () => {
  assert.equal(parseLayout(null, valid).preset, 'balanced')
  assert.equal(parseLayout('{not json', valid).preset, 'balanced')
})
