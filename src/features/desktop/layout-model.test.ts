import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DesktopSession, OutsideSession } from '../../../shared/ipc-types.ts'
import {
  PRESET,
  PRESETS,
  capacityOf,
  cellArea,
  effectiveMaximized,
  evenTracks,
  gutters,
  minFraction,
  moveCell,
  outsideKey,
  outsideSessionIdOf,
  parseStageState,
  replaceOnStage,
  resetAxis,
  resizeTracks,
  setTracks,
  stageCandidates,
  swapCells,
  toggleMaximize,
  trackTemplate,
  tracksFor,
} from './layout-model.ts'

function session(over: Partial<DesktopSession>): DesktopSession {
  return {
    id: 'd1',
    claudeSessionId: 'c1',
    name: 'one',
    color: 'frost',
    slot: 1,
    target: { kind: 'project', key: 'p1' },
    targetName: 'claude-hub',
    poppedOut: false,
    tier: null,
    createdAtIso: '2026-10-18T10:00:00.000Z',
    alive: true,
    state: 'working',
    stateDetail: null,
    lastActivityIso: null,
    contextPct: null,
    exitCode: null,
    ...over,
  }
}

function outside(sessionId: string): OutsideSession {
  return { pid: 1, sessionId, name: '', cwd: 'C:\\p', target: null, targetName: null, status: 'idle', updatedAtIso: null }
}

test('presets hold 1, 2, 3, 3, 4 and 6 tiles, and every cell fits its grid', () => {
  assert.deepEqual(
    PRESETS.map((p) => [p.key, capacityOf(p.key)]),
    [
      ['focus', 1],
      ['split', 2],
      ['cols3', 3],
      ['main-stack', 3],
      ['grid4', 4],
      ['grid6', 6],
    ],
  )
  for (const p of PRESETS) {
    for (const c of p.cells) {
      assert.ok(c.col + c.colSpan <= p.cols && c.row + c.rowSpan <= p.rows, `${p.key} cell out of bounds`)
    }
  }
})

test('track templates interleave tile tracks with fixed gutter tracks', () => {
  assert.equal(trackTemplate(evenTracks(1)), 'minmax(0, 1fr)')
  assert.equal(trackTemplate(evenTracks(2)), 'minmax(0, 0.5fr) 12px minmax(0, 0.5fr)')
  assert.equal(trackTemplate([0.25, 0.4, 0.35]), 'minmax(0, 0.25fr) 12px minmax(0, 0.4fr) 12px minmax(0, 0.35fr)')
  // Unstored presets split evenly.
  assert.deepEqual(tracksFor({}, 'grid6'), { cols: evenTracks(3), rows: evenTracks(2) })
})

test('cells and gutters land on the right grid tracks', () => {
  // Main + stack: the main tile spans both rows (and the gutter track between them).
  assert.deepEqual(cellArea(PRESET['main-stack'].cells[0]), { gridColumn: '1 / span 1', gridRow: '1 / span 3' })
  assert.deepEqual(cellArea(PRESET['main-stack'].cells[2]), { gridColumn: '3 / span 1', gridRow: '3 / span 1' })
  // Its row gutter only crosses the stacked column.
  assert.deepEqual(gutters('main-stack'), [
    { axis: 'cols', index: 0, gridColumn: '2', gridRow: '1 / -1' },
    { axis: 'rows', index: 0, gridColumn: '3 / 4', gridRow: '2' },
  ])
  // Grid 3x2: two column gutters, one row gutter across all three columns.
  assert.deepEqual(
    gutters('grid6').map((g) => [g.axis, g.gridColumn, g.gridRow]),
    [
      ['cols', '2', '1 / -1'],
      ['cols', '4', '1 / -1'],
      ['rows', '1 / 6', '2'],
    ],
  )
  assert.deepEqual(gutters('focus'), [])
})

test('a gutter drag moves only its two neighbours and clamps both to the minimum', () => {
  const fr = [1 / 3, 1 / 3, 1 / 3]
  const moved = resizeTracks(fr, 0, 0.1, 0.1)
  assert.ok(Math.abs(moved[0] - (1 / 3 + 0.1)) < 1e-9)
  assert.ok(Math.abs(moved[1] - (1 / 3 - 0.1)) < 1e-9)
  assert.equal(moved[2], fr[2])
  // Dragged past the neighbour: it stops at the minimum, total unchanged.
  const clamped = resizeTracks(fr, 1, 5, 0.1)
  assert.ok(Math.abs(clamped[2] - 0.1) < 1e-9)
  assert.ok(Math.abs(clamped.reduce((a, b) => a + b, 0) - 1) < 1e-9)
  assert.ok(Math.abs(resizeTracks(fr, 1, -5, 0.1)[1] - 0.1) < 1e-9)
  // Out-of-range boundary and a non-finite delta change nothing.
  assert.equal(resizeTracks(fr, 2, 0.1, 0.1), fr)
  assert.equal(resizeTracks(fr, 0, Number.NaN, 0.1), fr)
  // A minimum bigger than half the pair can't be honoured; it caps at an even split.
  assert.deepEqual(resizeTracks([0.5, 0.5], 0, 0.3, 0.9), [0.5, 0.5])
})

test('the minimum share follows the stage size but never exceeds an even split', () => {
  assert.equal(minFraction(160, 1600, 2), 0.1)
  assert.equal(minFraction(160, 200, 3), 1 / 3)
  assert.equal(minFraction(160, 0, 2), 0.5)
})

test('resized tracks are stored per preset; a double-click resets one axis', () => {
  const map = setTracks({}, 'cols3', 'cols', [0.5, 0.25, 0.25])
  assert.deepEqual(tracksFor(map, 'cols3').cols, [0.5, 0.25, 0.25])
  assert.deepEqual(tracksFor(map, 'split').cols, [0.5, 0.5])
  assert.deepEqual(tracksFor(resetAxis(map, 'cols3', 'cols'), 'cols3').cols, evenTracks(3))
})

test('dragging a tile onto another swaps them; Move left/right swaps with a neighbour', () => {
  assert.deepEqual(swapCells(['a', 'b', 'c'], 0, 2), ['c', 'b', 'a'])
  const same = ['a', 'b']
  assert.equal(swapCells(same, 0, 0), same)
  assert.equal(swapCells(same, 0, 5), same)
  assert.deepEqual(moveCell(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c'])
  assert.deepEqual(moveCell(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b'])
  // At an edge, or not on stage: unchanged.
  assert.deepEqual(moveCell(['a', 'b'], 'a', -1), ['a', 'b'])
  assert.deepEqual(moveCell(['a', 'b'], 'z', 1), ['a', 'b'])
})

test('maximize toggles, and a maximized tile that left the stage maximizes nothing', () => {
  assert.equal(toggleMaximize(null, 'a'), 'a')
  assert.equal(toggleMaximize('a', 'a'), null)
  assert.equal(toggleMaximize('a', 'b'), 'b')
  assert.equal(effectiveMaximized(['a', 'b'], 'b'), 'b')
  assert.equal(effectiveMaximized(['a'], 'b'), null)
})

test('a take-over replaces the read-only view in its own position', () => {
  assert.deepEqual(replaceOnStage(['a', 'outside:x', 'b'], 'outside:x', 'n'), ['a', 'n', 'b'])
  // Already picked onto the stage: the view just leaves.
  assert.deepEqual(replaceOnStage(['n', 'outside:x'], 'outside:x', 'n'), ['n'])
  assert.deepEqual(replaceOnStage(['a'], 'outside:x', 'n'), ['a'])
})

test('popped-out sessions leave the stage; outside views stay only while their session runs', () => {
  const sessions = [session({ id: 'a', slot: 1 }), session({ id: 'p', slot: 2, poppedOut: true }), session({ id: 'b', slot: 3 })]
  const onStage = ['a', outsideKey('x'), outsideKey('gone')]
  assert.deepEqual(stageCandidates(sessions, onStage, [outside('x'), outside('y')]), ['a', 'b', 'outside:x'])
  // Unreadable outside list: keep the views rather than claim they stopped.
  assert.deepEqual(stageCandidates(sessions, onStage, null), ['a', 'b', 'outside:x', 'outside:gone'])
  // A running outside session that nobody put on stage is never a filler.
  assert.deepEqual(stageCandidates(sessions, [], [outside('x')]), ['a', 'b'])
  assert.equal(outsideSessionIdOf(outsideKey('abc')), 'abc')
  assert.equal(outsideSessionIdOf('d1'), null)
})

test('stored stage state parses defensively and upgrades the v1 layout', () => {
  const empty = { layout: 'grid4', onStage: [], tracks: {} }
  assert.deepEqual(parseStageState(null), empty)
  assert.deepEqual(parseStageState('{not json'), empty)
  assert.deepEqual(parseStageState('{"layout":"split","onStage":["a",3,"b","c"]}'), { layout: 'split', onStage: ['a', 'b'], tracks: {} })
  assert.deepEqual(parseStageState('{"layout":"wide","onStage":"a"}'), empty)
  // Tracks: wrong lengths, non-positive or non-numbers are dropped; good ones normalise.
  const tracks = JSON.stringify({
    split: { cols: [3, 1], rows: [1] },
    cols3: { cols: [1, 1], rows: [1] },
    grid4: { cols: [1, -1], rows: [1, 1] },
    focus: { cols: ['x'], rows: [1] },
  })
  assert.deepEqual(parseStageState(`{"layout":"split","onStage":[],"tracks":${tracks}}`).tracks, { split: { cols: [0.75, 0.25], rows: [1] } })
  // No v2 yet: the v1 layout carries over, grid becoming Grid 2x2.
  assert.deepEqual(parseStageState(null, '{"layout":"grid","onStage":["a","b"]}'), { layout: 'grid4', onStage: ['a', 'b'], tracks: {} })
  assert.deepEqual(parseStageState(null, '{"layout":"focus","onStage":["a","b"]}'), { layout: 'focus', onStage: ['a'], tracks: {} })
  // v2 wins over v1.
  assert.equal(parseStageState('{"layout":"cols3"}', '{"layout":"focus"}').layout, 'cols3')
})
