import test from 'node:test'
import assert from 'node:assert/strict'
import { scorePaletteItem } from './score.ts'

// The bug this replaced: cmdk's subsequence scorer accepted any row whose
// letters appeared in order, so "firewall" matched a note about mojibake.
test('a subsequence that is not a substring is not a match', () => {
  assert.equal(scorePaletteItem('note PowerShell 5.1 whole-file rewrite mojibakes UTF-8', 'firewall'), 0)
  assert.ok(scorePaletteItem('note Firewall fix for the Tailscale interface', 'firewall') > 0)
})

test('every term has to be present, not just some of them', () => {
  const value = 'skill parallel-build run implementers in worktrees'
  assert.ok(scorePaletteItem(value, 'parallel worktrees') > 0)
  assert.equal(scorePaletteItem(value, 'parallel kubernetes'), 0)
})

test('matching is case-insensitive in both directions', () => {
  assert.ok(scorePaletteItem('note Firewall Fix', 'FIREWALL') > 0)
  assert.ok(scorePaletteItem('note FIREWALL FIX', 'firewall') > 0)
})

test('an empty search matches everything so the idle list keeps its own order', () => {
  assert.equal(scorePaletteItem('anything at all', ''), 1)
  assert.equal(scorePaletteItem('anything at all', '   '), 1)
})

test('a match at the start outranks one inside a word', () => {
  const atStart = scorePaletteItem('vault linker', 'vault')
  const atWordStart = scorePaletteItem('the vault linker', 'vault')
  const midWord = scorePaletteItem('revault linker', 'vault')
  assert.ok(atStart > atWordStart, 'start of the value beats start of a later word')
  assert.ok(atWordStart > midWord, 'start of a word beats the middle of one')
})

test('a shorter value outranks a longer one that matches the same way', () => {
  const short = scorePaletteItem('firewall', 'firewall')
  const long = scorePaletteItem('firewall ' + 'x'.repeat(200), 'firewall')
  assert.ok(short > long)
  // …but only nudged, never buried: cmdk sorts on this, and a long title that
  // starts with the query must still beat a short one that only mentions it.
  assert.ok(long > scorePaletteItem('the firewall', 'firewall'))
})
