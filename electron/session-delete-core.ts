// What "delete this session's history" actually removes, resolved from a
// registry id + a session id and nothing else the renderer sent.
//
// Electron-free so it sits under tests: session-delete.ts, which does the
// trashing, imports `electron` and cannot load under `node --test`. Same
// split as launch-core.ts / launch.ts.
import fs from 'node:fs'
import path from 'node:path'
import { assertSessionId, resolvePath } from './launch-core.ts'
import { findSessionFiles } from './sessions.ts'

export interface SessionPaths {
  transcriptPath: string
  // <session-dir>/<sessionId>/ — where Claude Code writes the session's
  // subagent transcripts and metas (see subagents.ts). null when the session
  // never spawned one, which is most of them.
  sidecarDir: string | null
}

// Derived from the matched transcript's own dirname, never recomputed from
// the project path: a project can have several session dirs (case variants,
// subfolder rollup — see findSessionDirs), and the sidecar lives beside the
// file that was actually found.
export function sidecarDirFor(transcriptPath: string): string {
  return path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'))
}

// Enumerator-validated like every other write path here: the id must name a
// registered project and a transcript that is really on disk in it, so a
// renderer can never aim this at a path the hub doesn't already know about.
export function resolveSessionPaths(projectId: string, sessionId: string): SessionPaths {
  const projectPath = resolvePath(projectId)
  assertSessionId(sessionId)
  const match = findSessionFiles(projectPath).find((file) => file.id === sessionId)
  if (!match) throw new Error(`No session "${sessionId}" recorded in that project`)
  return { transcriptPath: match.filePath, sidecarDir: existingSidecarDir(match.filePath) }
}

// null means "this session has no sidecar dir", so it may only be returned
// when the directory is genuinely absent. fs.existsSync answers false for a
// permissions or IO failure too, and here that reads as "no subagents to
// delete" — a failure rendered as an absence, which is this codebase's
// recurring bug. Anything but ENOENT is a question we could not answer, and
// the delete stops rather than silently leaving the subagents behind.
function existingSidecarDir(transcriptPath: string): string | null {
  const dir = sidecarDirFor(transcriptPath)
  try {
    return fs.statSync(dir).isDirectory() ? dir : null
  } catch (err) {
    if ((err as { code?: string })?.code === 'ENOENT') return null
    throw err
  }
}
