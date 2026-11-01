#!/usr/bin/env node
// Main-thread budget: how long each read-only IPC handler, and the live sweep,
// holds the Electron main thread against the REAL ~/.claude data. A window goes
// "Not responding" after ~5s without pumping messages; handlers that each block
// a few hundred ms stack into that when a view fires them together (2026-10-20:
// a 1MB-per-file head probe in the live sweep, a sync PowerShell on Home).
//
// USAGE: node scripts/main-thread-budget.mjs [budgetMs=250]
// Exit 1 if anything blocks longer than the budget.
//
// It never touches the running app's state: APP_ROOT is a temp copy holding only
// registry.json, so every cache the handlers write lands there (and each cache
// is measured cold, the first-launch worst case). Handlers with side effects
// are not called: getExtensions (its re-check spawns every MCP server), getDesktop
// (attaches to the session host), and anything that writes, launches or spawns.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const budgetMs = Number(process.argv[2] ?? 250)
// registry.json is gitignored: a worktree reads it from APP_ROOT when set.
const registrySource = path.join(process.env.APP_ROOT ?? repoRoot, 'registry.json')
const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'main-thread-budget-'))
fs.copyFileSync(registrySource, path.join(appRoot, 'registry.json'))
process.env.APP_ROOT = appRoot

const load = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href)
const { hubService } = await load('electron/hub-service.ts')
const { IPC_CHANNELS } = await load('shared/ipc-types.ts')
const { computeStatuses } = await load('electron/live-core.ts')
const call = (name, ...args) => hubService[IPC_CHANNELS[name]](...args)

// The longest gap between 10ms ticks is the longest synchronous block.
let maxBlock = 0
let last = performance.now()
const ticker = setInterval(() => {
  const now = performance.now()
  maxBlock = Math.max(maxBlock, now - last - 10)
  last = now
}, 10)
const settle = (ms) => new Promise((r) => setTimeout(r, ms))

const rows = []
async function measure(name, fn, timeoutMs = 120_000) {
  await settle(30)
  maxBlock = 0
  last = performance.now()
  const start = performance.now()
  let note = ''
  try {
    // Some handlers are sync: Promise.resolve().then() runs them either way.
    const done = Promise.resolve().then(fn).then(() => 'done')
    const outcome = await Promise.race([done, settle(timeoutMs).then(() => 'timeout')])
    if (outcome === 'timeout') note = `still running after ${timeoutMs / 1000}s (async; block so far)`
  } catch (err) {
    note = `threw: ${String(err?.message ?? err).split('\n')[0].slice(0, 80)}`
  }
  await settle(30) // let the ticker observe a block that ended the call
  rows.push({ name, wallMs: Math.round(performance.now() - start), blockMs: Math.round(maxBlock), note })
}

const projects = await call('listProjects')
const live = { computeStatuses: async () => computeStatuses() }
await measure('live sweep (cold)', live.computeStatuses)
await measure('live sweep (warm)', live.computeStatuses)
for (const name of [
  'listProjects', 'listAllSessions', 'getVaultInfo', 'getVaultGraph', 'getVaultInbox', 'listSkills',
  'getSkillUsage', 'listWorkflows', 'listWorkflowTemplates', 'listExperiments', 'listSandboxJobs',
  'getCrossProjectRedundancy', 'getFloorStatus', 'listVerifyJobs', 'getRecallScorecard', 'getJobFreshness',
  'getGlobalConfig', 'latestSessionPerProject', 'getActivityHistory', 'getLiveStatus', 'listDesktopTargets',
  'getRubric',
]) {
  await measure(name, () => call(name))
}
await measure('getUsage(day, 30)', () => call('getUsage', { granularity: 'day', periods: 30 }))
await measure('searchSessions("worktree")', () => call('searchSessions', 'worktree'))
for (const p of projects) {
  await measure(`getProjectStatus(${p.name})`, () => call('getProjectStatus', p.path))
  await measure(`listSessions(${p.name})`, () => call('listSessions', p.path))
  await measure(`getConfigHealth(${p.name})`, () => call('getConfigHealth', p.path))
  const target = { kind: 'project', key: p.id }
  await measure(`getProjectConfig(${p.name})`, () => call('getProjectConfig', target))
  await measure(`auditBoundary(${p.name}, 30d)`, () => call('auditBoundary', target, 30))
}
clearInterval(ticker)

rows.sort((a, b) => b.blockMs - a.blockMs)
const over = rows.filter((r) => r.blockMs > budgetMs)
for (const r of rows) {
  const flag = r.blockMs > budgetMs ? 'OVER' : '    '
  console.log(`${flag} ${String(r.blockMs).padStart(6)} ms block ${String(r.wallMs).padStart(7)} ms wall  ${r.name}${r.note ? '  - ' + r.note : ''}`)
}
console.log(`\n${over.length} of ${rows.length} over the ${budgetMs}ms budget. Temp APP_ROOT: ${appRoot}`)
fs.rmSync(appRoot, { recursive: true, force: true })
process.exit(over.length ? 1 : 0)
