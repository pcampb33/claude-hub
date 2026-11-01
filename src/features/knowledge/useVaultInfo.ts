import { useEffect, useState } from 'react'
import type { VaultInfo } from '../../../shared/ipc-types'

export function useVaultInfo() {
  const [vault, setVault] = useState<VaultInfo | null>(null)

  useEffect(() => {
    // Swallow a failed read rather than raise an unhandled rejection — the
    // vault-path chip is non-essential chrome; absence is an acceptable
    // degradation, and the views around it surface their own load errors.
    window.hubApi.getVaultInfo().then(setVault, () => setVault(null))
  }, [])

  return vault
}
