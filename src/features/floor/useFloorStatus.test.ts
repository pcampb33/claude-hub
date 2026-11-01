import test from 'node:test'
import assert from 'node:assert/strict'
import { FLOOR_STALE_MS, floorState } from './useFloorStatus.ts'
import type { ProjectFloorStatus } from '../../../shared/ipc-types.ts'

const NOW = new Date('2026-08-23T12:00:00.000Z').getTime()

function project(latest: { ok: boolean; agoMs: number } | null): ProjectFloorStatus {
  return {
    id: 'a',
    name: 'demo',
    path: 'C:\\projects\\demo',
    verifyCommand: 'npm test',
    latest: latest && {
      v: 1,
      projectPath: 'C:\\projects\\demo',
      timestamp: new Date(NOW - latest.agoMs).toISOString(),
      ok: latest.ok,
      exitCode: latest.ok ? 0 : 1,
      durationMs: 1000,
      command: 'npm test',
    },
    streakDays: latest ? 1 : null,
    days: [],
  }
}

test('a configured floor that has never run is unverified, not green', () => {
  assert.equal(floorState(project(null), NOW), 'unverified')
})

test('a failing run is red', () => {
  assert.equal(floorState(project({ ok: false, agoMs: 60_000 }), NOW), 'red')
})

test('a recent passing run is green', () => {
  assert.equal(floorState(project({ ok: true, agoMs: 60_000 }), NOW), 'green')
})

test('a passing run nobody has repeated since the window is unverified', () => {
  // The bug this rule exists for: one green run in July still read as "green"
  // on the dashboard in late August, because the only test was latest.ok.
  assert.equal(floorState(project({ ok: true, agoMs: FLOOR_STALE_MS + 1000 }), NOW), 'unverified')
  assert.equal(floorState(project({ ok: true, agoMs: 42 * 24 * 60 * 60 * 1000 }), NOW), 'unverified')
})

test('the window boundary itself still counts as green', () => {
  assert.equal(floorState(project({ ok: true, agoMs: FLOOR_STALE_MS }), NOW), 'green')
})

test('a red run stays red however old it is — staleness never launders a failure', () => {
  assert.equal(floorState(project({ ok: false, agoMs: 90 * 24 * 60 * 60 * 1000 }), NOW), 'red')
})
