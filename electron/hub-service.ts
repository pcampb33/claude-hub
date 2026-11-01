// Electron-free implementation of the hubApi invoke surface: one
// channel→handler map, typed against HubApi so a handler with the wrong
// signature fails typecheck. ipc-handlers.ts registers every entry on ipcMain.
// Everything this module imports stays Electron-free with explicit .ts
// relative imports, so the CLI scripts can load the same domain modules
// under plain node.
import { IPC_CHANNELS, type HubApi } from '../shared/ipc-types.ts'
import { listProjects, addProject, removeProject, setPinned, setVerifyCommand } from './registry.ts'
import { getProjectStatus } from './status.ts'
import { listSessions, readSession } from './sessions.ts'
import { listSubagents, readSubagent } from './subagents.ts'
import { listAllSessions } from './session-list-core.ts'
import {
  openInVSCode,
  openTerminal,
  openRemoteControl,
  openClaudeMd,
  openWorkflowInEditor,
  resumeSessionInTerminal,
} from './launch-core.ts'
import { getVaultInfo } from './vault-core.ts'
import { getVaultGraph, readVaultNote } from './vault-graph.ts'
import { listSkills, readSkillSource } from './skills.ts'
import { getSkillUsage } from './skill-usage.ts'
import { promoteToProject, promoteAndTailor, promoteSkillToGlobal } from './promote.ts'
import { listWorkflows, readWorkflowSource, promoteWorkflowToProject } from './workflows.ts'
import { listWorkflowTemplates, createWorkflowFromTemplate } from './workflow-templates.ts'
import {
  listExperiments,
  createExperiment,
  openExperimentTerminal,
  draftLearnings,
  queueExperimentToInbox,
} from './sandbox.ts'
import { listJobs, cancelJob } from './sandbox-jobs.ts'
import { getConfigHealth, getCrossProjectRedundancy } from './config-health.ts'
import { searchSessions } from './session-search.ts'
import { getFloorStatus } from './floor-core.ts'
import { runVerify } from './run-verify.ts'
import { listVerifyJobs, cancelVerifyJob } from './verify-jobs.ts'
import { getVaultInbox, resolveInboxEntry } from './vault-inbox.ts'
import { writeVaultNote } from './vault-write-core.ts'
import { recomputeLinks, linkNoteInBackground } from './vault-linker-run.ts'
import { computeRecallScorecard } from './recall-scorecard.ts'
import { getJobFreshness } from './job-freshness.ts'
import { getGlobalConfig, runGlobalTask, openGlobalFile } from './global-config.ts'
import { readRubric, writeRubric } from './rubric-core.ts'
import { latestSessionPerProject } from './latest-sessions.ts'
import { getActivityHistory } from './activity-core.ts'
import { getLiveSnapshot } from './live-core.ts'
import { getUsageLimits } from './usage.ts'
import { getUsage, getUsageSessions } from './usage-index.ts'
import { getExtensions, recheckExtensions, setPluginEnabled } from './extensions.ts'
import {
  getDesktop,
  createDesktopSession,
  resumeDesktopSession,
  closeDesktopSession,
  forgetDesktopSession,
  updateDesktopSession,
  getDesktopScreen,
  desktopInput,
  desktopResize,
  listDesktopTargets,
  takeOverSession,
} from './desktop-core.ts'
import { getProjectConfig, getBoundary, setBoundary, auditBoundary, writeLocalGuard, removeLocalGuard } from './project-config.ts'

// Invoke-style methods = names shared by HubApi and IPC_CHANNELS. The two
// push events (live:update, sandbox:jobs-changed) appear under different
// names on each side, so they fall out of this intersection by construction.
type InvokeMethod = keyof HubApi & keyof typeof IPC_CHANNELS

// A handler carries its HubApi method's exact parameters; returning the
// resolved value synchronously is fine — ipcMain awaits the result.
type Handler<M extends InvokeMethod> = (
  ...args: Parameters<HubApi[M]>
) => Awaited<ReturnType<HubApi[M]>> | ReturnType<HubApi[M]>

type HubService = { [M in InvokeMethod as (typeof IPC_CHANNELS)[M]]?: Handler<M> }

export const hubService = {
  [IPC_CHANNELS.listProjects]: listProjects,
  [IPC_CHANNELS.addProject]: addProject,
  [IPC_CHANNELS.removeProject]: removeProject,
  [IPC_CHANNELS.setPinned]: setPinned,
  [IPC_CHANNELS.setVerifyCommand]: setVerifyCommand,
  [IPC_CHANNELS.getProjectStatus]: getProjectStatus,
  [IPC_CHANNELS.listSessions]: listSessions,
  [IPC_CHANNELS.listAllSessions]: listAllSessions,
  [IPC_CHANNELS.readSession]: readSession,
  [IPC_CHANNELS.listSubagents]: listSubagents,
  [IPC_CHANNELS.readSubagent]: readSubagent,
  [IPC_CHANNELS.openInVSCode]: openInVSCode,
  [IPC_CHANNELS.openTerminal]: openTerminal,
  [IPC_CHANNELS.openRemoteControl]: openRemoteControl,
  [IPC_CHANNELS.resumeSessionInTerminal]: resumeSessionInTerminal,
  [IPC_CHANNELS.openClaudeMd]: openClaudeMd,
  [IPC_CHANNELS.getVaultInfo]: getVaultInfo,
  [IPC_CHANNELS.getVaultGraph]: getVaultGraph,
  [IPC_CHANNELS.readVaultNote]: readVaultNote,
  [IPC_CHANNELS.listSkills]: listSkills,
  [IPC_CHANNELS.getSkillUsage]: getSkillUsage,
  [IPC_CHANNELS.readSkillSource]: readSkillSource,
  [IPC_CHANNELS.promoteToProject]: promoteToProject,
  [IPC_CHANNELS.promoteAndTailor]: promoteAndTailor,
  [IPC_CHANNELS.promoteSkillToGlobal]: promoteSkillToGlobal,
  [IPC_CHANNELS.listWorkflows]: listWorkflows,
  [IPC_CHANNELS.readWorkflowSource]: readWorkflowSource,
  [IPC_CHANNELS.promoteWorkflow]: promoteWorkflowToProject,
  [IPC_CHANNELS.listWorkflowTemplates]: listWorkflowTemplates,
  [IPC_CHANNELS.createWorkflowFromTemplate]: createWorkflowFromTemplate,
  [IPC_CHANNELS.openWorkflowInEditor]: openWorkflowInEditor,
  [IPC_CHANNELS.listExperiments]: listExperiments,
  [IPC_CHANNELS.createExperiment]: createExperiment,
  [IPC_CHANNELS.openExperimentTerminal]: openExperimentTerminal,
  [IPC_CHANNELS.draftLearnings]: draftLearnings,
  [IPC_CHANNELS.queueExperimentToInbox]: queueExperimentToInbox,
  [IPC_CHANNELS.listSandboxJobs]: listJobs,
  [IPC_CHANNELS.cancelSandboxJob]: cancelJob,
  [IPC_CHANNELS.getConfigHealth]: getConfigHealth,
  [IPC_CHANNELS.getCrossProjectRedundancy]: getCrossProjectRedundancy,
  [IPC_CHANNELS.searchSessions]: searchSessions,
  [IPC_CHANNELS.getFloorStatus]: getFloorStatus,
  [IPC_CHANNELS.runVerify]: runVerify,
  [IPC_CHANNELS.listVerifyJobs]: listVerifyJobs,
  [IPC_CHANNELS.cancelVerifyJob]: cancelVerifyJob,
  [IPC_CHANNELS.getVaultInbox]: getVaultInbox,
  // The two paths where a note enters the vault interactively both kick a
  // non-blocking incremental link of the new note (Phase 2 of the vault
  // linker) — the approve/capture round-trip stays instant, edges appear on
  // the next graph refresh. Batch paths are covered by the daily
  // link-vault --incremental sweep instead.
  [IPC_CHANNELS.resolveInboxEntry]: (sessionId: string, title: string, action: 'approve' | 'reject') => {
    const result = resolveInboxEntry(sessionId, title, action)
    if (result.ok && action === 'approve' && result.notePath) linkNoteInBackground(result.notePath)
    return result
  },
  [IPC_CHANNELS.quickCaptureVaultNote]: (payload: { title: string; content: string }) => {
    const result = writeVaultNote(payload.title, payload.content)
    if (result.ok && result.notePath) linkNoteInBackground(result.notePath)
    return result
  },
  [IPC_CHANNELS.recomputeLinks]: recomputeLinks,
  [IPC_CHANNELS.getRecallScorecard]: () => computeRecallScorecard(),
  [IPC_CHANNELS.getJobFreshness]: () => getJobFreshness(),
  [IPC_CHANNELS.getGlobalConfig]: getGlobalConfig,
  [IPC_CHANNELS.runGlobalTask]: runGlobalTask,
  [IPC_CHANNELS.openGlobalFile]: openGlobalFile,
  [IPC_CHANNELS.getRubric]: readRubric,
  [IPC_CHANNELS.saveRubric]: writeRubric,
  [IPC_CHANNELS.latestSessionPerProject]: latestSessionPerProject,
  [IPC_CHANNELS.getActivityHistory]: getActivityHistory,
  [IPC_CHANNELS.getUsageLimits]: getUsageLimits,
  [IPC_CHANNELS.getUsage]: getUsage,
  [IPC_CHANNELS.getUsageSessions]: getUsageSessions,
  [IPC_CHANNELS.getLiveStatus]: getLiveSnapshot,
  [IPC_CHANNELS.getExtensions]: getExtensions,
  [IPC_CHANNELS.recheckExtensions]: recheckExtensions,
  [IPC_CHANNELS.setPluginEnabled]: setPluginEnabled,
  [IPC_CHANNELS.getDesktop]: getDesktop,
  [IPC_CHANNELS.createDesktopSession]: createDesktopSession,
  [IPC_CHANNELS.resumeDesktopSession]: resumeDesktopSession,
  [IPC_CHANNELS.closeDesktopSession]: closeDesktopSession,
  [IPC_CHANNELS.forgetDesktopSession]: forgetDesktopSession,
  [IPC_CHANNELS.updateDesktopSession]: updateDesktopSession,
  [IPC_CHANNELS.getDesktopScreen]: getDesktopScreen,
  [IPC_CHANNELS.desktopInput]: desktopInput,
  [IPC_CHANNELS.desktopResize]: desktopResize,
  [IPC_CHANNELS.listDesktopTargets]: listDesktopTargets,
  [IPC_CHANNELS.takeOverSession]: takeOverSession,
  [IPC_CHANNELS.getProjectConfig]: getProjectConfig,
  [IPC_CHANNELS.getBoundary]: getBoundary,
  [IPC_CHANNELS.setBoundary]: setBoundary,
  [IPC_CHANNELS.auditBoundary]: auditBoundary,
  [IPC_CHANNELS.writeLocalGuard]: writeLocalGuard,
  [IPC_CHANNELS.removeLocalGuard]: removeLocalGuard,
} satisfies HubService

// Channels whose implementation needs Electron APIs (shell, clipboard,
// native dialog) — registered individually in ipc-handlers.ts.
// hub-service.test.ts asserts this list and the map above exactly cover the
// invoke surface.
export const ELECTRON_ONLY_CHANNELS: ReadonlySet<string> = new Set([
  IPC_CHANNELS.openFolder, // shell.openPath
  IPC_CHANNELS.copyPath, // clipboard
  IPC_CHANNELS.openVault, // shell.openExternal / openPath
  IPC_CHANNELS.deleteSession, // shell.trashItem
  IPC_CHANNELS.pickFolder, // native dialog
  IPC_CHANNELS.launchWorkflowSession, // shell.openExternal deep link
  IPC_CHANNELS.explainWorkflowSession, // shell.openExternal deep link
  IPC_CHANNELS.editWorkflowSession, // shell.openExternal deep link
  IPC_CHANNELS.launchCommandSession, // shell.openExternal deep link
  IPC_CHANNELS.setWindowTheme, // BrowserWindow.setTitleBarOverlay
  IPC_CHANNELS.popOutDesktopSession, // new BrowserWindow
])

// Push events (webContents.send) — no invoke handler.
export const PUSH_CHANNELS: ReadonlySet<string> = new Set([
  IPC_CHANNELS.liveUpdate,
  IPC_CHANNELS.sandboxJobsChanged,
  IPC_CHANNELS.verifyJobsChanged,
  IPC_CHANNELS.desktopUpdate,
  IPC_CHANNELS.desktopData,
])
