// Electron-coupled vault action: opening the vault in Obsidian/Explorer
// needs shell. VAULT_PATH/ensureVault/getVaultInfo live in vault-core.ts
// (Electron-free) for the CLI scripts and vault-graph.
import { shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { VAULT_PATH, ensureVault } from './vault-core'

// Obsidian registers itself as the `obsidian://` protocol handler on
// install (HKCR\obsidian on Windows) — checking that key is a reasonably
// reliable "is it installed" signal without hardcoding an install path.
function isObsidianInstalled(): boolean {
  try {
    execFileSync('reg', ['query', 'HKCR\\obsidian'], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
    return true
  } catch {
    return false
  }
}

export function openVault(): void {
  ensureVault()
  if (isObsidianInstalled()) {
    // Unlike shell.openPath (resolves with an error string), openExternal
    // rejects on failure — needs a .catch, same "check the async result"
    // discipline as the step-6 fix for spawn()/openPath.
    shell
      .openExternal(`obsidian://open?path=${encodeURIComponent(VAULT_PATH)}`)
      .catch((err) => console.error('[vault] openVault (obsidian://) failed:', err))
  } else {
    shell.openPath(VAULT_PATH).then((errorMessage) => {
      if (errorMessage) console.error(`[vault] openVault fallback failed: ${errorMessage}`)
    })
  }
}
