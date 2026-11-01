// Session Desktop launcher: where a session can start (registered projects and
// sandbox experiments) and the recent conversations it can resume, read from
// Claude Code's transcripts (<claude home>/projects/<encoded folder>/<id>.jsonl).
// Electron-free; the base folder is passed in so tests use a fake one.
import fs from 'node:fs'
import path from 'node:path'
import { sanitize } from './status.ts'
import { HEAD_BYTES, deriveLiveSessionStatus, readActivityTail, readJsonlHead } from './live-core.ts'
import { isHeadlessSessionCached, readSessionTitle } from './sessions.ts'
import { isUuid, normalizePath } from './desktop-outside.ts'

import type { DesktopLaunchTargets, DesktopRecentSession, DesktopTarget, DesktopTargetRef } from '../shared/ipc-types.ts'

// readSessionTitle's fallback when a transcript has no title and no prompt.
const NO_TITLE = '(no message found)'

export interface LaunchTarget {
  ref: DesktopTargetRef
  name: string
  path: string
}

export const RECENT_LIMIT = 30

// A folder's own encoded session dirs: every case variant of its exact name
// (PowerShell and Git Bash spell the drive differently), never a subfolder's
// (the 'sandbox' project must not count its experiments' sessions).
export function ownSessionDirs(base: string, entries: string[], folder: string): string[] {
  const want = sanitize(folder).toLowerCase()
  return entries.filter((entry) => entry.toLowerCase() === want).map((entry) => path.join(base, entry))
}

// The cwd a transcript recorded: the first head line that carries one. A
// transcript opening with one huge prompt line needs the wider read.
export function transcriptCwd(file: string): string | null {
  for (const bytes of [HEAD_BYTES, 1024 * 1024]) {
    for (const line of readJsonlHead(file, bytes).slice(0, 40)) {
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd
        if (typeof cwd === 'string' && cwd.length > 0) return cwd
      } catch {
        // partial or non-JSON line
      }
    }
  }
  return null
}

// The transcript of `sessionId` in `folder`'s own session dir, provided it
// recorded that folder as its cwd. Throws with the reason otherwise.
export function findTargetTranscript(base: string, folder: string, sessionId: string): string {
  for (const dir of ownSessionDirs(base, fs.readdirSync(base), folder)) {
    const file = path.join(dir, `${sessionId}.jsonl`)
    if (!fs.existsSync(file)) continue
    const cwd = transcriptCwd(file)
    if (cwd !== null && normalizePath(cwd) === normalizePath(folder)) return file
    throw new Error(`That conversation ran in ${cwd ?? 'an unrecorded folder'}, not ${folder}`)
  }
  throw new Error(`No conversation ${sessionId} in ${folder}`)
}

interface TranscriptFile {
  id: string
  file: string
  mtimeMs: number
}

// Session transcripts only (named by their session id).
function listTranscripts(dir: string): TranscriptFile[] {
  const out: TranscriptFile[] = []
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.jsonl') || !isUuid(entry.slice(0, -'.jsonl'.length))) continue
    const file = path.join(dir, entry)
    try {
      const stat = fs.statSync(file)
      if (stat.isFile()) out.push({ id: entry.slice(0, -'.jsonl'.length), file, mtimeMs: stat.mtimeMs })
    } catch {
      // deleted between readdir and stat
    }
  }
  return out
}

async function isHeadless(file: string): Promise<boolean | null> {
  try {
    return await isHeadlessSessionCached(file)
  } catch {
    return null // vanished mid-read
  }
}

// Targets most recent first (never-used ones last, by name), and the latest
// RECENT_LIMIT interactive conversations across them. Stat-first: only files
// newer than the ones already accepted are opened. `errors` carries what the
// caller already couldn't read; partial results are returned with all of it.
export async function buildLaunchTargets(input: {
  targets: LaunchTarget[]
  base: string
  liveElsewhere: Set<string>
  errors: string[]
  nowMs: number
}): Promise<DesktopLaunchTargets> {
  const { targets, base, liveElsewhere, nowMs } = input
  const errors = [...input.errors]
  let entries: string[] = []
  try {
    entries = fs.readdirSync(base)
  } catch (err) {
    // No projects folder = Claude Code never saved a transcript here.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`Couldn't read ${base}: ${(err as Error).message}`)
  }

  const byDir = new Map<string, TranscriptFile[]>()
  const out: DesktopTarget[] = []
  for (const target of targets) {
    const files: TranscriptFile[] = []
    for (const dir of ownSessionDirs(base, entries, target.path)) {
      if (!byDir.has(dir)) {
        try {
          byDir.set(dir, listTranscripts(dir))
        } catch (err) {
          errors.push(`Couldn't read ${dir}: ${(err as Error).message}`)
          byDir.set(dir, [])
        }
      }
      files.push(...byDir.get(dir)!)
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    let lastActivityIso: string | null = null
    for (const f of files) {
      if ((await isHeadless(f.file)) === false) {
        lastActivityIso = new Date(f.mtimeMs).toISOString()
        break
      }
    }
    out.push({ ...target.ref, name: target.name, lastActivityIso })
  }
  out.sort((a, b) => (b.lastActivityIso ?? '').localeCompare(a.lastActivityIso ?? '') || a.name.localeCompare(b.name))

  const all = [...byDir.values()].flat().sort((a, b) => b.mtimeMs - a.mtimeMs)
  const recent: DesktopRecentSession[] = []
  for (const f of all) {
    if (recent.length >= RECENT_LIMIT) break
    if ((await isHeadless(f.file)) !== false) continue
    try {
      const cwd = transcriptCwd(f.file)
      const target = cwd === null ? undefined : targets.find((t) => normalizePath(t.path) === normalizePath(cwd))
      if (!target) continue // ran in a folder the desktop doesn't know (an encoding twin)
      const status = deriveLiveSessionStatus(readActivityTail(f.file), nowMs)
      // No prompt or reply ever (e.g. a fresh /clear nobody typed into):
      // nothing to resume, and only a placeholder to call it.
      if (!status.lastActivityAt) continue
      const title = await readSessionTitle(f.file)
      recent.push({
        sessionId: f.id,
        title: title === NO_TITLE ? 'Untitled conversation' : title,
        target: target.ref,
        targetName: target.name,
        lastActivityIso: status.lastActivityAt ?? new Date(f.mtimeMs).toISOString(),
        liveElsewhere: liveElsewhere.has(f.id),
      })
    } catch {
      continue // deleted mid-read
    }
  }
  recent.sort((a, b) => b.lastActivityIso.localeCompare(a.lastActivityIso))
  return { targets: out, recent, error: errors.length > 0 ? errors.join('; ') : null }
}
