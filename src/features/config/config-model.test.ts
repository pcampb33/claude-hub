import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BoundaryAudit, BoundaryCrossing, ConfigLayer, GuardStatus } from '../../../shared/ipc-types'
import {
  addNeighbour,
  auditEmptyText,
  auditSummary,
  blockedNote,
  groupCrossings,
  groupTargets,
  guardButtons,
  layerIsEmpty,
  mixText,
  neighbourProblem,
  overriddenBy,
  parseTargetParam,
  sameNeighbours,
  serverOverriddenBy,
  settingsLocalPath,
  sortFindings,
  targetParam,
  unreadableNote,
} from './config-model.ts'

function layer(scope: ConfigLayer['scope'], over: Partial<ConfigLayer> = {}): ConfigLayer {
  return {
    scope,
    files: [],
    claudeMdTokens: null,
    model: null,
    permissions: null,
    hooks: [],
    mcpServers: [],
    skills: [],
    agents: [],
    commands: [],
    workflows: [],
    ...over,
  }
}

const perms = (defaultMode: string | null) => ({ defaultMode, allow: [], ask: [], deny: [] })

test('target params round-trip and reject junk', () => {
  const ref = { kind: 'experiment' as const, key: 'my:exp' }
  assert.deepEqual(parseTargetParam(targetParam(ref)), ref)
  assert.equal(parseTargetParam('nope:x'), null)
  assert.equal(parseTargetParam('project:'), null)
  assert.equal(parseTargetParam(null), null)
})

test('targets group projects before experiments, alphabetical, filtered', () => {
  const t = (kind: 'project' | 'experiment', name: string) => ({ kind, key: name, name, lastActivityIso: null })
  const g = groupTargets([t('experiment', 'zeta'), t('project', 'beta'), t('project', 'Alpha'), t('experiment', 'alpha-exp')], '')
  assert.deepEqual(g.projects.map((x) => x.name), ['Alpha', 'beta'])
  assert.deepEqual(g.experiments.map((x) => x.name), ['alpha-exp', 'zeta'])
  assert.deepEqual(groupTargets([t('project', 'beta'), t('project', 'Alpha')], 'ALP').projects.map((x) => x.name), ['Alpha'])
})

test('a scalar set in a later layer overrides the earlier one', () => {
  const layers = [layer('global', { model: 'opus' }), layer('project'), layer('local', { model: 'sonnet' })]
  assert.equal(overriddenBy(layers, 'global', 'model'), 'local')
  assert.equal(overriddenBy(layers, 'local', 'model'), null)
  assert.equal(overriddenBy(layers, 'project', 'model'), null, 'unset in this layer: nothing to override')
})

test('the last layer wins when several later layers set it', () => {
  const layers = [layer('global', { permissions: perms('auto') }), layer('project', { permissions: perms('plan') }), layer('local', { permissions: perms('default') })]
  assert.equal(overriddenBy(layers, 'global', 'defaultMode'), 'local')
  assert.equal(overriddenBy(layers, 'project', 'defaultMode'), 'local')
  const noMode = [layer('global', { permissions: perms('auto') }), layer('project', { permissions: perms(null) })]
  assert.equal(overriddenBy(noMode, 'global', 'defaultMode'), null, 'a permissions block without defaultMode overrides nothing')
})

test('same-named MCP servers are overridden by the later layer', () => {
  const srv = (name: string) => ({ name, target: 'npx x', enabled: null })
  const layers = [layer('global', { mcpServers: [srv('ruflo'), srv('other')] }), layer('project', { mcpServers: [srv('ruflo')] }), layer('local')]
  assert.equal(serverOverriddenBy(layers, 'global', 'ruflo'), 'project')
  assert.equal(serverOverriddenBy(layers, 'global', 'other'), null)
})

test('layerIsEmpty: a missing file and no settings is empty; an unreadable file is not', () => {
  assert.equal(layerIsEmpty(layer('local', { files: [{ label: 'settings.local.json', path: 'x', exists: false, error: null }] })), true)
  assert.equal(layerIsEmpty(layer('local', { files: [{ label: 'settings.local.json', path: 'x', exists: false, error: 'EACCES' }] })), false)
  assert.equal(layerIsEmpty(layer('local', { skills: ['a'] })), false)
})

test('findings: warn first, order kept within a severity', () => {
  const f = sortFindings([
    { severity: 'info' as const, text: 'i1' },
    { severity: 'warn' as const, text: 'w1' },
    { severity: 'info' as const, text: 'i2' },
    { severity: 'warn' as const, text: 'w2' },
  ])
  assert.deepEqual(f.map((x) => x.text), ['w1', 'w2', 'i1', 'i2'])
})

test('settingsLocalPath prefers the report path, else names the folder', () => {
  const report = {
    target: { kind: 'project' as const, key: 'p' },
    layers: [layer('local', { files: [{ label: 'settings.local.json', path: 'C:\\p\\.claude\\settings.local.json', exists: true, error: null }] })],
    findings: [],
    error: null,
  }
  assert.equal(settingsLocalPath(report, 'p'), 'C:\\p\\.claude\\settings.local.json')
  assert.equal(settingsLocalPath(null, 'trading-bot'), 'trading-bot\\.claude\\settings.local.json')
})

// ---- neighbours

test('neighbour editor: no self, no duplicates', () => {
  const self = { kind: 'project' as const, key: 'v3' }
  const v2 = { kind: 'project' as const, key: 'v2' }
  assert.equal(neighbourProblem(self, [], self), "A project can't be its own neighbour")
  const one = addNeighbour(self, [], v2, 'write')
  assert.deepEqual(one, [{ target: v2, access: 'write' }])
  assert.equal(neighbourProblem(self, one, v2), 'Already listed')
  assert.equal(addNeighbour(self, one, v2), one, 'a duplicate add is a no-op')
  assert.equal(addNeighbour(self, one, self), one, 'a self add is a no-op')
  assert.equal(neighbourProblem(self, one, { kind: 'experiment', key: 'v2' }), null, 'same key, other kind is a different target')
})

test('sameNeighbours ignores order but not access', () => {
  const a = { target: { kind: 'project' as const, key: 'a' }, access: 'read' as const }
  const b = { target: { kind: 'project' as const, key: 'b' }, access: 'write' as const }
  assert.equal(sameNeighbours([a, b], [b, a]), true)
  assert.equal(sameNeighbours([a], [{ ...a, access: 'write' }]), false)
  assert.equal(sameNeighbours([a], [a, b]), false)
})

// ---- guard buttons

const guard = (localSettings: GuardStatus['localSettings']): GuardStatus => ({ desktopLaunch: true, localSettings, covers: 'file tools only' })

test('guard write: guarded + absent is enabled; audit, dirty or busy is not', () => {
  assert.deepEqual(guardButtons('guarded', guard('absent'), false, false), {
    write: { label: 'Write guard to settings.local.json', enabled: true, reason: null },
    remove: null,
  })
  assert.equal(guardButtons('audit', guard('absent'), false, false).write?.enabled, false)
  assert.equal(guardButtons('guarded', guard('absent'), true, false).write?.reason, 'Save the boundary first')
  assert.equal(guardButtons('guarded', guard('absent'), false, true).write?.enabled, false)
})

test('guard stale offers Refresh and Remove; current offers only Remove', () => {
  const stale = guardButtons('guarded', guard('stale'), false, false)
  assert.equal(stale.write?.label, 'Refresh guard')
  assert.equal(stale.write?.enabled, true)
  assert.equal(stale.remove?.enabled, true)
  const current = guardButtons('guarded', guard('current'), false, false)
  assert.equal(current.write, null)
  assert.equal(current.remove?.enabled, true)
})

test('unrecorded hub-shaped rules: writing still works, removing is refused and says why', () => {
  const b = guardButtons('guarded', guard('unrecorded'), false, false)
  assert.equal(b.write?.enabled, true)
  assert.equal(b.remove?.enabled, false)
  assert.match(b.remove?.reason ?? '', /no record/)
})

test('remove stays available after switching to audit; unreadable disables both', () => {
  assert.equal(guardButtons('audit', guard('current'), false, false).remove?.enabled, true)
  assert.equal(guardButtons('audit', guard('stale'), false, false).write?.enabled, false)
  const u = guardButtons('guarded', guard('unreadable'), false, false)
  assert.equal(u.write?.enabled, false)
  assert.equal(u.remove?.enabled, false)
  assert.match(u.write?.reason ?? '', /couldn't be read/)
})

// ---- audit

function crossing(over: Partial<BoundaryCrossing>): BoundaryCrossing {
  return { sessionId: 's1', at: '2026-10-17T10:00:00Z', tool: 'Bash', access: 'shell', detail: 'ls', into: 'trading-bot-v2', ...over }
}

function audit(crossings: BoundaryCrossing[], over: Partial<BoundaryAudit> = {}): BoundaryAudit {
  return {
    target: { kind: 'project', key: 'v3' },
    sinceIso: '2026-09-17T00:00:00Z',
    sessionsScanned: 5,
    sessionsUnreadable: 0,
    crossings,
    total: crossings.length,
    blocked: 0,
    error: null,
    ...over,
  }
}

test('crossings group by destination, biggest first, newest first inside', () => {
  const groups = groupCrossings([
    crossing({ into: 'vault', access: 'read', at: '2026-10-10T00:00:00Z' }),
    crossing({ at: '2026-10-01T00:00:00Z' }),
    crossing({ at: '2026-10-15T00:00:00Z', access: 'read', tool: 'Read' }),
  ])
  assert.deepEqual(groups.map((g) => [g.into, g.count]), [['trading-bot-v2', 2], ['vault', 1]])
  assert.deepEqual(groups[0].crossings.map((c) => c.at), ['2026-10-15T00:00:00Z', '2026-10-01T00:00:00Z'])
  assert.deepEqual(groups[0].mix, { read: 1, write: 0, shell: 1 })
})

test('mixText: one kind bare, several counted biggest first', () => {
  assert.equal(mixText({ read: 0, write: 0, shell: 4 }), '(shell)')
  assert.equal(mixText({ read: 7, write: 0, shell: 12 }), '(12 shell, 7 read)')
})

test('summary line counts crossings, sessions and destinations', () => {
  const a = audit([
    crossing({ sessionId: 's1' }),
    crossing({ sessionId: 's2' }),
    crossing({ sessionId: 's2', into: 'vault', access: 'read' }),
  ])
  assert.equal(auditSummary(a), '3 crossings in 2 sessions — 2 into trading-bot-v2 (shell), 1 into vault (read)')
  assert.equal(auditSummary(audit([])), null)
})

test('summary says when the list is capped below the total', () => {
  const a = audit([crossing({})], { total: 250 })
  assert.equal(auditSummary(a), '250 crossings in at least 1 session — 1 into trading-bot-v2 (shell) (newest 1 listed)')
})

test('summary folds destinations past three', () => {
  const a = audit(['a', 'b', 'c', 'd', 'e'].map((into) => crossing({ into })))
  assert.match(auditSummary(a) ?? '', /, and 2 more$/)
})

test('zero state claims no crossings only when sessions were read', () => {
  assert.equal(auditEmptyText(audit([]), 30), 'No crossings in the last 30 days')
  assert.equal(auditEmptyText(audit([], { sessionsScanned: 0 }), 7), 'No sessions in the last 7 days')
  // A failed or unreadable scan never reads as "no sessions".
  assert.equal(auditEmptyText(audit([], { sessionsScanned: 0, error: 'EACCES' }), 7), "Couldn't audit the last 7 days")
  assert.equal(auditEmptyText(audit([], { error: 'EACCES' }), 7), 'No crossings in the sessions that could be read')
  assert.equal(auditEmptyText(audit([], { sessionsScanned: 0, sessionsUnreadable: 2 }), 7), 'No readable sessions in the last 7 days')
  assert.equal(unreadableNote(audit([], { sessionsUnreadable: 1 })), "1 transcript couldn't be read; the audit may be incomplete.")
  assert.equal(unreadableNote(audit([])), null)
})

test('blocked attempts are reported apart from crossings', () => {
  assert.equal(blockedNote(audit([], { blocked: 1 })), "1 attempt outside the boundary was refused (a deny rule, the classifier or you at the prompt) and didn't run.")
  assert.equal(blockedNote(audit([], { blocked: 3 })), "3 attempts outside the boundary were refused (a deny rule, the classifier or you at the prompt) and didn't run.")
  assert.equal(blockedNote(audit([])), null)
})
