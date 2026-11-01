import { shell } from 'electron'
import { resolveSessionPaths } from './session-delete-core.ts'

// Deleting a session's history means deleting out of ~/.claude/projects —
// Claude Code's OWN store, not a hub artifact — so the session stops being
// resumable in the CLI as well as disappearing from the hub's lists. That is
// why this trashes rather than unlinks: shell.trashItem puts both paths in the
// recycle bin, where a mis-click is still recoverable by hand. It is also why
// this channel is Electron-only (ELECTRON_ONLY_CHANNELS in hub-service.ts).
//
// Transcript first, sidecar second: the transcript is the thing the user asked
// to delete, and if trashing it fails there is no reason to have already
// thrown the subagents away. A failure on either half rejects — the caller
// says what it could not remove instead of reporting a clean delete.
export async function deleteSession(projectId: string, sessionId: string): Promise<void> {
  const { transcriptPath, sidecarDir } = resolveSessionPaths(projectId, sessionId)
  await shell.trashItem(transcriptPath)
  if (sidecarDir) await shell.trashItem(sidecarDir)
}
