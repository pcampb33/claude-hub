import { useRef } from 'react'
import type { PromoteResult } from '../../../shared/ipc-types'
import { toast } from './toast'

// Shared by SkillDetail and WorkflowDetail — guards against the same
// stale-response race already fixed in useProjectList/useSessionHistory:
// rapidly re-selecting a different target while a promote is in flight
// could otherwise let a slower, earlier response report over a faster,
// later one. Outcome is reported through the shared toast singleton
// instead of per-card result divs.
export function usePromote(sourcePath: string, onPromote: (sourcePath: string, targetProjectId: string) => Promise<PromoteResult>) {
  const latestRequest = useRef(0)

  const promoteWith = async (
    action: (sourcePath: string, targetProjectId: string) => Promise<PromoteResult>,
    targetProjectId: string,
  ) => {
    const requestId = ++latestRequest.current
    const res = await action(sourcePath, targetProjectId)
    if (requestId !== latestRequest.current) return
    if (res.ok) {
      toast.success('Copied to project.')
    } else {
      toast.error(res.message ?? 'Copy failed.')
    }
  }

  const promote = (targetProjectId: string) => promoteWith(onPromote, targetProjectId)

  return { promote, promoteWith }
}
