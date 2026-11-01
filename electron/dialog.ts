import { dialog } from 'electron'

// Main-process folder picker — the renderer never supplies a raw path;
// the only path that reaches addProject came out of this native dialog.
export async function pickFolder(): Promise<string | null> {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}
