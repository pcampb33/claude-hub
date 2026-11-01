// Electron-coupled launch actions: everything here needs shell or clipboard,
// which only exist inside Electron's own process. The spawn-based launchers
// (VS Code, terminal, remote-control) live in launch-core.ts so the hub
// server can expose them too.
import { shell, clipboard } from 'electron'
import {
  listWorkflows,
  buildWorkflowDeepLink,
  buildWorkflowExplainDeepLink,
  buildWorkflowAuthorDeepLink,
} from './workflows'
import { resolvePath, assertWorkflowsDirFile, assertCommandName, logSpawnFailure } from './launch-core'

export function openFolder(id: string): void {
  const projectPath = resolvePath(id)
  // shell.openPath resolves with an error message string on failure — it
  // does not reject/throw — so the return value must be checked explicitly.
  shell.openPath(projectPath).then((errorMessage) => {
    if (errorMessage) console.error(`[launch] openFolder failed: ${errorMessage}`)
  })
}

export function copyPath(id: string): void {
  clipboard.writeText(resolvePath(id))
}

// Opens an interactive Claude Code session at the chosen project via a
// claude-cli:// deep link, with the workflow invocation pre-filled (the user
// presses Enter to run it). Both inputs are validated against known-good
// enumerators — the cwd by registry-id lookup (resolvePath), the workflow by
// path against listWorkflows() — and the deep link URL-encodes everything, so
// no path/user data reaches a shell as command-line text. shell.openExternal
// (not spawn) hands the URL to the OS protocol handler.
export function launchWorkflowSession(sourcePath: string, targetProjectId: string, args: string): void {
  const cwd = resolvePath(targetProjectId)
  const workflow = listWorkflows().find((w) => w.path === sourcePath)
  if (!workflow) throw new Error(`No known workflow at path "${sourcePath}"`)
  const url = buildWorkflowDeepLink(cwd, workflow.name, args ?? '')
  shell.openExternal(url).catch(logSpawnFailure('launchWorkflowSession'))
}

// Opens a session at the chosen project with "Run /<name>" pre-filled — the
// Commands view's Run action. cwd resolves by registry id; the command name
// is checked by assertCommandName (launch-core, where it can be tested).
export function launchCommandSession(commandName: string, targetProjectId: string): void {
  const cwd = resolvePath(targetProjectId)
  assertCommandName(commandName)
  const prompt = `Run /${commandName}`
  const url = `claude-cli://open?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(prompt)}`
  shell.openExternal(url).catch(logSpawnFailure('launchCommandSession'))
}

// "Explain this workflow" — same resolution + safe-deep-link path as
// launchWorkflowSession, but the pre-filled prompt asks Claude to read the
// script and walk through when/how to use it instead of running it.
export function launchWorkflowExplain(sourcePath: string, targetProjectId: string): void {
  const cwd = resolvePath(targetProjectId)
  const workflow = listWorkflows().find((w) => w.path === sourcePath)
  if (!workflow) throw new Error(`No known workflow at path "${sourcePath}"`)
  const url = buildWorkflowExplainDeepLink(cwd, workflow.name, workflow.path)
  shell.openExternal(url).catch(logSpawnFailure('launchWorkflowExplain'))
}

// "Edit / refine in session" — opens a session at the project with the script
// and an instruction pre-filled (e.g. "adapt it to: <goal>" for a fresh
// scaffold). cwd resolves by registry id; scriptPath is validated to a known
// workflows dir and only ever reaches the URL-encoded deep link, never a shell.
export function launchWorkflowEdit(scriptPath: string, targetProjectId: string, instruction: string): void {
  const cwd = resolvePath(targetProjectId)
  assertWorkflowsDirFile(scriptPath)
  const url = buildWorkflowAuthorDeepLink(cwd, scriptPath, instruction)
  shell.openExternal(url).catch(logSpawnFailure('launchWorkflowEdit'))
}
