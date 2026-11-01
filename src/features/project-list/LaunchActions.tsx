import { toast } from '../shared/toast'

export function LaunchActions({ id }: { id: string }) {
  const handleCopy = async () => {
    try {
      await window.hubApi.copyPath(id)
      toast.success('Path copied.')
    } catch {
      toast.error('Copy path failed.')
    }
  }

  const run = (action: string, fn: () => Promise<void>) => () => fn().catch(() => toast.error(`${action} failed.`))

  return (
    <div className="launch-actions">
      {/* The one accent primary — hardcoded in v1, the rest stay uniform ghosts. */}
      <button className="btn-launch-primary" onClick={run('Open in VS Code', () => window.hubApi.openInVSCode(id))}>Open in VS Code</button>
      <button className="btn-ghost" onClick={run('Open folder', () => window.hubApi.openFolder(id))}>Open folder</button>
      <button className="btn-ghost" onClick={run('Open terminal', () => window.hubApi.openTerminal(id))}>Open terminal</button>
      <button className="btn-ghost" onClick={run('Open with Remote Control', () => window.hubApi.openRemoteControl(id))}>Remote Control</button>
      <button className="btn-ghost" onClick={handleCopy}>Copy path</button>
    </div>
  )
}
