import { useProjectFanOut } from './useProjectFanOut'
import type { ConfigHealthReport, RegistryEntry } from '../../../shared/ipc-types'

export interface ProjectWithConfigHealth extends RegistryEntry {
  configHealth: ConfigHealthReport
}

// Module scope for a stable identity — see useProjectFanOut.
const fetchConfigHealth = async (entry: RegistryEntry) => ({
  configHealth: await window.hubApi.getConfigHealth(entry.path),
})

// Measured 198ms for all 16 registered projects — cheap enough to fetch eagerly
// rather than gating behind a per-card lazy expand like the Projects view does
// (that view's per-card laziness predates having real registered-project data to
// measure against).
export function useAllProjectsConfigHealth() {
  return useProjectFanOut<{ configHealth: ConfigHealthReport }>('hub:v1:config-health', fetchConfigHealth)
}
