// Runs a project's verifyCommand and records the result to the verify ledger —
// the main-process side of the Projects-tab "Run verify" CTA. Electron-free
// (child_process only), so it composes like the other domain modules.
//
// Spawns ASYNC, never execSync: a synchronous child-process call here would
// block Electron's single-threaded main process for the whole verify chain
// (lint + typecheck + test — tens of seconds), freezing IPC/UI in every
// window. Same lesson electron/sandbox.ts records for its Claude-review spawn.
//
// shell:true is safe here for the same reason scripts/record-verify.mjs's
// execSync is: the command string comes from RegistryEntry.verifyCommand
// (machine-local registry.json config, resolved here by registry id). Since
// 2026-07-17 the renderer CAN set that field via setVerifyCommand, so this is
// renderer-influenced — but that was a deliberate exposure (the renderer
// already holds equivalent spawn powers through the launch actions).
import { spawn } from 'node:child_process'
import { listProjects } from './registry.ts'
import { appendVerifyRun, getFloorStatus, makeVerifyRunRecord } from './floor-core.ts'
import {
  appendVerifyOutput,
  endVerifyJob,
  findVerifyJobByProjectId,
  setVerifyJobKiller,
  startVerifyJob,
  wasVerifyJobCancelled,
} from './verify-jobs.ts'
import type { FloorStatusReport } from '../shared/ipc-types.ts'

const VERIFY_TIMEOUT_MS = 10 * 60 * 1000

export async function runVerify(id: string): Promise<FloorStatusReport> {
  const entry = listProjects().find((e) => e.id === id)
  if (!entry) throw new Error(`No registered project with id "${id}"`)
  if (!entry.verifyCommand) throw new Error(`"${entry.name}" has no verifyCommand configured`)
  // One run per project at a time — the verify-jobs registry is the in-flight
  // record, so a second click while a run is live is a no-op and racing writes
  // never land on the same project's append-only ledger. Atomic: no await
  // between this check and startVerifyJob below.
  if (findVerifyJobByProjectId(id)) return getFloorStatus()

  const command = entry.verifyCommand
  const startedAt = Date.now()
  const jobId = startVerifyJob(id, entry.name, command)
  try {
    const { ok, exitStatus } = await new Promise<{ ok: boolean; exitStatus: number | null }>((resolve) => {
      // stdin ignored (a verify chain prompting for input is already hung);
      // stdout/stderr piped into the job's bounded tail for the live UI.
      const child = spawn(command, { cwd: entry.path, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      // shell:true means child.pid is the cmd.exe wrapper — child.kill() would
      // orphan the npm/node grandchildren (who'd also hold the pipes open and
      // stall 'close'), so cancel AND timeout both tree-kill via taskkill
      // (Windows-only, like the rest of this app's hardcoded paths).
      const killTree = () => {
        if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      }
      setVerifyJobKiller(jobId, killTree)
      const timer = setTimeout(killTree, VERIFY_TIMEOUT_MS)
      const finish = (result: { ok: boolean; exitStatus: number | null }) => {
        clearTimeout(timer)
        resolve(result)
      }
      child.stdout.setEncoding('utf-8')
      child.stderr.setEncoding('utf-8')
      child.stdout.on('data', (chunk: string) => appendVerifyOutput(jobId, chunk))
      child.stderr.on('data', (chunk: string) => appendVerifyOutput(jobId, chunk))
      child.on('error', () => finish({ ok: false, exitStatus: null }))
      child.on('close', (code) => finish({ ok: code === 0, exitStatus: code }))
    })
    // A cancelled run is a user abort, not a red verify — leave the ledger
    // alone. A timeout kill is NOT a cancel and records red, as before.
    if (!wasVerifyJobCancelled(jobId)) {
      appendVerifyRun(
        makeVerifyRunRecord({
          projectPath: entry.path,
          ok,
          exitStatus,
          durationMs: Date.now() - startedAt,
          command,
          timestamp: new Date().toISOString(),
        }),
      )
    }
  } finally {
    endVerifyJob(jobId)
  }
  return getFloorStatus()
}
