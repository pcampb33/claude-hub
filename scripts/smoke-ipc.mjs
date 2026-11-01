#!/usr/bin/env node
// Fast IPC-data smoke check. Imports the Electron-free domain modules
// directly (the same code the ipcMain handlers call) and asserts each returns
// a well-shaped value for the REAL registry — no Electron, no window, no
// renderer. A green run means the data layer the screenshot harness renders
// from is actually producing data.
//
// USAGE: node scripts/smoke-ipc.mjs
//
// Node runs these .ts files natively, so relative imports need explicit .ts
// extensions (Vite adds them transparently; Node does not — see CLAUDE.md).

import path from 'node:path'
import { fileURLToPath } from 'node:url'

// registry.ts et al. read process.env.APP_ROOT lazily; derive it from this
// script's location so the cwd of the caller is irrelevant.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.APP_ROOT = path.join(__dirname, '..')

const { listProjects } = await import('../electron/registry.ts')
const { listSessions } = await import('../electron/sessions.ts')
const { listSubagents } = await import('../electron/subagents.ts')
const { getProjectStatus } = await import('../electron/status.ts')
const { getFloorStatus } = await import('../electron/floor-core.ts')
const { getConfigHealth } = await import('../electron/config-health.ts')
const { getActivityHistory } = await import('../electron/activity-core.ts')

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    const value = await fn()
    console.log(`  PASS  ${name}`)
    passed++
    return value
  } catch (err) {
    console.log(`  FAIL  ${name}: ${err.message}`)
    failed++
    return undefined
  }
}

console.log('[smoke-ipc] Checking real domain modules against registry.json\n')

const projects = await check('registry.listProjects() → non-empty array', () => {
  const p = listProjects()
  if (!Array.isArray(p)) throw new Error('not an array')
  if (p.length === 0) throw new Error('empty registry')
  if (!p[0].id || !p[0].path) throw new Error('entry missing id/path')
  return p
})

const sample = projects?.[0]

await check('floor-core.getFloorStatus() → shaped report', () => {
  const r = getFloorStatus()
  if (!r || typeof r !== 'object') throw new Error('no report')
  if (!Array.isArray(r.projects)) throw new Error('missing projects[]')
  return r
})

await check('activity-core.getActivityHistory() → 14-day histories', async () => {
  const a = await getActivityHistory()
  if (!Array.isArray(a)) throw new Error('not an array')
  if (a.length && (!Array.isArray(a[0].days) || a[0].days.length !== 14))
    throw new Error('bad days shape (expected 14-element array)')
  return a
})

if (sample) {
  await check(`status.getProjectStatus("${sample.name ?? sample.id}") → shaped`, async () => {
    const s = await getProjectStatus(sample.path)
    if (!s || typeof s !== 'object') throw new Error('no status')
    return s
  })

  await check(`sessions.listSessions("${sample.name ?? sample.id}") → array`, async () => {
    const s = await listSessions(sample.path)
    if (!Array.isArray(s)) throw new Error('not an array')
    return s
  })

  // listSubagents needs a real session to aim at, and the sample project may
  // have none — walk the registry until one does. Guarding on the sample's own
  // sessions made this check silently no-op, which reads as a pass.
  await check('subagents.listSubagents(newest session in the registry) → array', async () => {
    for (const project of projects) {
      const [newest] = await listSessions(project.path)
      if (!newest) continue
      const subs = await listSubagents(project.path, newest.id)
      if (!Array.isArray(subs)) throw new Error('not an array')
      return subs
    }
    throw new Error('no session anywhere in the registry to probe')
  })

  await check(`config-health.getConfigHealth("${sample.name ?? sample.id}") → shaped`, () => {
    const h = getConfigHealth(sample.path)
    if (!h || typeof h !== 'object') throw new Error('no report')
    return h
  })
} else {
  console.log('  SKIP  per-project checks (no sample project)')
}

console.log(`\n[smoke-ipc] ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
