import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  startJob,
  listJobs,
  findJobByPath,
  setJobPhase,
  setJobKiller,
  endJob,
  cancelJob,
  wasCancelled,
  onJobsChanged,
} from './sandbox-jobs.ts'

// The registry is a module-level singleton, so tests always end their own
// jobs and assert by id rather than assuming the map starts empty.

test('startJob registers a drafting job and endJob removes it', () => {
  const id = startJob('C:\\sandbox\\exp-a', 'exp-a')
  const job = listJobs().find((j) => j.id === id)
  assert.ok(job)
  assert.equal(job.phase, 'drafting')
  assert.equal(job.experimentName, 'exp-a')

  endJob(id)
  assert.equal(listJobs().some((j) => j.id === id), false)
})

test('setJobPhase updates the job and findJobByPath locates it', () => {
  const id = startJob('C:\\sandbox\\exp-b', 'exp-b')
  setJobPhase(id, 'summarizing')
  assert.equal(findJobByPath('C:\\sandbox\\exp-b')?.phase, 'summarizing')
  endJob(id)
})

test('cancelJob kills the current subprocess and marks the job cancelled', () => {
  const id = startJob('C:\\sandbox\\exp-c', 'exp-c')
  let killed = 0
  setJobKiller(id, () => killed++)

  assert.equal(cancelJob(id), true)
  assert.equal(killed, 1)
  assert.equal(wasCancelled(id), true)

  endJob(id)
  assert.equal(wasCancelled(id), false) // record gone — reads as not-cancelled
})

test('cancelJob on an unknown or finished job is a no-op returning false', () => {
  assert.equal(cancelJob('sandbox-job-does-not-exist'), false)
})

test('job changes notify the listener with the full current list', () => {
  const seen: number[] = []
  onJobsChanged((jobs) => seen.push(jobs.length))

  const id = startJob('C:\\sandbox\\exp-d', 'exp-d')
  setJobPhase(id, 'summarizing')
  endJob(id)
  onJobsChanged(() => {})

  // start, phase change, end — three notifications, ending one shorter.
  assert.equal(seen.length, 3)
  assert.equal(seen[2], seen[0] - 1)
})
