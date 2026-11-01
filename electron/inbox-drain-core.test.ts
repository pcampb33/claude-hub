import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDrainPrompt, parseDrainPlan, planDrain } from './inbox-drain-core.ts'
import type { DrainInboxEntry } from './inbox-drain-core.ts'
import { parseInboxBlocks } from './vault-inbox.ts'

const ENTRIES: DrainInboxEntry[] = [
  { index: 0, title: 'Vite ext resolution', sessionId: 'a', project: 'p', confidence: 'high', content: 'node needs .ts extensions' },
  { index: 1, title: 'Vite import extension quirk', sessionId: 'b', project: 'p', confidence: 'high', content: 'the same finding, reworded' },
  { index: 2, title: 'Some medium note', sessionId: 'c', project: 'p', confidence: 'medium', content: 'a mid-confidence thing' },
  { index: 3, title: 'Already in vault', sessionId: 'd', project: 'p', confidence: 'high', content: 'a known finding' },
]

test('buildDrainPrompt numbers entries and lists vault notes', () => {
  const prompt = buildDrainPrompt(ENTRIES, [{ title: 'Existing Note', excerpt: 'opening text' }])
  assert.match(prompt, /\[0\]/)
  assert.match(prompt, /\[3\]/)
  assert.match(prompt, /Existing Note: opening text/)
  assert.match(prompt, /EXACTLY ONE group/)
})

test('parseDrainPlan accepts an exact partition', () => {
  const raw = JSON.stringify({
    groups: [
      { members: [0, 1], representative: 0, duplicatesVaultNote: null },
      { members: [2], representative: 2, duplicatesVaultNote: null },
      { members: [3], representative: 3, duplicatesVaultNote: 'Already in vault' },
    ],
  })
  const res = parseDrainPlan(raw, 4)
  assert.equal(res.ok, true)
  assert.equal(res.groups?.length, 3)
})

test('parseDrainPlan strips a code fence the model may add', () => {
  const raw = '```json\n{"groups":[{"members":[0],"representative":0,"duplicatesVaultNote":null}]}\n```'
  assert.equal(parseDrainPlan(raw, 1).ok, true)
})

test('parseDrainPlan rejects a dropped entry (incomplete partition)', () => {
  const raw = JSON.stringify({ groups: [{ members: [0], representative: 0, duplicatesVaultNote: null }] })
  const res = parseDrainPlan(raw, 4)
  assert.equal(res.ok, false)
  assert.match(String(res.error), /partition incomplete/)
})

test('parseDrainPlan rejects an entry claimed by two groups', () => {
  const raw = JSON.stringify({
    groups: [
      { members: [0, 1], representative: 0, duplicatesVaultNote: null },
      { members: [1], representative: 1, duplicatesVaultNote: null },
    ],
  })
  assert.match(String(parseDrainPlan(raw, 2).error), /two groups/)
})

test('parseDrainPlan rejects an out-of-range member and a non-member representative', () => {
  assert.match(String(parseDrainPlan(JSON.stringify({ groups: [{ members: [9], representative: 9, duplicatesVaultNote: null }] }), 1).error), /out of range/)
  assert.match(String(parseDrainPlan(JSON.stringify({ groups: [{ members: [0], representative: 1, duplicatesVaultNote: null }] }), 1).error), /representative/)
})

test('parseDrainPlan rejects non-JSON', () => {
  assert.equal(parseDrainPlan('the model refused', 1).ok, false)
})

test('planDrain: promotes high rep, drops merged sibling, keeps medium, drops vault-dupe group', () => {
  const groups = [
    { members: [0, 1], representative: 0, duplicatesVaultNote: null }, // high cluster → promote rep 0, drop 1
    { members: [2], representative: 2, duplicatesVaultNote: null }, // medium → keep
    { members: [3], representative: 3, duplicatesVaultNote: 'Already in vault' }, // in vault → drop
  ]
  // The dupe claim is only honored because a vault note with that title exists.
  const vaultNotes = [{ title: 'Already in vault', excerpt: 'a known finding' }]
  const plan = planDrain(ENTRIES, groups, 'high', vaultNotes)
  assert.deepEqual(plan.promote, [{ title: 'Vite ext resolution', sessionId: 'a' }])
  assert.deepEqual(plan.keep, [{ title: 'Some medium note', sessionId: 'c' }])
  assert.deepEqual(
    plan.drop.map((d) => d.title),
    ['Vite import extension quirk', 'Already in vault'],
  )
})

// The data-loss guard: a duplicatesVaultNote title that names no real note must
// NOT drop the cluster (the model over-tags / hallucinates dupes). It falls
// through to the normal promote/keep path instead of silently deleting entries.
test('planDrain: an unverified vault-dupe claim promotes/keeps instead of dropping', () => {
  const groups = [{ members: [3], representative: 3, duplicatesVaultNote: 'A note that does not exist' }]
  const plan = planDrain(ENTRIES, groups, 'high', []) // no vault notes → claim unmatched
  assert.equal(plan.drop.length, 0)
  // entry 3 is high-confidence → promoted, not dropped.
  assert.deepEqual(plan.promote, [{ title: 'Already in vault', sessionId: 'd' }])
})

test('planDrain: a cluster promotes if ANY member is high, even when the rep is medium', () => {
  const entries: DrainInboxEntry[] = [
    { index: 0, title: 'rep', sessionId: 'a', project: null, confidence: 'medium', content: 'x' },
    { index: 1, title: 'sib', sessionId: 'b', project: null, confidence: 'high', content: 'y' },
  ]
  const plan = planDrain(entries, [{ members: [0, 1], representative: 0, duplicatesVaultNote: null }], 'high')
  assert.equal(plan.promote.length, 1)
  assert.equal(plan.promote[0].title, 'rep')
})

test('parseInboxBlocks pairs each entry with its body', () => {
  const inbox = `
## First finding

_2026-07-01 — proj — session s1 — high — (a) reason_

Body of the first.
Second line.

## Second finding

_2026-07-02 — session s2 — medium — (b) reason_

Body of the second.
`
  const blocks = parseInboxBlocks(inbox)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].title, 'First finding')
  assert.equal(blocks[0].confidence, 'high')
  assert.match(blocks[0].content, /Body of the first\.\nSecond line\./)
  assert.equal(blocks[1].content, 'Body of the second.')
})

// JSON.parse('null') / '42' succeed but aren't objects — the runner calls this
// outside a try/catch, so this must return {ok:false}, never throw.
test('parseDrainPlan fails safe on a bare null / non-object response', () => {
  assert.equal(parseDrainPlan('null', 4).ok, false)
  assert.equal(parseDrainPlan('42', 4).ok, false)
  assert.equal(parseDrainPlan('"a string"', 4).ok, false)
  assert.equal(parseDrainPlan('[]', 4).ok, false)
})
