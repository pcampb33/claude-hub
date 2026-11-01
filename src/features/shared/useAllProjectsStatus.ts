import { useProjectFanOut } from './useProjectFanOut'
import type { ProjectStatus, RegistryEntry } from '../../../shared/ipc-types'

export interface ProjectWithStatus extends RegistryEntry {
  status: ProjectStatus | null
}

// Module scope for a stable identity — see useProjectFanOut.
const fetchStatus = async (entry: RegistryEntry) => ({
  status: await window.hubApi.getProjectStatus(entry.path),
})

// The shared "all registered projects + their live status" fetch, so the
// Projects view and the Dashboard don't each hand-roll their own N-way fan-out.
// The snapshot cache inside useProjectFanOut is what makes a cold load paint
// the last known fleet instead of an empty one; its in-flight map is what keeps
// a view transition from firing the fan-out twice (the outgoing view is still
// mounted when the incoming one mounts — this comment used to claim otherwise).
export function useAllProjectsStatus() {
  return useProjectFanOut<{ status: ProjectStatus | null }>('hub:v1:projects-status', fetchStatus)
}
