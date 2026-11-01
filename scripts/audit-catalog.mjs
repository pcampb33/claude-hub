// Feature catalog for the claude-hub functionality audit.
//
// Every entry was derived from a real enumerator, never guessed:
//   views        <- src/nav.ts VIEWS
//   capabilities <- shared/ipc-types.ts IPC_CHANNELS
//   automations  <- ~/.claude/settings.json hooks + Task Scheduler jobs
//
// `evidence` declares how invocation is detected. A feature with NO probe
// grades `unknown`, never `unused` — the whole point of the instrument.
import os from 'node:os'
import { VAULT_PATH } from '../electron/vault-core.ts'
import { SANDBOX_PATH } from '../electron/registry.ts'

const HOME = os.homedir().replace(/\\/g, '/')
const VAULT = VAULT_PATH.replace(/\\/g, '/')
const SANDBOX = SANDBOX_PATH.replace(/\\/g, '/')

export const FEATURES = [
  // ---- Views (src/nav.ts) -------------------------------------------------
  { id: 'view-dashboard', kind: 'view', name: 'Home',
    claim: 'Customisable widget board: what needs you, live sessions, projects, automation, inbox triage, capture, recall, rate-limit pace, launch pad; each widget opens a detail panel with actions.',
    src: ['src/features/home'],
    channels: ['activity:history', 'usage:limits', 'live:get', 'floor:status'],
    evidence: [] },
  { id: 'view-inbox', kind: 'view', name: 'Inbox',
    claim: 'Review queue for vault candidates the curate hook produced; approve or reject each.',
    src: ['src/features/inbox'],
    channels: ['vault:getInbox', 'vault:resolveInbox', 'vault:quickCapture'],
    evidence: [
      { type: 'artifact', label: 'vault _inbox.md', path: `${VAULT}/_inbox.md` },
      { type: 'dir-count', label: 'inbox backups (execute runs)', path: `${VAULT}/_inbox-backups` },
    ] },
  { id: 'view-sessions', kind: 'view', name: 'Sessions',
    claim: 'Every recent on-disk session with its live state; read transcripts and subagents, resume or delete idle ones.',
    src: ['src/features/sessions'],
    channels: ['sessions:all', 'sessions:read', 'sessions:delete', 'launch:resume-session'],
    evidence: [] },
  { id: 'view-projects', kind: 'view', name: 'Projects',
    claim: 'Registered project list with health, sort, latest session, floor detail and a Run-verify CTA.',
    src: ['src/features/project-list'],
    channels: ['registry:list', 'registry:status', 'sessions:latestPerProject', 'config-health:get'],
    evidence: [{ type: 'json-count', label: 'registered projects', firstParty: true, path: 'registry.json' }] },
  { id: 'view-search', kind: 'view', name: 'Search',
    claim: 'Full-text sweep across session transcripts, beyond the palette byte-budgeted scan.',
    src: ['src/features/session-search'], channels: ['sessions:search'], evidence: [] },
  { id: 'view-skills', kind: 'view', name: 'Skills',
    claim: 'Skill catalog with a usage index; copy to project or promote to global.',
    src: ['src/features/skills'],
    channels: ['skills:list', 'skills:usage', 'skills:promote', 'skills:promote-global', 'skills:promote-and-tailor'],
    evidence: [
      { type: 'artifact', label: 'skill-usage index', path: 'skill-usage-index.json' },
      { type: 'dir-count', label: 'global skills', path: `${HOME}/.claude/skills` },
    ] },
  { id: 'view-knowledge', kind: 'view', name: 'Knowledge',
    claim: 'Vault graph/canvas over the note corpus, plus the recall-experiment scorecard and a Relink button.',
    src: ['src/features/knowledge'],
    channels: ['vault:graph', 'vault:read-note', 'vault:recomputeLinks', 'vault:recall-scorecard'],
    evidence: [
      { type: 'dir-count', label: 'vault notes', path: `${VAULT}`, glob: '.md' },
      { type: 'lines', label: 'link edges sidecar', path: `${VAULT}/_links.jsonl` },
    ] },
  { id: 'view-commands', kind: 'view', name: 'Commands',
    claim: 'Slash-command catalog; launch a session prefilled with one via a claude-cli:// deep link.',
    src: ['src/features/commands'], channels: ['commands:launch-session'],
    // NO PROBE, deliberately. The old one scanned transcripts for
    // `claude-cli://open` and graded this view USED on 126 matches. A real
    // launch goes through shell.openExternal() in the main process
    // (electron/launch.ts:50) and the URL never reaches a transcript at all —
    // so every one of those matches was a session that read or wrote
    // launch.ts. The probe could only ever measure people reading the code.
    // Unmeasured is the honest answer; a wrong measurement is not better.
    evidence: [] },
  { id: 'view-workflows', kind: 'view', name: 'Workflows',
    claim: 'Workflow catalog + composition view, Run-in-session deep link, template-based authoring.',
    src: ['src/features/workflows'],
    channels: ['workflows:list', 'workflows:launch-session', 'workflows:create-from-template', 'workflows:open-in-editor'],
    evidence: [{ type: 'workflow-dirs', label: 'authored workflows (global + per project)' }] },
  { id: 'view-desktop', kind: 'view', name: 'Desktop',
    claim: 'Interactive Claude Code sessions in terminals the hub owns: fixed name, colour and Alt+N slot, live state, and a host process that survives app restarts.',
    src: ['src/features/desktop'],
    channels: ['desktop:get', 'desktop:create', 'desktop:resume', 'desktop:close', 'desktop:forget', 'desktop:update-session', 'desktop:screen', 'desktop:input', 'desktop:resize'],
    evidence: [{ type: 'artifact', label: 'desktop session records', path: 'desktop-sessions.json' }] },
  { id: 'view-extensions', kind: 'view', name: 'Extensions',
    claim: 'MCP servers, plugins and claude.ai connectors: connection health, always-on token cost and transcript usage, with enable/disable for plugins.',
    src: ['src/features/extensions'],
    channels: ['extensions:get', 'extensions:recheck', 'extensions:set-plugin-enabled'],
    evidence: [{ type: 'artifact', label: 'plugin details cache', path: 'extensions-cache.json' }] },
  { id: 'view-usage', kind: 'view', name: 'Usage',
    claim: 'Tokens processed, output tokens and active time per project, experiment and headless bucket, by hour/day/week/month, with a per-session drill-down.',
    src: ['src/features/usage', 'electron/usage-index.ts', 'electron/usage-index-core.ts'],
    channels: ['usage:report', 'usage:sessions'],
    evidence: [{ type: 'artifact', label: 'transcript usage index', path: 'usage-index.json' }] },
  { id: 'view-sandbox', kind: 'view', name: 'Sandbox',
    claim: 'Throwaway experiment workspaces; Draft Learnings and Queue-to-Inbox turn one into a vault candidate.',
    src: ['src/features/sandbox'],
    channels: ['sandbox:list-experiments', 'sandbox:create-experiment', 'sandbox:draft-learnings', 'sandbox:queue-to-inbox', 'sandbox:list-jobs'],
    evidence: [{ type: 'dir-count', label: 'experiments on disk', firstParty: true, path: `${SANDBOX}` }] },
  { id: 'view-rubric', kind: 'view', name: 'Rubric',
    claim: 'Edit the curation rubric that steers what the curate hook considers vault-worthy.',
    src: ['src/features/rubric-settings'], channels: ['rubric:get', 'rubric:save'], evidence: [] },

  // ---- Automations (settings.json hooks + Task Scheduler) -----------------
  { id: 'auto-curate', kind: 'automation', name: 'Curate hook (SessionEnd)',
    claim: 'Global SessionEnd hook: haiku triage, then sonnet extraction queues vault candidates to _inbox.md.',
    src: ['scripts/curate-session.mjs', 'electron/curate-core.ts'],
    evidence: [
      { type: 'log', label: 'curate runs', firstParty: true, path: 'scripts/curate-session.log', pattern: 'done: triage=' },
      { type: 'log', label: 'runs that queued a candidate', firstParty: true, path: 'scripts/curate-session.log', pattern: 'queued' },
    ] },
  { id: 'auto-recall', kind: 'automation', name: 'Vault recall hook (UserPromptSubmit)',
    claim: 'Global UserPromptSubmit hook: detached haiku worker matches the task against vault titles, injects up to 3.',
    src: ['scripts/vault-recall.mjs', 'electron/recall-core.ts'],
    evidence: [
      { type: 'log', label: 'worker runs', firstParty: true, path: 'scripts/vault-recall.log', pattern: 'worker done' },
      { type: 'log', label: 'workers that found a match', firstParty: true, path: 'scripts/vault-recall.log', pattern: 'worker done: match' },
      // lineTest is mandatory for a first-party transcript probe: without it
      // this counted 72 where 14 were real, because every session that read
      // recall-core.ts put the same sentence in its own transcript.
      { type: 'transcript', label: 'injections delivered into a session', firstParty: true,
        pattern: 'The personal knowledge vault has prior findings', lineTest: 'recall-injection' },
    ] },
  { id: 'auto-linker', kind: 'automation', name: 'Vault linker (daily 04:30 task)',
    claim: 'Daily incremental linker: per-note sonnet calls build _links.jsonl and re-materialize Related blocks.',
    src: ['scripts/link-vault.mjs', 'electron/vault-linker-run.ts', 'electron/vault-linker-core.ts'],
    evidence: [
      { type: 'log', label: 'linker runs', firstParty: true, path: 'scripts/link-vault.log', pattern: 're-linked' },
      { type: 'task', label: 'scheduled task', firstParty: true, name: 'claude-hub vault linker', log: 'scripts/link-vault.log' },
    ] },
  { id: 'auto-drain', kind: 'automation', name: 'Inbox drain (daily noon task)',
    claim: 'Daily sonnet pass clusters _inbox.md by meaning, drops duplicates and auto-promotes high-confidence reps.',
    src: ['scripts/drain-inbox.mjs', 'electron/inbox-drain-core.ts'],
    evidence: [
      { type: 'log', label: 'drain runs', firstParty: true, path: 'scripts/drain-inbox.log', pattern: 'exit:' },
      { type: 'task', label: 'scheduled task', firstParty: true, name: 'claude-hub inbox drain', log: 'scripts/drain-inbox.log' },
    ] },
  { id: 'auto-materialize', kind: 'automation', name: 'Materialize links / MOCs',
    claim: 'Renders _links.jsonl into each note as a Related block and regenerates MOCs/ entry pages.',
    src: ['scripts/materialize-links.mjs', 'electron/vault-related-core.ts', 'electron/vault-moc-core.ts'],
    evidence: [
      { type: 'grep-count', label: 'notes carrying a Related block', firstParty: true, dir: `${VAULT}`, pattern: '## Related' },
      { type: 'dir-count', label: 'MOC pages', firstParty: true, path: `${VAULT}/MOCs` },
    ] },
  { id: 'auto-scorecard', kind: 'automation', name: 'Recall scorecard',
    claim: 'Parses vault-recall.log and scans transcripts for Reads of offered notes: attempts to offers to delivered to read.',
    src: ['scripts/recall-scorecard.mjs', 'electron/recall-scorecard.ts'], evidence: [] },

  // ---- Capabilities (IPC_CHANNELS, no view of their own) ------------------
  { id: 'cap-verify', kind: 'capability', name: 'Floor / verify runner',
    claim: 'Runs each project own definition-of-done command from the hub and streams the result.',
    src: ['electron/run-verify.ts', 'electron/verify-jobs.ts', 'electron/floor-core.ts', 'scripts/record-verify.mjs'],
    channels: ['floor:status', 'floor:runVerify', 'floor:list-verify-jobs'],
    evidence: [{ type: 'log', label: 'verify runs recorded', firstParty: true, path: 'scripts/record-verify.log', pattern: 'done:' }] },
  { id: 'cap-palette', kind: 'capability', name: 'Command palette (Ctrl+K)',
    claim: 'One search box over sessions, notes, skills and workflows; the only door to the Search view.',
    src: ['src/features/command-palette'], evidence: [] },
  { id: 'cap-config-health', kind: 'capability', name: 'Config health / cross-project redundancy',
    claim: 'Grades each project Claude Code configuration and finds duplicated config across projects.',
    src: ['electron/config-health.ts'], channels: ['config-health:get', 'config-health:cross-project'], evidence: [] },
  { id: 'cap-activity', kind: 'capability', name: 'Activity history',
    claim: 'Per-day activity from an incremental JSONL scan, stacked by project on the dashboard.',
    src: ['electron/activity-core.ts'], channels: ['activity:history'], evidence: [] },
  { id: 'cap-usage', kind: 'capability', name: 'Usage / rate-limit KPIs',
    claim: '5h and weekly rate-limit tiles from the OAuth usage endpoint, under a no-refresh rule.',
    src: ['electron/usage.ts'], channels: ['usage:limits'], evidence: [] },
  { id: 'cap-live', kind: 'capability', name: 'Live status watcher',
    claim: 'Watches transcripts for activity and pushes a live snapshot; drives NowPlaying and the elapsed/idle badges.',
    src: ['electron/live.ts', 'electron/live-core.ts'], channels: ['live:get'], evidence: [] },
  { id: 'cap-subagents', kind: 'capability', name: 'Subagent viewer',
    claim: 'Shows the subagents a session deployed, read from the transcript sibling subagents dir.',
    src: ['electron/subagents.ts'], channels: ['sessions:list-subagents', 'sessions:read-subagent'],
    evidence: [{ type: 'subagent-dirs', label: 'transcript dirs holding subagent records', path: `${HOME}/.claude/projects` }] },
  { id: 'cap-launch', kind: 'capability', name: 'Launch actions',
    claim: 'Open folder / VS Code / terminal / remote-control / CLAUDE.md / resume-session from the hub.',
    src: ['electron/launch.ts', 'electron/launch-core.ts'],
    channels: ['launch:open-folder', 'launch:open-vscode', 'launch:open-terminal', 'launch:remote-control', 'launch:resume-session'],
    evidence: [] },
  { id: 'cap-skill-usage', kind: 'capability', name: 'Skill usage index',
    claim: 'Counts where each skill is actually invoked, so a skill catalog entry carries evidence.',
    src: ['electron/skill-usage.ts'], channels: ['skills:usage'],
    evidence: [{ type: 'artifact', label: 'usage index', firstParty: true, path: 'skill-usage-index.json' }] },
  { id: 'cap-job-freshness', kind: 'capability', name: 'Automation freshness',
    claim: 'Per-job freshness for the hooks and scheduled jobs: ran when, is it overdue, last log line verbatim.',
    src: ['electron/job-freshness.ts'], channels: ['jobs:freshness'], evidence: [] },
  { id: 'cap-quick-capture', kind: 'capability', name: 'Quick capture',
    claim: 'Write a vault note straight from the hub, firing a non-blocking per-note link recompute.',
    src: ['electron/vault-write-core.ts'], channels: ['vault:quickCapture'], evidence: [] },
]
