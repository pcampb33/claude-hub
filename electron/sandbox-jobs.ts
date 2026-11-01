import type { SandboxJob, SandboxJobPhase } from '../shared/ipc-types'

// Central registry for Draft Learnings background jobs. Draft runs two
// sequential multi-ten-second `claude -p` subprocesses in the main process;
// before this registry the only record was component-local state on one
// renderer card, so navigating away made a running job invisible and nothing
// could cancel it. Electron-free — main.ts wires onJobsChanged to
// webContents.send, the same split as live.ts's push surface.

interface ManagedJob {
  job: SandboxJob
  // Kills the job's *current* subprocess — swapped when the draft call ends
  // and the summarize call starts. Null between calls.
  kill: (() => void) | null
  cancelled: boolean
}

const jobs = new Map<string, ManagedJob>()
let nextId = 1
let notify: (jobs: SandboxJob[]) => void = () => {}

export function onJobsChanged(listener: (jobs: SandboxJob[]) => void): void {
  notify = listener
}

export function listJobs(): SandboxJob[] {
  return [...jobs.values()].map((m) => m.job)
}

export function findJobByPath(experimentPath: string): SandboxJob | undefined {
  return listJobs().find((j) => j.experimentPath === experimentPath)
}

export function startJob(experimentPath: string, experimentName: string): string {
  const id = `sandbox-job-${nextId++}`
  jobs.set(id, {
    job: { id, experimentPath, experimentName, phase: 'drafting', startedAt: new Date().toISOString() },
    kill: null,
    cancelled: false,
  })
  notify(listJobs())
  return id
}

export function setJobPhase(id: string, phase: SandboxJobPhase): void {
  const managed = jobs.get(id)
  if (!managed) return
  managed.job = { ...managed.job, phase }
  notify(listJobs())
}

export function setJobKiller(id: string, kill: (() => void) | null): void {
  const managed = jobs.get(id)
  if (managed) managed.kill = kill
}

// Checked by draftLearnings when a subprocess dies, to tell "user cancelled"
// apart from "claude failed" — must be read before endJob drops the record.
export function wasCancelled(id: string): boolean {
  return jobs.get(id)?.cancelled ?? false
}

export function endJob(id: string): void {
  if (jobs.delete(id)) notify(listJobs())
}

// Marks the job cancelled and kills its current subprocess; the job leaves
// the registry when draftLearnings observes the death and reaches endJob.
export function cancelJob(id: string): boolean {
  const managed = jobs.get(id)
  if (!managed) return false
  managed.cancelled = true
  managed.kill?.()
  return true
}
