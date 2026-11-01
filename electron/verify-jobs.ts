import type { VerifyJob } from '../shared/ipc-types'

// Central registry for Run-verify background runs — the floor counterpart of
// sandbox-jobs.ts. Before this, the only record of a running verify was one
// renderer card's local state: navigating away made a minutes-long spawn
// invisible and nothing could cancel it. run-verify.ts drives the lifecycle;
// main.ts wires onVerifyJobsChanged to webContents.send.
// Electron-free, same split as sandbox-jobs.ts.

const OUTPUT_TAIL_CHARS = 4000

// A verify chain streams hundreds of stdout chunks; one push per chunk would
// spam webContents.send. Output-only changes
// coalesce into at most one notify per window; start/end still push instantly.
const NOTIFY_THROTTLE_MS = 250

interface ManagedVerifyJob {
  job: VerifyJob
  // Tree-kills the run's process tree (shell:true means the child pid is
  // cmd.exe — a plain kill would orphan the npm/node grandchildren).
  kill: (() => void) | null
  cancelled: boolean
}

const jobs = new Map<string, ManagedVerifyJob>()
let nextId = 1
let notify: (jobs: VerifyJob[]) => void = () => {}
let throttleTimer: ReturnType<typeof setTimeout> | null = null

export function onVerifyJobsChanged(listener: (jobs: VerifyJob[]) => void): void {
  notify = listener
}

export function listVerifyJobs(): VerifyJob[] {
  return [...jobs.values()].map((m) => m.job)
}

export function findVerifyJobByProjectId(projectId: string): VerifyJob | undefined {
  return listVerifyJobs().find((j) => j.projectId === projectId)
}

function notifyNow(): void {
  if (throttleTimer) {
    clearTimeout(throttleTimer)
    throttleTimer = null
  }
  notify(listVerifyJobs())
}

function notifyThrottled(): void {
  if (throttleTimer) return
  throttleTimer = setTimeout(() => {
    throttleTimer = null
    notify(listVerifyJobs())
  }, NOTIFY_THROTTLE_MS)
}

export function startVerifyJob(projectId: string, projectName: string, command: string): string {
  const id = `verify-job-${nextId++}`
  jobs.set(id, {
    job: { id, projectId, projectName, command, startedAt: new Date().toISOString(), outputTail: '' },
    kill: null,
    cancelled: false,
  })
  notifyNow()
  return id
}

export function appendVerifyOutput(id: string, chunk: string): void {
  const managed = jobs.get(id)
  if (!managed) return // straggler write after the run ended — drop it
  managed.job = { ...managed.job, outputTail: (managed.job.outputTail + chunk).slice(-OUTPUT_TAIL_CHARS) }
  notifyThrottled()
}

export function setVerifyJobKiller(id: string, kill: (() => void) | null): void {
  const managed = jobs.get(id)
  if (managed) managed.kill = kill
}

// Checked by run-verify when the child dies, to tell "user cancelled" apart
// from a real red run — must be read before endVerifyJob drops the record.
export function wasVerifyJobCancelled(id: string): boolean {
  return jobs.get(id)?.cancelled ?? false
}

export function endVerifyJob(id: string): void {
  if (jobs.delete(id)) notifyNow()
}

// Marks the job cancelled and tree-kills its process; the job leaves the
// registry when run-verify observes the death and reaches endVerifyJob.
export function cancelVerifyJob(id: string): boolean {
  const managed = jobs.get(id)
  if (!managed) return false
  managed.cancelled = true
  managed.kill?.()
  return true
}
