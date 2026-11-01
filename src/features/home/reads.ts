import { useHubRead } from './useHubRead'

// Shared reads for Home widgets. Several widgets need the same source (Needs
// you reads the inbox, the automations and the floor; so do Inbox triage and
// Automation), and one key per source means one IPC call per Home mount.
// Add a reader here rather than calling window.hubApi directly for any source
// a second widget might want. After a mutation, call
// invalidateHubRead(KEYS.inbox) (etc.) so every widget showing it updates.
export const KEYS = {
  projects: 'home:projects',
  latestSessions: 'home:latest-sessions',
  activity: 'home:activity',
  inbox: 'home:inbox',
  globalConfig: 'home:global-config',
  jobFreshness: 'home:job-freshness',
  floor: 'home:floor',
  recall: 'home:recall',
  usage: 'home:usage',
  skills: 'home:skills',
  skillUsage: 'home:skill-usage',
  workflows: 'home:workflows',
  extensions: 'home:extensions',
  vaultGraph: 'home:vault-graph',
} as const

export const useProjects = () => useHubRead(KEYS.projects, () => window.hubApi.listProjects())
export const useLatestSessions = () => useHubRead(KEYS.latestSessions, () => window.hubApi.latestSessionPerProject())
export const useActivity = () => useHubRead(KEYS.activity, () => window.hubApi.getActivityHistory())
export const useInboxRead = () => useHubRead(KEYS.inbox, () => window.hubApi.getVaultInbox())
export const useGlobalConfigRead = () => useHubRead(KEYS.globalConfig, () => window.hubApi.getGlobalConfig())
export const useJobFreshness = () => useHubRead(KEYS.jobFreshness, () => window.hubApi.getJobFreshness())
export const useFloorRead = () => useHubRead(KEYS.floor, () => window.hubApi.getFloorStatus())
export const useRecallRead = () => useHubRead(KEYS.recall, () => window.hubApi.getRecallScorecard())
export const useUsageLimits = () => useHubRead(KEYS.usage, () => window.hubApi.getUsageLimits())
export const useSkillsRead = () => useHubRead(KEYS.skills, () => window.hubApi.listSkills())
export const useSkillUsageRead = () => useHubRead(KEYS.skillUsage, () => window.hubApi.getSkillUsage())
export const useWorkflowsRead = () => useHubRead(KEYS.workflows, () => window.hubApi.listWorkflows())
export const useExtensionsRead = () => useHubRead(KEYS.extensions, () => window.hubApi.getExtensions())
// Anything that writes a note (capture, an inbox approve) invalidates this.
export const useVaultGraphRead = () => useHubRead(KEYS.vaultGraph, () => window.hubApi.getVaultGraph())
// Per-project CLAUDE.md health is a fan-out (one call per registered
// project); use the existing useAllProjectsConfigHealth from shared/ for it.
