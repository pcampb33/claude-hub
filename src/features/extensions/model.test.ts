import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ExtensionItem, ExtensionsSnapshot } from '../../../shared/ipc-types'
import { bucketOf, cliCommand, compactTokens, explain, kpis, originLabel, statusLabel, visibleItems } from './model.ts'

function item(over: Partial<ExtensionItem>): ExtensionItem {
  return {
    id: 'mcp:x',
    kind: 'mcp',
    name: 'x',
    scope: 'user',
    status: 'connected',
    statusText: 'Connected',
    target: null,
    pluginId: null,
    projectPath: null,
    usage: { calls: 0, lastUsedIso: null, topTools: [] },
    alwaysOnTokens: null,
    components: [],
    ...over,
  }
}

function snap(items: ExtensionItem[], over: Partial<ExtensionsSnapshot> = {}): ExtensionsSnapshot {
  return {
    items,
    health: { state: 'ok', checkedAtIso: '2026-10-17T10:00:00Z', error: null },
    usage: { state: 'ok', error: null, sinceIso: '2026-09-17T10:00:00Z' },
    generatedAtIso: '2026-10-17T10:00:00Z',
    ...over,
  }
}

const ITEMS = [
  item({ id: 'mcp:playwright', name: 'playwright', usage: { calls: 900, lastUsedIso: 't', topTools: [] } }),
  item({ id: 'mcp:dc', name: 'desktop-control', usage: { calls: 90, lastUsedIso: 't', topTools: [] } }),
  item({ id: 'connector:g', kind: 'connector', name: 'Gmail', usage: { calls: 10, lastUsedIso: 't', topTools: [] } }),
  item({ id: 'plugin:design@synced', kind: 'plugin', name: 'design', scope: 'synced', status: 'enabled', statusText: null, pluginId: 'design@synced', alwaysOnTokens: 619 }),
  item({ id: 'mcp:plugin:design:slack', name: 'slack', scope: 'plugin', status: 'needs-auth', statusText: 'Needs authentication', pluginId: 'design@synced' }),
  item({ id: 'mcp:weird', name: 'weird', status: 'unknown', statusText: 'Sleeping' }),
  item({ id: 'connector:s', kind: 'connector', name: 'Stripe', status: 'not-listed', statusText: null }),
  item({ id: 'mcp:local:C:/p/bb:svg', name: 'svg', scope: 'local', status: 'unchecked', statusText: null, projectPath: 'C:/p/bb' }),
]

test('bucketOf: calls win, then loaded, then broken (incl. unknown), else off', () => {
  assert.deepEqual(
    ITEMS.map(bucketOf),
    ['work', 'work', 'work', 'idle', 'broken', 'broken', 'off', 'off'],
  )
  // A connected server whose usage couldn't be scanned is never "work".
  assert.equal(bucketOf(item({ usage: null })), 'idle')
})

test('labels prefer the CLI words and say where things come from', () => {
  assert.equal(statusLabel(ITEMS[4]), 'Needs authentication')
  assert.equal(statusLabel(ITEMS[6]), 'Not offered now')
  assert.equal(originLabel(ITEMS[4]), 'plugin · design')
  assert.equal(originLabel(ITEMS[7]), 'local · bb')
  assert.equal(originLabel(item({ kind: 'plugin', scope: 'project', projectPath: 'C:\\a\\one; C:\\b\\two' })), 'project · one + two')
  assert.equal(compactTokens(1576), '1.6k')
  assert.equal(compactTokens(873), '873')
})

test('kpis count from the data and refuse to claim what was not checked', () => {
  const k = kpis(snap(ITEMS))
  assert.deepEqual(k.map((x) => x.value), [3, 1, 2, 2])
  assert.match(k[0].sub, /1,000 tool calls in 30 days; playwright and desktop-control make 99%/)
  assert.match(k[1].sub, /1 plugin add ~619 tokens/)
  assert.match(k[2].sub, /1 wait for a sign-in, 1 unrecognised/)

  const unchecked = kpis(snap(ITEMS, { health: { state: 'running', checkedAtIso: null, error: null } }))
  assert.equal(unchecked[2].value, null)
  assert.equal(unchecked[2].sub, 'checking servers…')
  const failed = kpis(snap(ITEMS, { health: { state: 'error', checkedAtIso: 't', error: 'timed out' } }))
  assert.equal(failed[2].value, null)

  const noUsage = kpis(snap(ITEMS, { usage: { state: 'error', error: 'x', sinceIso: null, running: true } }))
  assert.equal(noUsage[0].value, null)
  assert.equal(noUsage[1].label, 'Loaded, usage unknown')
  assert.equal(noUsage[0].sub, 'scanning transcripts…')
})

test('visibleItems filters by type and bucket, most-used first', () => {
  assert.deepEqual(visibleItems(ITEMS, 'all', 'work').map((i) => i.name), ['playwright', 'desktop-control', 'Gmail'])
  assert.deepEqual(visibleItems(ITEMS, 'connector', null).map((i) => i.name), ['Gmail', 'Stripe'])
})

test('explain and cliCommand stay within what is known', () => {
  assert.match(explain(ITEMS[4], snap(ITEMS)), /disabling the design plugin/)
  assert.match(explain(ITEMS[7], snap(ITEMS)), /only health-checked inside their own project/)
  const failedSnap = snap(ITEMS, { health: { state: 'error', checkedAtIso: null, error: 'boom' } })
  assert.match(explain(item({ status: 'unchecked', statusText: null }), failedSnap), /health check failed \(boom\)/)
  assert.equal(cliCommand(item({ name: 'google calendar' })), 'claude mcp remove "google calendar" -s user')
  assert.equal(cliCommand(ITEMS[4]), 'claude plugin disable design@synced')
  assert.equal(cliCommand(ITEMS[2]), null)
})
