import { useCallback, useEffect, useState } from 'react'
import type { CreateWorkflowResult, PromoteResult, WorkflowEntry, WorkflowTemplate } from '../../../shared/ipc-types'

export function useWorkflows() {
  const [workflows, setWorkflows] = useState<WorkflowEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setWorkflows(await window.hubApi.listWorkflows())
      setError(null)
    } catch (err) {
      // Don't strand the view on a disabled "Loading…" (see useFloorStatus).
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const promote = useCallback(
    (sourcePath: string, targetProjectId: string): Promise<PromoteResult> =>
      window.hubApi.promoteWorkflow(sourcePath, targetProjectId),
    [],
  )

  const launchSession = useCallback(
    (sourcePath: string, targetProjectId: string, args: string): Promise<void> =>
      window.hubApi.launchWorkflowSession(sourcePath, targetProjectId, args),
    [],
  )

  const readSource = useCallback(
    (sourcePath: string): Promise<string> => window.hubApi.readWorkflowSource(sourcePath),
    [],
  )

  const explainSession = useCallback(
    (sourcePath: string, targetProjectId: string): Promise<void> =>
      window.hubApi.explainWorkflowSession(sourcePath, targetProjectId),
    [],
  )

  const listTemplates = useCallback((): Promise<WorkflowTemplate[]> => window.hubApi.listWorkflowTemplates(), [])

  const createFromTemplate = useCallback(
    (templateKey: string, name: string, targetProjectId: string): Promise<CreateWorkflowResult> =>
      window.hubApi.createWorkflowFromTemplate(templateKey, name, targetProjectId),
    [],
  )

  const openInEditor = useCallback(
    (scriptPath: string): Promise<void> => window.hubApi.openWorkflowInEditor(scriptPath),
    [],
  )

  const editSession = useCallback(
    (scriptPath: string, targetProjectId: string, instruction: string): Promise<void> =>
      window.hubApi.editWorkflowSession(scriptPath, targetProjectId, instruction),
    [],
  )

  return {
    workflows,
    loading,
    error,
    refresh,
    promote,
    launchSession,
    readSource,
    explainSession,
    listTemplates,
    createFromTemplate,
    openInEditor,
    editSession,
  }
}
