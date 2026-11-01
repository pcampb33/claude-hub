import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkdownLite } from './markdown-lite.ts'

// The grammar was widened for the session transcript, where the input is
// Claude's own prose rather than a curated LEARNINGS.md. Measured over 120
// real transcripts, 87 of 2331 assistant turns fell back to unformatted text
// and tables alone caused 73 of them; after these blocks, 1 of 2342 does.
//
// What each test pins is the *contract*, not the convenience: a construct
// either parses correctly or the whole input falls back. A half-parsed table
// that silently drops a column is the failure mode worth a test.

test('a GFM table parses with its alignments and cells', () => {
  const blocks = parseMarkdownLite('| criterion | `w` | z |\n|---|:---:|---:|\n| typography | 4.5 | 4 |\n')
  assert.notEqual(blocks, null)
  assert.equal(blocks!.length, 1)
  const table = blocks![0]
  assert.equal(table.kind, 'table')
  if (table.kind !== 'table') return
  assert.deepEqual(table.header, ['criterion', '`w`', 'z'])
  assert.deepEqual(table.align, [null, 'center', 'right'])
  assert.deepEqual(table.rows, [['typography', '4.5', '4']])
})

test('a pipe line with no delimiter row under it is not a table', () => {
  // Guessing a one-column table here would misrepresent the text; the whole
  // input falls back instead.
  assert.equal(parseMarkdownLite('| not a table\n| really not\n'), null)
})

test('a ragged table pads short rows and drops overflow instead of falling back', () => {
  const blocks = parseMarkdownLite('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |\n')
  assert.notEqual(blocks, null)
  const table = blocks![0]
  if (table.kind !== 'table') throw new Error('expected a table')
  assert.deepEqual(table.rows, [
    ['1', ''],
    ['1', '2'],
  ])
})

test('an escaped pipe stays inside its cell', () => {
  const blocks = parseMarkdownLite('| pattern | note |\n|---|---|\n| a \\| b | alternation |\n')
  const table = blocks![0]
  if (table.kind !== 'table') throw new Error('expected a table')
  assert.deepEqual(table.rows, [['a | b', 'alternation']])
})

test('consecutive quote lines join into one blockquote', () => {
  const blocks = parseMarkdownLite('> A quoted line\n> continued here\n')
  assert.deepEqual(blocks, [{ kind: 'quote', text: 'A quoted line continued here' }])
})

test('a quote carrying its own block structure falls back', () => {
  // A half-formatted quote is exactly the misrepresentation the fallback
  // contract exists to prevent.
  assert.equal(parseMarkdownLite('> - a list inside a quote\n'), null)
  assert.equal(parseMarkdownLite('> | a | b |\n'), null)
})

test('a thematic break is a rule, not a fallback', () => {
  assert.deepEqual(parseMarkdownLite('one\n\n---\n\ntwo\n'), [
    { kind: 'para', text: 'one' },
    { kind: 'rule' },
    { kind: 'para', text: 'two' },
  ])
})

test('a nested ordered list keeps its ordering', () => {
  const blocks = parseMarkdownLite('1. outer\n   1. first\n   2. second\n2. back\n')
  assert.notEqual(blocks, null)
  const list = blocks![0]
  if (list.kind !== 'list') throw new Error('expected a list')
  assert.equal(list.ordered, true)
  assert.equal(list.items.length, 2)
  const sub = list.items[0].find((seg) => seg.kind === 'sub')
  assert.equal(sub?.kind, 'sub')
  if (sub?.kind !== 'sub') return
  assert.equal(sub.ordered, true)
  assert.deepEqual(sub.items, ['first', 'second'])
})

test('a bullet nested under an ordered item stays unordered', () => {
  const blocks = parseMarkdownLite('1. outer\n   - inner\n')
  const list = blocks![0]
  if (list.kind !== 'list') throw new Error('expected a list')
  const sub = list.items[0].find((seg) => seg.kind === 'sub')
  if (sub?.kind !== 'sub') throw new Error('expected a nested list')
  assert.equal(sub.ordered, false)
  assert.deepEqual(sub.items, ['inner'])
})

test('the constructs that stay surprising still fall back', () => {
  assert.equal(parseMarkdownLite('#### too deep\n'), null)
  assert.equal(parseMarkdownLite('<div>block html</div>\n'), null)
  assert.equal(parseMarkdownLite('\ttab indented\n'), null)
  assert.equal(parseMarkdownLite('```unclosed fence\n'), null)
})
