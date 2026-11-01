import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RegistryEntry, SkillUsage } from '../../../../../shared/ipc-types'
import { launchTargets, skillStat, topSkills } from './launch.ts'

const NOW = Date.parse('2026-10-17T12:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

function usage(skill: string, invs: [number, string, string | null][]): SkillUsage {
  const invocations = invs.map(([d, project, projectId]) => ({ ts: daysAgo(d), project, projectId, sessionId: 's' }))
  return { skill, count: invocations.length, lastUsed: invocations[0]?.ts ?? '', invocations }
}

test('30-day and all-time counts, projects busiest first, default project = most recent registered', () => {
  const s = skillStat(
    usage('handoff', [
      [1, 'scratch-dir', null],
      [2, 'sandbox', 'id-sandbox'],
      [10, 'sandbox', 'id-sandbox'],
      [45, 'claude-hub', 'id-hub'],
    ]),
    NOW,
  )
  assert.equal(s.uses30, 3)
  assert.equal(s.usesAll, 4)
  assert.deepEqual(s.projects, [
    { name: 'sandbox', count: 2 },
    { name: 'claude-hub', count: 1 },
    { name: 'scratch-dir', count: 1 },
  ])
  assert.equal(s.recentProjectId, 'id-sandbox')
})

test('top skills: only those used in 30 days, busiest first', () => {
  const top = topSkills(
    [usage('old', [[40, 'x', null]]), usage('a', [[1, 'x', null]]), usage('b', [[1, 'x', null], [2, 'x', null]])],
    NOW,
  )
  assert.deepEqual(
    top.map((s) => s.name),
    ['b', 'a'],
  )
})

test('launch targets: project-scoped entries pin the project, global or unknown run anywhere', () => {
  const projects = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] as RegistryEntry[]
  assert.deepEqual(
    launchTargets([{ projectId: 'p2' }], projects).map((p) => p.id),
    ['p2'],
  )
  assert.equal(launchTargets([{ projectId: 'p2' }, { projectId: null }], projects).length, 3)
  assert.equal(launchTargets([], projects).length, 3) // plugin skill: no entry on disk
})
