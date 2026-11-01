import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  startVerifyJob,
  listVerifyJobs,
  findVerifyJobByProjectId,
  appendVerifyOutput,
  setVerifyJobKiller,
  endVerifyJob,
  cancelVerifyJob,
  wasVerifyJobCancelled,
  onVerifyJobsChanged,
} from './verify-jobs.ts'

// The registry is a module-level singleton, so tests always end their own
// jobs and assert by id rather than assuming the map starts empty.

test('startVerifyJob registers a job and endVerifyJob removes it', () => {
  const id = startVerifyJob('proj-a', 'Project A', 'npm test')
  const job = listVerifyJobs().find((j) => j.id === id)
  assert.ok(job)
  assert.equal(job.projectName, 'Project A')
  assert.equal(job.command, 'npm test')
  assert.equal(job.outputTail, '')
  assert.equal(findVerifyJobByProjectId('proj-a')?.id, id)

  endVerifyJob(id)
  assert.equal(listVerifyJobs().some((j) => j.id === id), false)
  assert.equal(findVerifyJobByProjectId('proj-a'), undefined)
})

test('appendVerifyOutput accumulates chunks and keeps only the bounded tail', () => {
  const id = startVerifyJob('proj-b', 'Project B', 'npm test')
  appendVerifyOutput(id, 'a'.repeat(3000))
  appendVerifyOutput(id, 'b'.repeat(3000))
  const tail = listVerifyJobs().find((j) => j.id === id)?.outputTail
  assert.equal(tail?.length, 4000)
  assert.ok(tail.endsWith('b'.repeat(3000)))
  endVerifyJob(id)
})

test('cancelVerifyJob kills the process and marks the job cancelled', () => {
  const id = startVerifyJob('proj-c', 'Project C', 'npm test')
  let killed = 0
  setVerifyJobKiller(id, () => killed++)

  assert.equal(cancelVerifyJob(id), true)
  assert.equal(killed, 1)
  assert.equal(wasVerifyJobCancelled(id), true)

  endVerifyJob(id)
  assert.equal(wasVerifyJobCancelled(id), false) // record gone — reads as not-cancelled
})

test('cancelVerifyJob on an unknown or finished job is a no-op returning false', () => {
  assert.equal(cancelVerifyJob('verify-job-does-not-exist'), false)
})

test('output notifications throttle; start and end push immediately', async () => {
  const seen: string[] = []
  onVerifyJobsChanged((jobs) => seen.push(jobs.find((j) => j.projectId === 'proj-d')?.outputTail ?? '<gone>'))

  const id = startVerifyJob('proj-d', 'Project D', 'npm test')
  const afterStart = seen.length
  assert.equal(afterStart >= 1, true) // start pushed immediately

  appendVerifyOutput(id, 'one ')
  appendVerifyOutput(id, 'two')
  assert.equal(seen.length, afterStart) // output-only changes coalesce

  await new Promise((r) => setTimeout(r, 400))
  assert.equal(seen.length, afterStart + 1) // one trailing push carries both chunks
  assert.equal(seen[seen.length - 1], 'one two')

  endVerifyJob(id)
  assert.equal(seen.length, afterStart + 2) // end pushed immediately
  assert.equal(seen[seen.length - 1], '<gone>')
  onVerifyJobsChanged(() => {})
})
