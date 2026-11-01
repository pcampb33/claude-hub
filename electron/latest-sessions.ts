import { deriveLiveSessionStatus, readJsonlTail } from './live-core.ts'
import { listProjects } from './registry.ts'
import { findSessionFiles, isHeadlessSessionCached, readSessionTitle } from './sessions.ts'
import type { LatestSessionEntry } from '../shared/ipc-types'

// For each registered project, find the single newest .jsonl and read a
// cheap title from it. Projects with no sessions are omitted.
export async function latestSessionPerProject(): Promise<LatestSessionEntry[]> {
  const results = await Promise.all(
    listProjects().map(async (project): Promise<LatestSessionEntry | null> => {
      // Newest first, then skip headless `claude -p` transcripts (curate-session
      // hook runs) so a project's "latest session" reflects real interactive work.
      const files = findSessionFiles(project.path).sort((a, b) => b.mtimeMs - a.mtimeMs)
      let newest: { filePath: string; mtimeMs: number } | null = null
      for (const file of files) {
        if (await isHeadlessSessionCached(file.filePath)) continue
        newest = file
        break
      }
      if (!newest) return null
      // mtime picks the file; the last user/assistant line dates it. Closing
      // an idle terminal appends timestamp-free bookkeeping that bumps mtime
      // days after the last turn, which read as "active this morning".
      let lastActivityAt: string | undefined
      try {
        lastActivityAt = deriveLiveSessionStatus(readJsonlTail(newest.filePath), Date.now()).lastActivityAt
      } catch {
        // vanished mid-read — fall through to mtime
      }
      return {
        registryId: project.id,
        title: await readSessionTitle(newest.filePath),
        timestamp: lastActivityAt ?? new Date(newest.mtimeMs).toISOString(),
      }
    }),
  )
  return results.filter((r): r is LatestSessionEntry => r !== null)
}
