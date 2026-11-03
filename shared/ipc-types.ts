// Shared contract between main and renderer. Both sides import from here —
// this is the single source of truth for what the IPC surface looks like.

export interface RegistryEntry {
  id: string
  name: string
  path: string
  pinned?: boolean
  addedAt: string
  // Verify chain for the floor-status dashboard. Hand-editable in
  // registry.json, or set from the floor card via setVerifyCommand (it runs
  // on the hub machine when Run verify is clicked). Absent = project has no
  // configured floor.
  verifyCommand?: string
}

export interface GitStatus {
  branch: string
  dirty: boolean
  lastCommitDate: string | null
  lastCommitMessage: string | null
}

export interface ProjectStatus {
  pathExists: boolean
  git: GitStatus | null // null if path is missing or not a git repo
  sessionCount: number
  // Session directories the scan could not classify even at the wide head.
  // sessionCount excludes them, so a non-zero value here means the count is a
  // floor, not a total — without it an unreadable directory silently became
  // zero sessions and was rendered as fact.
  unreadableSessionDirs: number
  lastActivity: string | null // ISO timestamp of the newest session file's mtime
  claudeMdExcerpt: string | null
}

// Metadata-only summary — cheap to produce, never fully parses a session
// file. Safe to compute for every session in a project's list view even
// when files run 20MB+.
export interface SessionSummary {
  id: string // filename without the .jsonl extension
  date: string // ISO timestamp, from the file's mtime
  title: string // first user message text, truncated; '(no message found)' if none
}

export interface SessionMessage {
  role: 'user' | 'assistant'
  text: string
  timestamp: string
}

// One subagent a session deployed, from <session-dir>/<sessionId>/subagents/**.
// Metadata-only: built from the agent's meta.json, the transcript's first
// timestamped line, and its mtime — never a full transcript parse (files run
// to 7MB). Claude Code writes no status/token fields, so completion can only
// be inferred by reading the transcript.
export interface SubagentSummary {
  id: string // <agentId> from the agent-<agentId>.* filename
  agentType: string // meta.json agentType; 'unknown' when the meta is missing/malformed
  description: string // meta.json description, else the first line of the agent's own prompt; '' when neither
  spawnDepth: number // meta.json spawnDepth; 1 when missing
  startedAt: string | null // first timestamped transcript line; null = no transcript
  endedAt: string | null // transcript file mtime (ISO); null = no transcript
  hasTranscript: boolean // false = meta-only (killed / never ran) — nothing to open
  worktreeBranch?: string // present for worktree-isolated agents
}

// One row of the cross-project Sessions list. Unlike SessionSummary (which is
// metadata-only, per project) this carries the session's own live state, so
// the list can answer "which window is which, and which is running".
export interface SessionListEntry {
  sessionId: string
  projectId: string // registry id — the launch/steer surfaces resolve paths from this, never a raw path
  projectName: string
  projectPath: string // for the read-only readSession() call, which is path-keyed like the per-project list
  title: string
  state: LiveSessionState
  model?: string
  lastToolName?: string
  waitingFor?: string // set while state is 'waiting': what it waits on ("approve Bash: npm test")
  lastTimestamp?: string // ISO, newest timestamped transcript line
  contextPct?: number // 0-100, newest assistant usage vs approximate model context limit
  date: string // ISO, from the transcript's mtime
}

export interface VaultInfo {
  path: string
}

// One session the recall hook computed an offer for (matched or delivered),
// plus what the session's transcript shows happened to it. Part of the
// bounded recall experiment's scorecard (scripts/vault-recall.mjs).
export interface RecallOffer {
  sessionId: string
  project: string
  at: string // ISO timestamp of the attempt
  titles: string[] // offered note titles (= vault filenames)
  delivered: boolean // false = matched but the session never got a second prompt
  transcriptFound: boolean // e2e/test session ids have no transcript on disk
  markerSeen: boolean // [vault-recall] marker present in the transcript
  readTitles: string[] // offered titles later Read in the session or its subagents — the hits
  unparsedLines: number // tool_use lines that would not parse: reads unknown here, not absent
}

// The numbers the recall experiment's verdict is gated on: do offered notes
// actually get read? spendUsd is the haiku matcher's cumulative cost.
export interface RecallScorecard {
  attempts: number
  noMatch: number
  offers: RecallOffer[] // newest first
  delivered: number
  readSessions: number // delivered sessions where ≥1 offered note was read
  incompleteScans: number // read-0 sessions whose transcript had unparseable lines — "unknown", not "no"
  spendUsd: number
  errors: number
  since: string | null // first attempt timestamp; null = hook never fired
}

// Whether each background automation is actually current. The hooks and
// scheduled jobs do this system's real work and were the one layer with no
// on-screen state at all: a job that stops running just stops writing to its
// log, which reads as quiet rather than broken.
//
// 'unknown' is a first-class answer, not a fallback — a missing or undated log
// means nobody can tell, which is different from a job that has stopped.
// 'event-driven' jobs fire per session and have no schedule to be late against.
export interface JobFreshness {
  id: string
  label: string
  state: 'current' | 'stale' | 'event-driven' | 'unknown'
  detail: string // why this state, in words the UI can show verbatim
  lastLine: string | null // the log's final line; null = no log or empty
  lastRunIso: string | null // null = no parseable timestamp, NOT "never ran"
  hoursSince: number | null
  // What the job's model calls cost, read off the `cost=` its runs log. null =
  // the log could not be read, so spend is unknown — never 0.
  spend: { day: JobSpendWindow; week: JobSpendWindow; month: JobSpendWindow } | null
}

// One window of spend (24h / 7d / 30d before now).
export interface JobSpendWindow {
  usd: number // sum of the costs the runs reported; a floor when unknownCostRuns > 0
  runs: number // paid runs: a reported cost above $0, or `cost=n/a`
  unknownCostRuns: number // runs that logged `cost=n/a` — paid, amount unknown, not $0
}

// ---- Extensions: MCP servers, plugins, claude.ai connectors ----------------
// Sources: `claude mcp list` (a ~7s health check of every server, run in the
// background and cached), `claude plugin list --json`, `claude plugin
// details` (always-on token cost per plugin), ~/.claude.json, and the
// transcript scan of mcp__<server>__<tool> calls.
export type ExtensionKind = 'mcp' | 'plugin' | 'connector'

// From the last health check, or a plugin's enabled flag.
// - 'unchecked': no health check has completed, or the last one failed. Never
//   render it as fine, and never as absent.
// - 'not-listed': known from config or history but missing from the last
//   check (e.g. a claude.ai connector that was connected once).
// - 'unknown': the CLI printed a status this parser does not recognise;
//   statusText carries it verbatim.
export type ExtensionStatus =
  | 'connected'
  | 'needs-auth'
  | 'failed'
  | 'not-configured'
  | 'pending-approval'
  | 'enabled'
  | 'disabled'
  | 'not-listed'
  | 'unchecked'
  | 'unknown'

export interface ExtensionComponentCost {
  name: string
  kind: 'skill' | 'command' | 'agent' | 'other'
  // null = the CLI did not report it.
  alwaysOnTokens: number | null
  onInvokeTokens: number | null
}

export interface ExtensionItem {
  // Stable across reads, e.g. 'mcp:playwright', 'plugin:engineering@synced',
  // 'mcp:plugin:design:slack', 'connector:claude.ai Gmail'.
  id: string
  kind: ExtensionKind
  name: string
  // 'user' | 'project' | 'local' | 'synced' | 'plugin' | 'claude.ai' | …
  scope: string
  status: ExtensionStatus
  // The CLI's own status words, when there were any.
  statusText: string | null
  // Command line or URL. Never environment values.
  target: string | null
  // A plugin's own id; for a plugin-bundled server, the owning plugin's id.
  pluginId: string | null
  projectPath: string | null
  // null = the usage scan could not run; an item that was scanned and never
  // called has calls: 0.
  usage: { calls: number; lastUsedIso: string | null; topTools: { tool: string; count: number }[] } | null
  // Plugins only. null = not measured — always null for MCP servers, whose
  // tool schemas the CLI does not count.
  alwaysOnTokens: number | null
  components: ExtensionComponentCost[]
  // Plugins only: `claude plugin details` failed, so alwaysOnTokens/components
  // are unknown rather than "not reported".
  detailsError?: string
}

export interface ExtensionsSnapshot {
  items: ExtensionItem[]
  health: { state: 'ok' | 'running' | 'error' | 'never'; checkedAtIso: string | null; error: string | null }
  // running: the first transcript scan has not finished, so there is no usage
  // yet (state 'error', items' usage null) — "not yet", not "couldn't".
  usage: { state: 'ok' | 'error'; error: string | null; sinceIso: string | null; running?: boolean }
  generatedAtIso: string
}

// Settings → Theme. Nord is the default.
export const THEME_IDS = ['nord', 'catppuccin', 'clay'] as const
export type ThemeId = (typeof THEME_IDS)[number]

// ---------------------------------------------------------------- global ---
// The layer above every project: the ~/.claude hooks that run in every session,
// the Windows scheduled jobs, and the settings that are not per-project.
//
// `state` is a verdict about whether the thing is DOING ITS JOB, never about
// whether it is configured. Task Scheduler answers "did Windows start the
// process" — it once reported `Running` for a server task that was not
// reachable — so a row that has only scheduler state and no work probe grades
// 'unknown', never 'ok'.
export type GlobalItemState = 'ok' | 'attention' | 'unknown'

export interface GlobalAutomation {
  id: string
  label: string
  kind: 'hook' | 'scheduled'
  trigger: string // "SessionEnd" | "daily 04:45" — when it is supposed to run
  command: string
  state: GlobalItemState
  detail: string // why this state, in words the UI shows verbatim
  // Its model calls cost more than the 7-day ceiling (job-freshness.ts
  // spendBreach). False when under it or when spend is unknown.
  overBudget: boolean
  lastRunIso: string | null // null = never ran, or nobody could tell (see detail)
  // Conditions that don't change the verdict but change what to expect of it —
  // e.g. a task that silently skips a run if the machine is asleep.
  warnings: string[]
  taskName: string | null // Task Scheduler handle; the only thing runGlobalTask accepts
  running: boolean // scheduled only — drives Restart vs Run now
  logId: string | null // openGlobalFile id for this automation's log
}

export interface GlobalSettings {
  path: string
  // null everywhere = the file could not be read; `error` says why. The UI must
  // not render defaults for an unread file — an empty permission list and an
  // unreadable one are not the same fact.
  error: string | null
  model: string | null
  effortLevel: string | null
  // modelSettings.<model>.effortLevel — each one overrides `effortLevel` for
  // that model, so showing the top-level value alone misreports what runs.
  modelEffortLevels: { model: string; effortLevel: string }[]
  permissionsAllow: number | null
  permissionsDeny: number | null
  statusLineCommand: string | null
  claudeMdBytes: number | null // ~/.claude/CLAUDE.md, applied to every project
  globalSkills: string[] // ~/.claude/skills, available in every project
}

export interface GlobalConfigReport {
  generatedAt: string
  automations: GlobalAutomation[]
  settings: GlobalSettings
  // Non-null when the Task Scheduler query itself failed: every scheduled row
  // then reports 'unknown' and this says why, rather than the page implying
  // there are no scheduled jobs.
  schedulerError: string | null
  footprint: HubFootprint
}

// Everything claude-hub has applied outside its own folder, read from the real
// state each time (electron/footprint.ts), so it can't drift from what is
// actually there. Anything new that writes outside the folder belongs here.
export interface HubFootprint {
  // Where the global hooks act (electron/hook-scope.ts). error = the registry
  // couldn't be read, so the hooks are running on the workspace alone.
  scope: { workspace: string; outside: { name: string; path: string }[]; error: string | null }
  // Last 30 days, from the hooks' own logs. null = that log couldn't be read
  // (a missing log is 0: the hook has not run).
  // reviewed = sessions curate paid a model call for; outside = stood down out of scope.
  curate: { reviewed: number; outside: number } | null
  recallOutside: number | null
  // Projects whose .claude/settings.local.json carry deny rules the hub wrote.
  // null = boundaries.json couldn't be read; denyRulesError says why.
  denyRules: { name: string; rules: number }[] | null
  denyRulesError: string | null
  folders: { label: string; path: string }[]
  // The Start Menu shortcut carrying the app ID (electron/app-identity.ts).
  // present null = couldn't check.
  startMenuShortcut: { path: string; present: boolean | null }
}

export interface VaultNote {
  id: string // filename without .md — also the [[link]] title
  title: string
  excerpt: string | null
  outgoingLinks: string[] // note ids this note links to (dangling links dropped)
  backlinks: string[] // note ids that link to this note
  mtime: string
  // ISO birth time. Recency reads THIS, not mtime: the daily linker rewrites
  // every note's `## Related` block, so mtime says "links refreshed", not
  // "note written" — a July note showed as new the morning after a relink.
  createdAt: string
  project: string | null // originating project (frontmatter or inferred) — the graph's grouping key; null = cross-project
}

// Edge kinds: 'authored' is a hand-written [[wikilink]] (the strongest signal);
// the other three are LLM-computed connection types (see electron/vault-linker-core.ts).
export type VaultEdgeKind = 'authored' | 'causal' | 'generalization' | 'see-also'

// A rendered graph edge. weight (0–1) drives thickness/opacity — authored links
// are weight 1, LLM-computed edges carry their own strength. kind is stored
// (directed source→target) for later edge coloring; the graph renders undirected.
export interface VaultEdge {
  source: string
  target: string
  weight: number
  kind: VaultEdgeKind
}

export interface VaultGraphData {
  notes: VaultNote[]
  edges: VaultEdge[]
}

export interface SkillEntry {
  id: string // absolute path to the skill's folder — stable key, and the "copy source" for promoteToProject
  name: string
  description: string | null
  path: string
  source: 'global' | '.claude/skills' | '.agents/skills'
  projectId: string | null // registry entry id; null for the global (~/.claude/skills) source
  projectName: string // 'global' or the owning project's name, for display grouping
  mtime: string // ISO, mtime of the skill's folder — for "recently touched" ordering
}

export interface PromoteResult {
  ok: boolean
  reason?: 'conflict' | 'source-missing' | 'target-missing' | 'error'
  message?: string
}

// One recorded Skill-tool invocation. The session corpus keys transcripts by
// an encoded project dir, so `project` is the registry project's display name
// when the dir maps to a registered project, else the raw dir basename;
// `sessionId` is the transcript basename — a best-effort link into Sessions
// (the session file may since have been pruned).
export interface SkillInvocationRecord {
  ts: string // ISO timestamp
  project: string
  projectId: string | null // registry id when the session dir belongs to a registered project
  sessionId: string
}

// Aggregated Skill-tool invocation stats, keyed by the invoked skill name
// (the `input.skill` recorded in session transcripts). Kept separate from
// SkillEntry so listSkills() stays cheap — the usage index scans the whole
// session corpus and merges in on the renderer side.
export interface SkillUsage {
  skill: string // the invoked name, matched against SkillEntry.name
  count: number
  lastUsed: string // ISO timestamp of the most recent invocation
  invocations: SkillInvocationRecord[] // newest-first, every recorded invocation
}

// A single agent() call site statically found in a workflow script's body.
// This is the *declared* structure, not a runtime trace: an agent spawned
// inside a loop or with a computed label is one call site here even though
// it runs N times (WorkflowComposition.dynamic flags that case).
export interface WorkflowStep {
  label: string | null // opts.label, verbatim (may be a `template ${literal}`)
  prompt: string | null // the agent()'s first arg when it's a string/template literal (unwrapped, ${...} kept verbatim); null when the prompt is a computed expression (e.g. d.prompt)
  phase: string | null // opts.phase, else the nearest preceding phase() call
  model: string | null
  effort: string | null
  agentType: string | null
  structured: boolean // opts.schema present → forced structured output
  worktree: boolean // opts.isolation === 'worktree'
}

export interface WorkflowPhase {
  title: string
  detail: string | null // from meta.phases[].detail
  steps: WorkflowStep[] // agent steps that map to this phase
}

// Orchestration shape, detected by presence in the script body. Coarse by
// design — precise nesting needs a real AST; these flags + `dynamic` are
// what's reliably extractable without executing the script.
export interface WorkflowOrchestration {
  usesPipeline: boolean
  usesParallel: boolean
  usesLoop: boolean // for/while wrapping agent work
  callsSubWorkflow: boolean // workflow(...) — composes another workflow
}

export interface WorkflowComposition {
  phases: WorkflowPhase[] // meta phases first, then any phase only referenced in the body
  unphasedSteps: WorkflowStep[] // agent calls that mapped to no phase
  orchestration: WorkflowOrchestration
  agentCount: number // count of static agent() call sites (a lower bound when dynamic)
  dynamic: boolean // loops / .map fan-out → real agent count exceeds agentCount
  args: string[] // arg keys the body reads (args.X / alias.X) — the workflow's input contract, for the How-to-use invocation
}

// A starter shape offered by "New workflow" (content stays main-process side).
export interface WorkflowTemplate {
  key: string
  label: string
  description: string
  shape: string[] // orchestration-shape chips for the gallery card (e.g. ['pipeline','parallel'])
}

// Result of scaffolding a new workflow from a template.
export interface CreateWorkflowResult {
  ok: boolean
  path?: string // absolute path of the created .js (on success) — used to open/refine it
  name?: string // the sanitized workflow name actually used
  reason?: 'unknown-template' | 'invalid-name' | 'conflict' | 'target-missing' | 'error'
  message?: string
}

export interface WorkflowEntry {
  id: string // absolute path to the .js file — stable key and the copy source for promote
  name: string // meta.name, else the filename
  description: string | null // meta.description
  whenToUse: string | null // meta.whenToUse
  example: string | null // meta.example — a concrete "here's when/how you'd run it" the author bakes into the script
  path: string // absolute .js path (== id; kept for parity with SkillEntry)
  source: 'global' | '.claude/workflows'
  projectId: string | null // registry id; null for the global (~/.claude/workflows) source
  projectName: string // 'global' or the owning project's name, for display grouping
  mtime: string // ISO, for "recently touched" ordering
  composition: WorkflowComposition
  parseError: string | null // non-null if the meta block couldn't be parsed (still listed by filename)
}

export interface ExperimentEntry {
  name: string
  path: string
  hasLearnings: boolean
  learningsExcerpt: string | null // first non-empty line, for the master-row hint
  learningsContent: string | null // full LEARNINGS.md, for the detail pane; null without learnings
  // A real (non-headless) session progressed after LEARNINGS.md was written —
  // the draft is missing the session's ending. Always false without learnings.
  learningsStale: boolean
  lastModified: string // ISO, mtime of the experiment folder
}

export interface DraftLearningsResult {
  ok: boolean
  message?: string
  title?: string // one sentence, present on success if the model followed the response format
  bullets?: string[] // 3-5 items expanding on the title
  critical?: string[] // may be empty even on success — nothing flagged as critical
  // What the draft was actually generated from — surfaced so truncation and
  // thin material are visible instead of silently degrading the draft.
  stats?: { sessions: number; chars: number; truncated: boolean }
}

export type SandboxJobPhase = 'drafting' | 'summarizing'

// A running Draft Learnings background job (two sequential `claude -p` calls
// in the main process). Tracked centrally so the UI survives navigation and
// can cancel — not tied to any one card's component state.
export interface SandboxJob {
  id: string
  experimentPath: string
  experimentName: string
  phase: SandboxJobPhase
  startedAt: string // ISO
}

// What the post-write vault commit did. Declared here rather than in
// electron/vault-git.ts because it rides VaultWriteResult across IPC, and
// shared/ must not import from electron/.
export type VaultCommitOutcome =
  | { kind: 'committed'; sha: string }
  | { kind: 'nothing-to-commit' }
  | { kind: 'not-a-repo' }
  | { kind: 'failed'; message: string }

export interface VaultWriteResult {
  ok: boolean
  notePath?: string
  message?: string
  // A typed discriminant, NOT prose in `message`, because a caller has to be
  // able to branch on it: `failed` means the note was written and the safety
  // net did not hold, which is the one case an unattended job must log loudly.
  // The house rule this obeys is stated on QueueResult in this same file —
  // overloading `message` was the first draft and it would have forced the UI
  // to string-match /FAILED/ to find out whether the vault is protected.
  commit?: VaultCommitOutcome
}

// Result of an incremental link recompute (electron/vault-linker-run.ts):
// how many stale/new notes were re-linked and the sidecar's edge total after.
export interface RecomputeLinksResult {
  ok: boolean
  linkedNotes: number
  edgeCount: number
  message?: string
}

// Result of saving the curation rubric (electron/rubric-core.ts). ok=false
// carries a reason in message (e.g. a blank rubric, or a filesystem error).
export interface RubricSaveResult {
  ok: boolean
  message?: string
}

// Outcome of queueing an experiment's learnings to the vault inbox. Carries
// skippedDuplicate as a typed flag (not buried in `message`) so the UI can
// say "already queued" distinctly from a fresh queue — the inbox dedups by
// title, and a silent success would read as if a second copy was added.
export interface QueueToInboxResult {
  ok: boolean
  skippedDuplicate?: boolean
  message?: string
}

export interface ConfigHealthFinding {
  id: string
  source: 'project' | 'global'
  sectionHeading: string | null // null if the finding is before the first heading
  kind: 'unconditional-read' | 'stale-reference' | 'oversized-section' | 'redundant-content' | 'skill-shaped-candidate'
  severity: 'info' | 'warn'
  excerpt: string
  detail: string
  estimatedTokens: number | null // populated for section-level findings, used for ranking
}

export interface ConfigHealthFileSummary {
  exists: boolean
  path: string
  estimatedTokens: number | null // includes tokens pulled in via @-imports, at least one level deep
}

export interface ConfigHealthReport {
  projectPath: string
  generatedAt: string
  project: ConfigHealthFileSummary
  global: ConfigHealthFileSummary
  combinedEstimatedTokens: number
  mcpUnmeasured: boolean // always true in v1 — explicitly surfaced, not silently omitted
  findings: ConfigHealthFinding[] // sorted by estimated token impact, highest first
  score: number // 0-100
}

// Cross-project comparison, kept separate from ConfigHealthReport
// (project + global CLAUDE.md only) rather than overloading its
// single-path contract — same "no path argument, operates on all
// registered projects" shape searchSessions already established.
export interface CrossProjectRedundancyFinding {
  projectAName: string
  projectAPath: string
  projectBName: string
  projectBPath: string
  sectionHeading: string | null
  otherSectionHeading: string | null
  excerpt: string
  similarity: number
  estimatedTokens: number | null
}

export interface CrossProjectRedundancyReport {
  generatedAt: string
  scannedProjectCount: number
  findings: CrossProjectRedundancyFinding[] // sorted by estimatedTokens, highest first
}

// One line of verify-ledger.jsonl (append-only, machine-local, lives next
// to registry.json at APP_ROOT). Written by scripts/record-verify.mjs.
export interface VerifyRunRecord {
  v: 1 // schema version, per-line
  projectPath: string // registry's canonical path, resolved at record time
  timestamp: string // ISO
  ok: boolean
  exitCode: number | null
  durationMs: number
  command: string // the verifyCommand that ran, frozen into the record
}

export type FloorDayStatus = 'green' | 'red' | 'none'

export interface ProjectFloorStatus {
  id: string
  name: string
  path: string
  verifyCommand: string | null // null = not configured
  latest: VerifyRunRecord | null // null = configured but never recorded
  // null = no runs; 0 = latest run is red; otherwise consecutive days with a
  // green run, ending at the day of `latest` — days nobody ran don't count.
  streakDays: number | null
  days: { date: string; status: FloorDayStatus }[] // oldest→newest, fixed window
}

export interface FloorStatusReport {
  generatedAt: string
  historyDays: number // 14
  projects: ProjectFloorStatus[]
}

// A running Run-verify spawn (electron/run-verify.ts), tracked centrally in
// electron/verify-jobs.ts — the floor counterpart of SandboxJob, so the UI
// can show live output, elapsed time, and cancel across navigation.
export interface VerifyJob {
  id: string
  projectId: string // registry id the run was started for
  projectName: string
  command: string // the verifyCommand being run
  startedAt: string // ISO
  outputTail: string // bounded tail of interleaved stdout+stderr
}

// Live session intelligence, derived from the tail of each project's
// newest transcript in ~/.claude/projects. 'active' = fresh activity and
// the turn hasn't closed yet; 'idle' = fresh activity but the turn ended
// (turn_duration/stop_hook_summary observed after it); 'ended' = nothing
// recent. 'waiting' = the turn is open but blocked on you (a permission
// prompt, AskUserQuestion): Claude Code's own process record says so, or, when
// those records can't be read, the transcript's unanswered tool call does.
// 'waiting' is as in-use as 'active': resuming it would kill the live reader.
export type LiveSessionState = 'active' | 'waiting' | 'idle' | 'ended'

// One recent assistant turn, for the hero's work-rhythm waveform: bar height =
// output tokens, color = whether the turn called a tool vs. produced text.
export interface RecentTurn {
  output: number // output_tokens the assistant produced this turn
  input: number // input cost this turn = input + cache_read + cache_creation tokens
  tool: boolean // true if the turn contained a tool_use block
}

export interface LiveProjectStatus {
  registryId: string
  name: string
  // Id of the transcript this status was derived from (the newest one in the
  // project). Lets the live strip deep-link into that session's detail view.
  sessionId?: string
  state: LiveSessionState
  lastToolName?: string
  waitingFor?: string // set while state is 'waiting': what it waits on ("approve Bash: npm test")
  lastTimestamp?: string // ISO, newest timestamped transcript line
  sessionStart?: string // ISO, first timestamped line — true session start (elapsed = now - this)
  model?: string
  aiTitle?: string
  contextPct?: number // 0-100, newest assistant usage vs approximate model context limit
  contextTokens?: number // raw newest-usage tokens (input + cache_read + cache_creation)
  contextLimit?: number // the session model's own approximate context window
  recentTurns?: RecentTurn[] // oldest→newest, last ~24 assistant turns (feeds the turns-of-room estimate)
  // Where the session's wall-clock time went, from its whole transcript
  // (electron/session-activity-core.ts). Live (non-ended) sessions only.
  // Absent with `activityError` set when the transcript could not be read —
  // never an empty timeline standing in for a failure.
  activity?: SessionActivity
  activityError?: string
}

// What a slice of a session's wall-clock time was spent on. 'waiting' = the
// turn was over (or a tool needed your permission click) and the session sat
// until you answered; 'thinking' = the model producing its next line after a
// prompt or a tool result; edit/shell/read/agent/web/other = a tool_use
// awaiting its tool_result; 'background' = the turn was over and the next
// thing to arrive was an agent or task notification, not you.
export type ActivityKind = 'waiting' | 'thinking' | 'edit' | 'shell' | 'read' | 'agent' | 'web' | 'other' | 'background'
export type ToolCategory = 'edit' | 'shell' | 'read' | 'agent' | 'web' | 'other'

export interface ActivitySegment {
  startMs: number
  endMs: number
  kind: ActivityKind
}

// A gap between two transcript lines longer than 2h, drawn compressed rather
// than to scale.
export interface ActivityBreak {
  startMs: number
  endMs: number
}

// The session's state at its newest transcript line.
export type ActivityNow =
  | { state: 'running'; cat: ToolCategory; tool: string; target: string; sinceMs: number }
  | { state: 'waiting'; sinceMs: number; tool?: string; target?: string }
  | { state: 'thinking'; sinceMs: number; tool?: string; target?: string }

export interface SessionActivity {
  // The returned timeline covers [windowStartMs, endMs] — the last ~6h of
  // wall time — and segments + breaks sum exactly to that span.
  windowStartMs: number
  endMs: number
  startMs: number // first transcript line: the window is truncated when this is earlier than windowStartMs
  segments: ActivitySegment[] // ≤ ~200, merged and coarsened to fit
  breaks: ActivityBreak[]
  longestWait?: ActivitySegment // longest 'waiting' stretch inside the window
  // Whole-session figures (not just the window). totals exclude break time.
  totals: Partial<Record<ActivityKind, number>>
  breakMs: number
  breakCount: number
  waitedMs: number // totals.waiting: in-session waits, breaks excluded
  editsCount: number // Edit/Write/MultiEdit/NotebookEdit calls in the main transcript (not subagents')
  filesEdited: number
  now?: ActivityNow // absent only when the transcript has no timestamped user/assistant/system line yet
}

export interface LiveStatusSnapshot {
  projects: LiveProjectStatus[]
  updatedAt: string
}

export interface SessionSearchMatch {
  projectId: string
  projectName: string
  projectPath: string
  sessionId: string
  date: string
  title: string
  snippet: string
  matchCount: number // matches found in this session, capped per-file
  // Present when the hit came from one of the session's subagent transcripts
  // rather than its own turns. title/sessionId still identify the parent
  // session, so a subagent hit says where it came from as well as what it was.
  agent?: { id: string; agentType: string; description: string }
}

// Where a budgeted scan stopped, so the next call can resume from exactly
// there. Compound rather than a bare mtime because transcripts written in the
// same millisecond are common (a fan-out, a fresh clone): with only an mtime to
// resume from, a tie either re-scans the same files forever or drops them.
export interface SessionSearchCursor {
  mtimeMs: number
  sessionId: string
}

export interface SessionSearchResult {
  query: string
  // Always searches every registered project — no filter, per the
  // council's resolution (a silent false-negative is worse than
  // cross-project noise). currentProjectId only affects sort order:
  // matches from that project come first, everything else follows by date.
  matches: SessionSearchMatch[]
  scannedSessionCount: number
  truncated: boolean // true if the global result cap was hit before exhausting all sessions
  // The scan is I/O bound over ~1.3GB of transcript, so it walks newest-first
  // and stops at a byte budget. These say what it left out: how many older
  // sessions it never opened, the mtime of the oldest transcript it did, and
  // where to resume. A null nextCursor means the corpus is exhausted — that is
  // what "search everything" loops until.
  unscannedSessionCount: number
  oldestScanned: string | null
  nextCursor: SessionSearchCursor | null
}

// One queued candidate parsed back out of the vault's _inbox.md — the
// inverse of vault-write-core's queueVaultCandidate entry format.
export interface VaultInboxEntry {
  title: string
  timestamp: string
  project: string | null // originating project name, if the hook could resolve one
  sessionId: string
  justification: string
  // The curator agent's confidence that this belongs in the vault — the
  // strength of its "suggest adding" recommendation, shown on the review
  // card. null for entries queued before the agent produced one.
  confidence: 'high' | 'medium' | 'low' | null
  // The note text an approval would write to the vault — the triage card's
  // "preview the note" disclosure. Optional so pre-body payloads stay valid.
  body?: string
}

export interface VaultInboxReport {
  count: number
  entries: VaultInboxEntry[]
}

// Cheapest possible "what was I doing last?" per project: only the newest
// session file is ever opened, and only its head is read for a title.
export interface LatestSessionEntry {
  registryId: string
  title: string
  timestamp: string // ISO, last user/assistant line of the newest session file (mtime only if it has none)
}

// Per-project 14-day session-activity trend. A session counts once on each
// local day its JSONL has a line timestamp (incrementally scanned + cached
// main-side), so multi-day sessions appear on every day they were active.
// days is a fixed 14-element array of per-local-day counts, oldest→newest,
// ending today.
export interface ProjectActivityHistory {
  registryId: string
  days: number[] // length 14
}

// One rate-limit window from the account's OAuth usage endpoint — the same
// source Claude Code's /usage command reads. Fetched main-side; the renderer
// never sees the credentials file.
export interface UsageWindow {
  utilization: number // percent of the window consumed, 0–100
  resetsAt: string // ISO timestamp when the window resets
}

// A rate-limit window scoped to a particular model (e.g. the per-model weekly
// cap). Carries a label naming the scope so the UI distinguishes it from the
// account-wide windows. Often the binding constraint even when the account-wide
// weekly sits lower.
export interface ScopedUsageWindow extends UsageWindow {
  label: string // the scope this window applies to, e.g. a model display name ("Fable")
}

export interface UsageLimitsReport {
  available: boolean
  // Set when available=false: 'no-credentials' | 'token-expired' |
  // 'http-<status>' | 'request-failed'.
  reason?: string
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  // The most-constrained model-scoped weekly window from the endpoint's
  // limits[] (null when no per-model weekly cap is in effect). Frequently the
  // binding limit — surfaced so it isn't hidden behind the account-wide weekly.
  scopedWeekly: ScopedUsageWindow | null
  // Set only when this is a cached reading re-served after a refresh failed
  // (electron/usage.ts's stale grace): epoch ms of the fetch it came from.
  // Absent ⇒ current. Present ⇒ the windows above can be hours old, so a UI
  // must not render them as a live reading.
  staleAsOf?: number
}

// ---- Usage: tokens processed per project over time -------------------------
// Built main-side from an incremental index of every transcript under
// ~/.claude/projects (subagent transcripts count toward their parent session).
// "processed" = input + cache_read + cache_creation + output tokens. Cache reads
// are most of it, and how rate limits weigh cached against fresh tokens isn't
// public, so these are what was processed, not what was charged.
export type UsageGranularity = 'hour' | 'day' | 'week' | 'month'

export interface UsageQuery {
  granularity: UsageGranularity
  periods: number // the last N periods, ending with the one containing now
}

// project = a registered project (key 'project:<registryId>'); experiment = a
// sandbox experiment folder ('experiment:<folder>'); headless = `claude -p`
// runs (the hub's hooks and other scripts); other = a folder nothing claims.
export type UsageSeriesKind = 'project' | 'experiment' | 'headless' | 'other'

export interface UsageSeries {
  key: string
  name: string
  kind: UsageSeriesKind
}

export interface UsageValues {
  processed: number
  output: number
  // Distinct minutes with at least one response, summed per session — parallel
  // sessions each count, so this can exceed wall-clock time.
  activeMinutes: number
}

export interface UsageReport {
  // indexing: the first full build is still running; buckets/totals are empty
  // (not zero) until it finishes. error: no index could be built at all.
  state: 'ready' | 'indexing' | 'error'
  progress?: { done: number; total: number } // bytes of transcript read so far / to read
  // With state 'ready', a non-null error means the latest refresh failed and the
  // numbers are from the last refresh that succeeded.
  error: string | null
  coverage: {
    filesIndexed: number
    // Transcripts (or folders of them) that could not be read on the latest
    // refresh. Non-zero means totals may be low, not that nothing happened.
    filesUnreadable: number
    firstIso: string | null // earliest response in the index
    lastIso: string | null // latest response in the index
    // When the index was first built. Claude Code deletes transcripts after 30
    // days by default, so periods more than ~30 days before this are partial:
    // only transcripts that happened to survive were ever read.
    indexedSinceIso: string | null
  }
  series: UsageSeries[] // every key with activity in the window, by processed tokens, largest first
  buckets: { startIso: string; values: Record<string, UsageValues> }[] // local time; weeks start Monday
  totals: Record<string, UsageValues & { sessions: number }>
}

export interface UsageSessionRow {
  sessionId: string
  title: string // ai-title or first prompt, ≤80 chars
  projectPath: string // the session's working directory ('' if none was recorded)
  processed: number
  output: number
  activeMinutes: number
  lastIso: string // latest response inside the requested range
  headless: boolean // headless runs have no entry in the Sessions view
}

export interface UsageSessionsReport {
  state: 'ready' | 'indexing' | 'error'
  error: string | null
  sessions: UsageSessionRow[] // largest processed first, capped (see total)
  total: number // sessions matching before the cap
}

// Session Desktop: interactive Claude Code sessions whose terminals the hub
// owns. A detached host process (electron/desktop-host.ts) holds the ptys so a
// hub restart or crash doesn't kill them; the main process relays between it
// and the renderer. One record per desktop session, kept after the process
// exits so it can be resumed by its transcript id.
export const DESKTOP_COLORS = ['frost', 'purple', 'orange', 'blue', 'teal', 'lilac'] as const
export type DesktopColor = (typeof DESKTOP_COLORS)[number]

// 'starting' = process up, no transcript line yet; 'needs-you' = a numbered
// choice (permission, trust, question) is on screen; 'your-turn' = the turn
// ended and the prompt waits; 'exited' = no process; 'unknown' = alive but the
// transcript couldn't be read, so no claim either way.
export type DesktopSessionState = 'starting' | 'working' | 'needs-you' | 'your-turn' | 'exited' | 'unknown'

// Where a desktop session runs: a registered project (registry id) or a
// sandbox experiment (folder name, checked against listExperimentPaths()).
// The main process resolves either to a path; the renderer never sends one.
export type DesktopTargetKind = 'project' | 'experiment'
export interface DesktopTargetRef {
  kind: DesktopTargetKind
  key: string
}

export interface DesktopTarget extends DesktopTargetRef {
  name: string
  lastActivityIso: string | null // newest interactive transcript in that folder
}

// A past conversation the launcher can resume. liveElsewhere = a process
// outside the desktop runs it right now: take it over instead of resuming.
export interface DesktopRecentSession {
  sessionId: string
  title: string
  target: DesktopTargetRef
  targetName: string
  lastActivityIso: string
  liveElsewhere: boolean
}

export interface DesktopLaunchTargets {
  targets: DesktopTarget[] // projects and experiments, most recent activity first
  recent: DesktopRecentSession[] // the latest interactive sessions across all targets
  error: string | null // a partial scan says what it couldn't read
}

export interface DesktopLaunchSpec {
  target: DesktopTargetRef
  // 'resume' continues sessionId, which must be a transcript in the target's folder.
  mode: 'new' | 'resume'
  sessionId?: string
  name: string
  color: DesktopColor
}

// An interactive Claude Code session running outside the desktop, read from
// Claude Code's own per-process record (~/.claude/sessions/<pid>.json —
// internal and undocumented, so anything unexpected reads as unknown).
// status is Claude Code's own: 'idle' = waiting for a prompt.
export interface OutsideSession {
  pid: number
  sessionId: string
  name: string
  cwd: string
  target: DesktopTargetRef | null // null = the folder isn't a known project or experiment
  targetName: string | null
  status: 'idle' | 'busy' | 'shell' | 'waiting' | 'unknown'
  updatedAtIso: string | null
}

export interface TakeOverResult {
  session: DesktopSession
  // true = the old process was verified (pid + start time), ended, and the
  // same session id resumed here; false = it was left running and the
  // conversation forked here under a new id. note says why.
  closedOld: boolean
  note: string | null
}

export interface DesktopSession {
  id: string // desktop id, stable across resumes
  claudeSessionId: string // passed as --session-id, later --resume
  name: string
  color: DesktopColor
  slot: number // 1-9, unique on the desktop: the Alt+N key
  target: DesktopTargetRef
  targetName: string
  poppedOut: boolean // shown in its own window instead of on the stage
  // The boundary tier this session was launched under; null = launched before boundaries existed.
  tier: LaunchTier | null
  createdAtIso: string
  alive: boolean
  state: DesktopSessionState
  stateDetail: string | null // e.g. the on-screen question, or the last tool
  lastActivityIso: string | null
  contextPct: number | null
  exitCode: number | null
}

export interface DesktopSnapshot {
  // 'down' with an error = the host couldn't be started or reached.
  host: { state: 'up' | 'starting' | 'down'; error: string | null }
  // Non-null when the session records (or the project registry) couldn't be
  // read: `sessions` is then empty because nothing could be listed, not
  // because there are none, and every change is refused until it's fixed.
  records: { error: string | null }
  sessions: DesktopSession[]
  // Interactive sessions running outside the desktop (another terminal).
  // null = couldn't read Claude Code's session records; error says why.
  outside: { sessions: OutsideSession[] | null; error: string | null }
}

// Terminal output. seq rises by one per chunk per session, so a renderer that
// fetched a screen at seq N drops chunks <= N and keeps the rest.
export interface DesktopTerminalChunk {
  id: string
  seq: number
  data: string
}

// A serialized screen (scrollback included) to seed a freshly mounted terminal.
export interface DesktopScreen {
  id: string
  seq: number
  data: string
  cols: number
  rows: number
}

// ---- Project config + session boundaries ---------------------------------
// The configuration a session in a project (or sandbox experiment) inherits,
// layer by layer. Names and redacted targets only: no env values, tokens or
// file contents beyond counts ever cross to the renderer.
export type ConfigLayerScope = 'global' | 'project' | 'local'

export interface ConfigLayer {
  scope: ConfigLayerScope
  files: { label: string; path: string; exists: boolean; error: string | null }[]
  claudeMdTokens: number | null // null = no CLAUDE.md in this layer
  model: string | null
  permissions: { defaultMode: string | null; allow: string[]; ask: string[]; deny: string[] } | null
  hooks: { event: string; command: string }[] // command redacted
  mcpServers: { name: string; target: string; enabled: boolean | null }[] // target redacted; enabled null = not stated
  skills: string[]
  agents: string[]
  commands: string[]
  workflows: string[]
}

export interface ConfigFinding {
  severity: 'warn' | 'info'
  layer: ConfigLayerScope
  text: string // e.g. "settings.local.json enables MCP server 'ruflo', but there's no .mcp.json"
}

export interface ProjectConfigReport {
  target: DesktopTargetRef
  layers: ConfigLayer[] // global, project, local: later layers win
  findings: ConfigFinding[]
  error: string | null
}

// A project's declared boundary: where its sessions may read and write.
// 'audit' = report crossings, block nothing; 'guarded' = Desktop launches add
// deny rules for Claude's file tools outside the boundary. Native Windows has
// no shell sandbox, so neither tier fences Bash/PowerShell — `covers` says so.
export type BoundaryAccess = 'read' | 'write'
export type BoundaryTier = 'audit' | 'guarded'
// What a session was launched under: a project's tier, or 'admin' for the
// claude-hub repo's own sessions, which have no boundary at all.
export type LaunchTier = BoundaryTier | 'admin'

export interface BoundaryNeighbour {
  target: DesktopTargetRef
  access: BoundaryAccess
}

export interface ProjectBoundary {
  target: DesktopTargetRef
  tier: BoundaryTier
  neighbours: BoundaryNeighbour[]
  vaultAccess: BoundaryAccess
  isDefault: boolean // nothing saved for this target yet
  admin: boolean // the claude-hub repo itself: no boundary, whatever is saved
}

export interface GuardStatus {
  desktopLaunch: boolean // Desktop launches of this target carry the deny rules
  // The hub-managed deny rules in <folder>/.claude/settings.local.json, which
  // also cover sessions started in other terminals.
  localSettings: 'absent' | 'current' | 'stale' | 'unreadable' | 'unrecorded'
  covers: string // plain words: what is and isn't enforced
}

export interface BoundaryView {
  boundary: ProjectBoundary
  guard: GuardStatus
}

// One access a session made outside its declared boundary.
export interface BoundaryCrossing {
  sessionId: string
  at: string // ISO
  tool: string
  access: 'read' | 'write' | 'shell'
  detail: string // the path, or the shell command (truncated)
  into: string // where it reached: a project/experiment name, 'vault', or 'elsewhere'
}

export interface BoundaryAudit {
  target: DesktopTargetRef
  sinceIso: string
  sessionsScanned: number
  sessionsUnreadable: number
  crossings: BoundaryCrossing[] // newest first, capped at 200
  total: number
  // Calls that would have crossed but Claude Code refused to run (a deny rule,
  // the classifier, the user at the prompt): evidence the guard held, not crossings.
  blocked: number
  error: string | null
}

export const IPC_CHANNELS = {
  listProjects: 'registry:list',
  addProject: 'registry:add',
  removeProject: 'registry:remove',
  setPinned: 'registry:set-pinned',
  setVerifyCommand: 'registry:set-verify-command',
  getProjectStatus: 'registry:status',
  listSessions: 'sessions:list',
  listAllSessions: 'sessions:all',
  readSession: 'sessions:read',
  listSubagents: 'sessions:list-subagents',
  readSubagent: 'sessions:read-subagent',
  deleteSession: 'sessions:delete',
  openFolder: 'launch:open-folder',
  openInVSCode: 'launch:open-vscode',
  openTerminal: 'launch:open-terminal',
  openRemoteControl: 'launch:remote-control',
  resumeSessionInTerminal: 'launch:resume-session',
  openClaudeMd: 'launch:open-claude-md',
  copyPath: 'launch:copy-path',
  getVaultInfo: 'vault:info',
  openVault: 'vault:open',
  listSkills: 'skills:list',
  getSkillUsage: 'skills:usage',
  readSkillSource: 'skills:read-source',
  promoteToProject: 'skills:promote',
  promoteAndTailor: 'skills:promote-and-tailor',
  promoteSkillToGlobal: 'skills:promote-global',
  listWorkflows: 'workflows:list',
  readWorkflowSource: 'workflows:read-source',
  promoteWorkflow: 'workflows:promote',
  launchWorkflowSession: 'workflows:launch-session',
  explainWorkflowSession: 'workflows:explain-session',
  launchCommandSession: 'commands:launch-session',
  listWorkflowTemplates: 'workflows:list-templates',
  createWorkflowFromTemplate: 'workflows:create-from-template',
  openWorkflowInEditor: 'workflows:open-in-editor',
  editWorkflowSession: 'workflows:edit-session',
  listExperiments: 'sandbox:list-experiments',
  createExperiment: 'sandbox:create-experiment',
  openExperimentTerminal: 'sandbox:open-terminal',
  draftLearnings: 'sandbox:draft-learnings',
  queueExperimentToInbox: 'sandbox:queue-to-inbox',
  listSandboxJobs: 'sandbox:list-jobs',
  cancelSandboxJob: 'sandbox:cancel-job',
  // Push event (webContents.send wired in main.ts), not an invoke channel —
  // carries the full SandboxJob[] whenever a job starts, changes phase, or
  // ends. Renderer subscribes via hubApi.onSandboxJobsChanged.
  sandboxJobsChanged: 'sandbox:jobs-changed',
  getConfigHealth: 'config-health:get',
  getCrossProjectRedundancy: 'config-health:cross-project',
  searchSessions: 'sessions:search',
  getVaultGraph: 'vault:graph',
  readVaultNote: 'vault:read-note',
  recomputeLinks: 'vault:recomputeLinks',
  getRecallScorecard: 'vault:recall-scorecard',
  getJobFreshness: 'jobs:freshness',
  getGlobalConfig: 'global:config',
  runGlobalTask: 'global:run-task',
  openGlobalFile: 'global:open-file',
  getFloorStatus: 'floor:status',
  runVerify: 'floor:runVerify',
  listVerifyJobs: 'floor:list-verify-jobs',
  cancelVerifyJob: 'floor:cancel-verify-job',
  // Push event (webContents.send wired in main.ts) —
  // carries the full VerifyJob[] whenever a run starts, streams output
  // (throttled), or ends. Renderer subscribes via hubApi.onVerifyJobsChanged.
  verifyJobsChanged: 'floor:verify-jobs-changed',
  pickFolder: 'dialog:pickFolder',
  getVaultInbox: 'vault:getInbox',
  resolveInboxEntry: 'vault:resolveInbox',
  quickCaptureVaultNote: 'vault:quickCapture',
  getRubric: 'rubric:get',
  saveRubric: 'rubric:save',
  latestSessionPerProject: 'sessions:latestPerProject',
  getActivityHistory: 'activity:history',
  getUsageLimits: 'usage:limits',
  getUsage: 'usage:report',
  getUsageSessions: 'usage:sessions',
  getLiveStatus: 'live:get',
  setWindowTheme: 'window:set-theme',
  getExtensions: 'extensions:get',
  recheckExtensions: 'extensions:recheck',
  setPluginEnabled: 'extensions:set-plugin-enabled',
  getDesktop: 'desktop:get',
  createDesktopSession: 'desktop:create',
  listDesktopTargets: 'desktop:targets',
  takeOverSession: 'desktop:take-over',
  popOutDesktopSession: 'desktop:pop-out',
  getProjectConfig: 'config:project',
  getBoundary: 'boundary:get',
  setBoundary: 'boundary:set',
  auditBoundary: 'boundary:audit',
  writeLocalGuard: 'boundary:write-local',
  removeLocalGuard: 'boundary:remove-local',
  resumeDesktopSession: 'desktop:resume',
  closeDesktopSession: 'desktop:close',
  forgetDesktopSession: 'desktop:forget',
  updateDesktopSession: 'desktop:update-session',
  getDesktopScreen: 'desktop:screen',
  desktopInput: 'desktop:input',
  desktopResize: 'desktop:resize',
  // Push events (webContents.send from electron/desktop.ts): the snapshot
  // whenever a session's state changes, and every chunk of terminal output.
  desktopUpdate: 'desktop:update',
  desktopData: 'desktop:data',
  // Push event (webContents.send from electron/live.ts), not an invoke
  // channel — carries a LiveStatusSnapshot whenever the watcher/poll sees
  // transcript activity change. Renderer subscribes via hubApi.onLiveUpdate.
  liveUpdate: 'live:update',
} as const

export interface HubApi {
  listProjects(): Promise<RegistryEntry[]>
  addProject(path: string): Promise<RegistryEntry>
  removeProject(id: string): Promise<void>
  // Pin (float to top of project lists) or unpin a registered project.
  setPinned(id: string, pinned: boolean): Promise<RegistryEntry>
  // Set (or clear, with a blank string) a project's verifyCommand — the
  // floor card's inline setter. The command runs on the hub machine.
  setVerifyCommand(id: string, command: string): Promise<RegistryEntry>
  getProjectStatus(path: string): Promise<ProjectStatus>
  listSessions(projectPath: string): Promise<SessionSummary[]>
  // Newest-first sessions across every registered project, each with its own
  // live state — the Sessions view's master list. Bounded (see
  // SESSION_LIST_LIMIT), so it is a list of what's recent, not the archive.
  listAllSessions(): Promise<SessionListEntry[]>
  readSession(projectPath: string, sessionId: string): Promise<SessionMessage[]>
  // Subagents a session deployed, from the transcript's sibling subagents dir.
  // projectPath/sessionId mirror readSession; ids are matched against
  // enumerated files, never concatenated into a path.
  listSubagents(projectPath: string, sessionId: string): Promise<SubagentSummary[]>
  // A subagent's transcript (sidechain turns included — a subagent file is
  // 100% isSidechain lines). Empty for unknown ids or meta-only agents.
  readSubagent(projectPath: string, sessionId: string, agentId: string): Promise<SessionMessage[]>
  // Sends a session's history to the OS recycle bin: its transcript plus the
  // sidecar dir Claude Code writes beside it (subagent transcripts + metas).
  // This is Claude Code's OWN store, so the session also stops being
  // `claude --resume`-able — recoverable only from the recycle bin. Takes a
  // registry id, like the launch actions; the id is matched against the
  // transcripts on disk before anything is touched.
  deleteSession(projectId: string, sessionId: string): Promise<void>
  // All four take a registry entry's id, not a raw path — the main process
  // resolves the path by looking it up in registry.json, so a launch action
  // can never operate on a path that wasn't already registered.
  openFolder(id: string): Promise<void>
  openInVSCode(id: string): Promise<void>
  openTerminal(id: string): Promise<void>
  // Hands a session back to the CLI: opens a terminal in the project running
  // `claude --resume <sessionId>`. projectId is a registry id and the session
  // id is validated against the transcripts on disk (launch-core.ts).
  resumeSessionInTerminal(projectId: string, sessionId: string): Promise<void>
  openRemoteControl(id: string): Promise<void>
  // Opens a CLAUDE.md in VS Code — a registered project's, or (with a null
  // id) the global ~/.claude/CLAUDE.md. Takes an id rather than a path for
  // the same reason as the four above; the filename is appended in the main
  // process, so this can only ever open a CLAUDE.md the hub already knows of.
  openClaudeMd(projectId: string | null): Promise<void>
  copyPath(id: string): Promise<void>
  // Recolours the native window controls to match the renderer's theme. Takes
  // a theme id, not colours: the main process looks the colours up in a fixed
  // table (electron/window-theme.ts).
  setWindowTheme(theme: ThemeId): Promise<void>
  getVaultInfo(): Promise<VaultInfo>
  openVault(): Promise<void>
  listSkills(): Promise<SkillEntry[]>
  // Scans the ~/.claude/projects session corpus for Skill-tool invocations
  // (persisted incremental index, keyed by file mtime). Returned separately
  // from listSkills() and merged by name on the renderer side.
  getSkillUsage(): Promise<SkillUsage[]>
  // Reads a skill's SKILL.md full text for the detail pane's disclosure.
  // skillPath must be a path already returned by listSkills() — mirrors
  // readWorkflowSource's known-good-path discipline.
  readSkillSource(skillPath: string): Promise<string>
  // sourcePath must be a path already returned by listSkills()/listExperiments()
  // — same "only operate on known-good paths" discipline as the launch actions.
  promoteToProject(sourcePath: string, targetProjectId: string): Promise<PromoteResult>
  // Same copy as promoteToProject, then opens the copy in VS Code for
  // hand-editing — not an LLM rewrite, see electron/promote.ts's comment.
  promoteAndTailor(sourcePath: string, targetProjectId: string): Promise<PromoteResult>
  // Copies a skill folder into ~/.claude/skills (every project, including
  // future ones, sees it). sourcePath must be a path already returned by
  // listSkills(); refuses on a name conflict like register-skill.mjs. This
  // writes OUTSIDE any registered project, so it validates via the listSkills
  // enumerator, never a registry-id lookup.
  promoteSkillToGlobal(sourcePath: string): Promise<PromoteResult>
  listWorkflows(): Promise<WorkflowEntry[]>
  // Reads a workflow script's full text for the expandable source view.
  // sourcePath must be a path already returned by listWorkflows() — same
  // "only operate on known-good paths" discipline as promoteWorkflow.
  readWorkflowSource(sourcePath: string): Promise<string>
  // sourcePath must be a path already returned by listWorkflows() — same
  // "only operate on known-good paths" discipline as promoteToProject.
  // Copies the single .js file into <target>/.claude/workflows/.
  promoteWorkflow(sourcePath: string, targetProjectId: string): Promise<PromoteResult>
  // Opens an interactive Claude Code session at targetProjectId's path via a
  // claude-cli:// deep link, workflow invocation pre-filled. sourcePath must
  // be a path already returned by listWorkflows(). Fire-and-forget (void) like
  // the other launch actions; the user presses Enter in the opened session.
  launchWorkflowSession(sourcePath: string, targetProjectId: string, args: string): Promise<void>
  // Opens a session pre-filled with a prompt asking Claude to read the script
  // and explain when/how to use it with a worked example — the "understand
  // this workflow" counterpart to launchWorkflowSession's "run it". Same
  // known-good-path + URL-encoded deep-link discipline.
  explainWorkflowSession(sourcePath: string, targetProjectId: string): Promise<void>
  // Opens an interactive session at targetProjectId's path with "Run
  // /<commandName>" pre-filled (one-Enter gate, mirroring
  // launchWorkflowSession). cwd resolves by registry-id lookup; commandName
  // must be a plain slash-command slug — it only ever reaches the URL-encoded
  // claude-cli:// deep link, never a shell.
  launchCommandSession(commandName: string, targetProjectId: string): Promise<void>
  // Starter shapes for "New workflow". Content is not exposed — the main
  // process renders it on create.
  listWorkflowTemplates(): Promise<WorkflowTemplate[]>
  // Scaffold a template into targetProjectId's .claude/workflows/ (registry-id
  // lookup, conflict-refusing — same discipline as promote). Returns the
  // created path so the renderer can then refine it in a session or editor.
  createWorkflowFromTemplate(templateKey: string, name: string, targetProjectId: string): Promise<CreateWorkflowResult>
  // Open a workflow .js in VS Code. scriptPath must live in a known workflows
  // directory (validated main-side) — an existing workflow's path or one the
  // hub just scaffolded.
  openWorkflowInEditor(scriptPath: string): Promise<void>
  // Open a session to author/edit the script: `instruction` seeds the prompt
  // ("adapt it to: <goal>" for a fresh scaffold, "help me modify it" for an
  // existing one). Same known-good-path + URL-encoded deep-link discipline.
  editWorkflowSession(scriptPath: string, targetProjectId: string, instruction: string): Promise<void>
  listExperiments(): Promise<ExperimentEntry[]>
  createExperiment(name: string): Promise<ExperimentEntry>
  // experimentPath must be a path already returned by listExperiments() —
  // same "only operate on known-good paths" discipline as the launch actions.
  openExperimentTerminal(experimentPath: string): Promise<void>
  draftLearnings(experimentPath: string): Promise<DraftLearningsResult>
  listSandboxJobs(): Promise<SandboxJob[]>
  // Kills the job's current claude subprocess; the draft resolves as
  // cancelled. No-op (false) if the job already finished.
  cancelSandboxJob(id: string): Promise<boolean>
  // Typed subscription to the sandbox:jobs-changed push event. Returns unsubscribe.
  onSandboxJobsChanged(listener: (jobs: SandboxJob[]) => void): () => void
  // Queues the experiment's LEARNINGS.md to the vault inbox for review — the
  // same human-in-the-loop path the curate hook uses, not a direct vault
  // write. skippedDuplicate is set when the inbox already holds this title.
  queueExperimentToInbox(experimentPath: string): Promise<QueueToInboxResult>
  getConfigHealth(projectPath: string): Promise<ConfigHealthReport>
  getCrossProjectRedundancy(): Promise<CrossProjectRedundancyReport>
  searchSessions(
    query: string,
    currentProjectId?: string,
    opts?: { startAfter?: SessionSearchCursor },
  ): Promise<SessionSearchResult>
  getVaultGraph(): Promise<VaultGraphData>
  // id must be a note id already returned by getVaultGraph() — same
  // "only operate on known-good paths" discipline as the launch actions.
  readVaultNote(id: string): Promise<string>
  // Re-link every note whose mtime changed since its last linking (per-note
  // sonnet calls, serial). Slow — seconds per stale note; the renderer should
  // treat it as a background action, then refetch the graph.
  recomputeLinks(): Promise<RecomputeLinksResult>
  // Recall-experiment scorecard: parses scripts/vault-recall.log and scans
  // delivered sessions' transcripts for Reads of the offered notes.
  getRecallScorecard(): Promise<RecallScorecard>
  // Freshness of every background automation. Reports 'unknown' where it
  // cannot tell rather than defaulting to healthy.
  getJobFreshness(): Promise<JobFreshness[]>
  // Everything global: the ~/.claude hooks, the scheduled jobs, and the
  // settings that apply to every project — each with a probed state.
  getGlobalConfig(): Promise<GlobalConfigReport>
  // Start (or, if it is already running, restart) one scheduled job. The name
  // is validated against the enumerated task list in the main process — the
  // renderer cannot name an arbitrary task. Returns the refreshed report.
  runGlobalTask(taskName: string): Promise<GlobalConfigReport>
  // Open one of the global config files or automation logs in the editor. The
  // id is validated against the enumerated file list, never a raw path.
  openGlobalFile(fileId: string): Promise<void>
  // Read-only, no renderer args — same shape as getCrossProjectRedundancy.
  getFloorStatus(): Promise<FloorStatusReport>
  // Spawn a project's verifyCommand (resolved by registry id in the main
  // process, never a renderer path), record the run to the verify ledger, and
  // return the refreshed floor status. Rejects if the project is unknown or has
  // no verifyCommand configured. While it runs, progress streams over the
  // verify-jobs surface below.
  runVerify(id: string): Promise<FloorStatusReport>
  // Running Run-verify spawns — the seed pull for onVerifyJobsChanged.
  listVerifyJobs(): Promise<VerifyJob[]>
  // Tree-kills the run's process tree; the aborted run is NOT recorded to the
  // ledger (a user abort is not a red verify). No-op (false) if already done.
  cancelVerifyJob(id: string): Promise<boolean>
  // Typed subscription to the floor:verify-jobs-changed push event. Returns unsubscribe.
  onVerifyJobsChanged(listener: (jobs: VerifyJob[]) => void): () => void
  // Native folder picker in the main process. NOTE: this is not the only path
  // to addProject — drag-drop (File.path) hands it a raw path too. addProject
  // validates the path is a directory but does not confine it; downstream
  // launch/verify actions still resolve by registry id, so a registered path
  // is only ever a cwd.
  pickFolder(): Promise<string | null>
  getVaultInbox(): Promise<VaultInboxReport>
  // Approve (promote the queued candidate into the vault) or reject (drop it)
  // one inbox entry, keyed by the sessionId+title a getVaultInbox() entry
  // carries. Either way the entry is removed from _inbox.md. This is the
  // human gate — nothing enters the vault without an approve here.
  resolveInboxEntry(sessionId: string, title: string, action: 'approve' | 'reject'): Promise<VaultWriteResult>
  // Manual "put this in the vault now" — same mechanism as
  // scripts/log-to-vault.mjs (writeVaultNote: dedup by title against index.md).
  quickCaptureVaultNote(payload: { title: string; content: string }): Promise<VaultWriteResult>
  // The curation rubric the Stop hook applies to decide what to queue — read
  // for the Rubric settings view, saved back to the vault's RUBRIC.md. The
  // extractor re-reads it on the next session, so edits take effect without a
  // restart. Read-only get, no renderer args.
  getRubric(): Promise<string>
  saveRubric(text: string): Promise<RubricSaveResult>
  latestSessionPerProject(): Promise<LatestSessionEntry[]>
  // Read-only, no renderer args — 14-day session-activity counts per project.
  getActivityHistory(): Promise<ProjectActivityHistory[]>
  // 5-hour + weekly rate-limit windows from the OAuth usage endpoint.
  // Read-only, no renderer args — credentials stay in the main process.
  getUsageLimits(): Promise<UsageLimitsReport>
  // Tokens processed per project over time, from the transcript index. Never
  // blocks on the first build: returns state 'indexing' with progress instead.
  getUsage(query: UsageQuery): Promise<UsageReport>
  // Drill-down: the sessions behind one series key in [startIso, endIso). The
  // key is one getUsage returned; it is matched, never used as a path.
  getUsageSessions(key: string, startIso: string, endIso: string): Promise<UsageSessionsReport>
  // Pull the current live snapshot (seed); live:update pushes keep it fresh.
  getLiveStatus(): Promise<LiveStatusSnapshot>
  // MCP servers, plugins and connectors. Fast: returns config, cached health
  // and cached usage, and starts a background health check when the cached
  // one is stale (health.state 'running').
  getExtensions(): Promise<ExtensionsSnapshot>
  // Runs the health check now (~7s) and returns the fresh snapshot.
  recheckExtensions(): Promise<ExtensionsSnapshot>
  // `claude plugin enable|disable <id>`. The id must name a plugin from
  // `claude plugin list --json`. Whether a claude.ai-synced plugin stays
  // disabled or re-syncs is unverified (docs/loop-handoff.md).
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<ExtensionsSnapshot>
  // Session Desktop. Reattaches to a running host; never starts one (only
  // create and resume do), so calling it with no live session is cheap.
  getDesktop(): Promise<DesktopSnapshot>
  // Starts a session in the target's folder (resolved in main from the
  // registry or listExperimentPaths()) and takes the lowest free slot:
  // `claude --session-id <new uuid> --name <name>` for 'new', or
  // `claude --resume <sessionId> --name <name>` for 'resume'.
  createDesktopSession(spec: DesktopLaunchSpec): Promise<DesktopSession>
  // Projects, sandbox experiments and recent resumable conversations.
  listDesktopTargets(): Promise<DesktopLaunchTargets>
  // Moves an outside session onto the desktop. With closeOld, the old process
  // is ended only if Claude Code's record and the live process agree (pid +
  // start time) and it's idle; otherwise it keeps running and the
  // conversation forks here (`--resume <id> --fork-session`).
  takeOverSession(pid: number, sessionId: string, opts: { name: string; color: DesktopColor; closeOld: boolean }): Promise<TakeOverResult>
  // Shows the session in its own window; closing that window returns it to the stage.
  popOutDesktopSession(id: string): Promise<void>
  // Effective Claude Code config for a project or experiment, layer by layer.
  getProjectConfig(target: DesktopTargetRef): Promise<ProjectConfigReport>
  getBoundary(target: DesktopTargetRef): Promise<BoundaryView>
  setBoundary(target: DesktopTargetRef, patch: { tier?: BoundaryTier; neighbours?: BoundaryNeighbour[]; vaultAccess?: BoundaryAccess }): Promise<BoundaryView>
  // Crossings of the declared boundary in the last `days` days of transcripts.
  auditBoundary(target: DesktopTargetRef, days: number): Promise<BoundaryAudit>
  // Writes (or refreshes) the hub-managed deny rules into the folder's
  // .claude/settings.local.json, keeping every other key; guarded tier only.
  writeLocalGuard(target: DesktopTargetRef): Promise<GuardStatus>
  // Removes exactly the rules the hub wrote; leaves the rest of the file alone.
  removeLocalGuard(target: DesktopTargetRef): Promise<GuardStatus>
  // Restarts an exited session with `claude --resume <claudeSessionId>`.
  resumeDesktopSession(id: string): Promise<DesktopSession>
  // Ends the process; the record stays (state 'exited') so it can be resumed.
  closeDesktopSession(id: string): Promise<void>
  // Removes an exited session's record. Refuses a live one.
  forgetDesktopSession(id: string): Promise<void>
  // Desktop-side identity only; a slot already taken swaps with its holder.
  updateDesktopSession(id: string, patch: { name?: string; color?: DesktopColor; slot?: number }): Promise<DesktopSession>
  getDesktopScreen(id: string): Promise<DesktopScreen>
  desktopInput(id: string, data: string): Promise<void>
  desktopResize(id: string, cols: number, rows: number): Promise<void>
  onDesktopUpdate(listener: (snapshot: DesktopSnapshot) => void): () => void
  onDesktopData(listener: (chunk: DesktopTerminalChunk) => void): () => void
  // Typed subscription to the live:update push event. Returns unsubscribe.
  onLiveUpdate(listener: (snapshot: LiveStatusSnapshot) => void): () => void
}
