import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSummaryResponse } from './sandbox.ts'

test('parseSummaryResponse parses TITLE, BULLET, and CRITICAL lines', () => {
  const raw = `TITLE: Built a working prototype of the graph layout.
BULLET: Tried force-directed layout with plain SVG, it worked well
BULLET: Tried a canvas-based approach first, abandoned it as overkill
BULLET: Backlinks parsing reused the existing link syntax
CRITICAL: the API key is hardcoded in config.ts
CRITICAL: tests are not passing on main`

  const result = parseSummaryResponse(raw)
  assert.equal(result.title, 'Built a working prototype of the graph layout.')
  assert.deepEqual(result.bullets, [
    'Tried force-directed layout with plain SVG, it worked well',
    'Tried a canvas-based approach first, abandoned it as overkill',
    'Backlinks parsing reused the existing link syntax',
  ])
  assert.deepEqual(result.critical, ['the API key is hardcoded in config.ts', 'tests are not passing on main'])
})

test('parseSummaryResponse with no CRITICAL lines returns an empty critical array', () => {
  const raw = `TITLE: Nothing notable happened here.
BULLET: Explored an idea, didn't pan out`

  const result = parseSummaryResponse(raw)
  assert.equal(result.title, 'Nothing notable happened here.')
  assert.deepEqual(result.bullets, ["Explored an idea, didn't pan out"])
  assert.deepEqual(result.critical, [])
})

test('parseSummaryResponse returns a null title when the model does not follow the format', () => {
  const raw = 'Here is a freeform paragraph the model wrote instead of following the requested format.'
  const result = parseSummaryResponse(raw)
  assert.equal(result.title, null)
  assert.deepEqual(result.bullets, [])
  assert.deepEqual(result.critical, [])
})

test('parseSummaryResponse ignores blank lines and surrounding whitespace', () => {
  const raw = `

  TITLE:   Extra whitespace around everything.

  BULLET:   still parsed fine

`
  const result = parseSummaryResponse(raw)
  assert.equal(result.title, 'Extra whitespace around everything.')
  assert.deepEqual(result.bullets, ['still parsed fine'])
})
