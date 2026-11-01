import test from 'node:test'
import assert from 'node:assert/strict'
import { activityRows, dayLabels, dotRadius, healthTone, logPos, placeLabels, scoreFloor } from './projects-core.ts'

test('log axis: now is 0, 30 days is 1, older clamps to 1', () => {
  assert.equal(logPos(0), 0)
  assert.equal(logPos(720), 1)
  assert.equal(logPos(5000), 1)
  assert.ok(logPos(24) > 0.4 && logPos(24) < 0.6)
})

test('health tone follows the map: red below 70, amber below 80', () => {
  assert.equal(healthTone(53), 'danger')
  assert.equal(healthTone(73), 'warn')
  assert.equal(healthTone(80), 'accent')
})

test('dot radius grows with tokens and is capped', () => {
  assert.ok(dotRadius(4621) > dotRadius(516))
  assert.equal(dotRadius(1e9), 14)
})

test('score floor drops below 50 only when a project does', () => {
  assert.equal(scoreFloor([97, 53]), 50)
  assert.equal(scoreFloor([97, 38]), 30)
})

test('labels never overlap each other or another dot, and stay inside the chart', () => {
  const dots = [
    { x: 100, y: 50, r: 6, label: 'claude-hub' },
    { x: 104, y: 54, r: 6, label: 'sandbox' },
    { x: 395, y: 80, r: 5, label: 'kroger-order' },
  ]
  const placed = placeLabels(dots, 400, 200)
  const boxes = placed.map((p, i) => {
    assert.ok(p, `dot ${i} got a label`)
    const w = dots[i].label.length * 6.1
    const x0 = p.anchor === 'start' ? p.x : p.anchor === 'end' ? p.x - w : p.x - w / 2
    assert.ok(x0 >= 0 && x0 + w <= 400, `label ${i} inside the width`)
    return [x0, p.y - 10, x0 + w, p.y + 3]
  })
  const [a, b] = boxes
  assert.ok(!(a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]), 'the two close labels do not overlap')
  // The dot at the right edge has no room on its right: its label flips.
  assert.notEqual(placed[2]!.anchor, 'start')
})

test('a dot with no free spot gets no label rather than an overlapping one', () => {
  const placed = placeLabels([{ x: 10, y: 10, r: 9, label: 'a-very-long-project-name' }], 30, 20)
  assert.deepEqual(placed, [null])
})

test('activity rows: busiest first, idle projects dropped, totals per day', () => {
  const { rows, totals } = activityRows(
    [
      { registryId: 'a', days: [0, 1, 2] },
      { registryId: 'b', days: [0, 0, 0] },
      { registryId: 'c', days: [3, 1, 0] },
    ],
    (id) => ({ a: 'alpha', c: 'gamma' })[id],
  )
  assert.deepEqual(
    rows.map((r) => [r.name, r.total]),
    [
      ['gamma', 4],
      ['alpha', 3],
    ],
  )
  assert.deepEqual(totals, [3, 2, 2])
})

test('day labels end today and count back 14 local days', () => {
  const labels = dayLabels(new Date(2026, 9, 17, 11).getTime())
  assert.equal(labels.length, 14)
  assert.equal(labels[13], 'today')
  assert.equal(labels[12], new Date(2026, 9, 16).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  assert.equal(labels[0], new Date(2026, 9, 4).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
})
