// Cross-project session list with PER-SESSION state — what the Sessions view
// lists.
//
// The shipped live machinery (live-core.ts) is deliberately per-PROJECT: it
// examines only each project's newest transcript and keys the result by
// registry id, which is all the dashboard's "what's happening right now"
// strip needs. A master-detail session list needs the other axis — every
// recent session, each with its own state — so this module reuses
// live-core's pure derivation (readActivityTail + deriveLiveSessionStatus)
// across many files instead of one per project.
//
// Electron-free (node + sibling core modules only), served through
// hub-service.ts.
import fs from 'node:fs'
import { listProjects } from './registry.ts'
import { findSessionFiles, isHeadlessSessionCached, readSessionTitle } from './sessions.ts'
import { deriveLiveSessionStatus, readActivityTail, readSessionProcesses, type SessionProcess } from './live-core.ts'
import type { SessionListEntry } from '../shared/ipc-types.ts'

// How many sessions the list returns. The view groups them Live/Recent, so
// this only has to cover "enough recent history to pick from", not the
// whole archive (which runs to thousands of files).
export const SESSION_LIST_LIMIT = 40

interface Candidate {
  sessionId: string
  filePath: string
  projectId: string
  projectName: string
  projectPath: string
  mtimeMs: number
}

function gatherCandidates(): Candidate[] {
  const candidates: Candidate[] = []
  for (const project of listProjects()) {
    let files: ReturnType<typeof findSessionFiles>
    try {
      files = findSessionFiles(project.path)
    } catch {
      continue // project dir gone / unreadable — not this module's problem
    }
    for (const file of files) {
      let mtimeMs: number
      try {
        mtimeMs = fs.statSync(file.filePath).mtimeMs
      } catch {
        continue // deleted between readdir and stat
      }
      candidates.push({
        sessionId: file.id,
        filePath: file.filePath,
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        mtimeMs,
      })
    }
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

async function describe(candidate: Candidate, nowMs: number, proc: SessionProcess): Promise<SessionListEntry> {
  let status
  try {
    status = deriveLiveSessionStatus(readActivityTail(candidate.filePath), nowMs, undefined, proc)
  } catch {
    status = { state: 'ended' as const } // vanished mid-read
  }
  return {
    sessionId: candidate.sessionId,
    projectId: candidate.projectId,
    projectName: candidate.projectName,
    projectPath: candidate.projectPath,
    // The ai-title line sits near the START of a transcript, so the tail
    // read above almost never carries it — the head scan is what titles a
    // session, same as the per-project list.
    title: await readSessionTitle(candidate.filePath),
    state: status.state,
    model: status.model,
    lastToolName: status.lastToolName,
    waitingFor: status.waitingFor,
    lastTimestamp: status.lastTimestamp,
    contextPct: status.contextPct,
    // Last real turn, not mtime — exit bookkeeping rewrites mtime days later.
    // mtime only stands in for a tail with no timestamped activity at all.
    date: status.lastActivityAt ?? new Date(candidate.mtimeMs).toISOString(),
  }
}

export async function listAllSessions(): Promise<SessionListEntry[]> {
  const nowMs = Date.now()
  const candidates = gatherCandidates()

  // Walk newest-first, testing the headless flag as we go, and stop as soon
  // as the window is full — so the common case costs LIMIT cheap scans, not
  // one per transcript on disk.
  //
  // No scan ceiling. There was one (200), and headless `claude -p` hook
  // transcripts — frequent and freshly-mtimed — filled it: on 2026-09-28 the
  // list returned 22 of its 40 slots, because 40 real sessions sat 589 files
  // deep. The shortfall read as "these are your recent sessions" while older
  // ones silently fell off the only view that could delete them. The headless
  // flag is memoized per file, so the full walk (~0.5s cold at 1,226
  // transcripts) is paid once per process.
  const keep: Candidate[] = []
  for (const candidate of candidates) {
    if (keep.length >= SESSION_LIST_LIMIT) break
    if (await isHeadlessSessionCached(candidate.filePath)) continue
    keep.push(candidate)
  }

  const processFor = readSessionProcesses()
  return Promise.all(keep.map((candidate) => describe(candidate, nowMs, processFor(candidate.sessionId))))
}
