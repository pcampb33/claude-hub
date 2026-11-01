# Workflows feature — current state

**Built:** 2026-07-04/05. A hub surface for Claude Code **Workflow DevKit**
scripts (`.claude/workflows/*.js` — `export const meta = {...}` + an
`agent()/pipeline()/parallel()/phase()` body). It **catalogs, explains, and
routes** workflows; it does **not** run them itself (the hub is not a Claude
Code session). Lives in the Library nav group next to Skills/Knowledge/Commands.

## What it does

The tab is a **master-detail** two-pane view (mirroring the Projects/Knowledge
idiom): a scannable list on the left — grouped under **collapsible, default-
expanded project headers** (a `global` group only when `~/.claude/workflows` has
entries), groups ordered by their most-recently-touched workflow, each row
carrying name + one-line description + orchestration-shape chips + agent count —
feeding a full **detail pane** on the right for the selected workflow. Selection
is deep-linkable (`#/workflows/<id>`, read from `RouteParamContext`, set via
`useNavigate`), and a filter box narrows the list. The capabilities below all
live in that detail pane. A **"What do the labels mean?" legend** in the header
(plus a hover tooltip on every shape/badge chip) explains the whole vocabulary —
`pipeline` / `parallel` / `loop` / `sub-workflow` / dynamic `+` / `agent` /
`structured` / `worktree` / `model` / `effort` / `agentType` — from one source
(`glossary.ts`), including terms no current workflow uses; update it when the
parser learns a new shape.

1. **Cross-project discovery.** Scans `~/.claude/workflows/` (global) plus every
   registered project's `.claude/workflows/`, flat `.js` files only — same
   registry-driven, root-only shape as `skills.ts`.
2. **Usage-first detail pane ("How to use").** The detail pane is two-column:
   the left leads with the usage view — **when to use** (`meta.whenToUse`) as
   the headline, the **invocation** `/name {args}` (the arg keys are detected
   from the body — `args.X` and any `const ALIAS = … args` then `ALIAS.X`),
   and a worked **example** the author bakes into `meta.example` — while the
   right column keeps the **Structure phase rail** always visible (item 4).
   Only the raw source stays collapsed.
3. **Explain in a session.** "Explain in a session ↗" deep-links to a Claude
   session pre-filled with a prompt to *read the script and walk through when/
   how to use it* — the generated, tailored counterpart to the static example
   (offered when the workflow has an owning project to anchor the session at).
4. **Structure phase rail (always visible) + source (collapsed).** The
   workflow's *declared* structure sits beside the usage column as a phase
   rail: phases (from `meta.phases`, plus any phase only referenced in the
   body), the `agent()` steps mapped to each — prompt text clamped to two
   lines when the first arg is a string/template literal, else "prompt built
   at runtime" for a computed prompt (e.g. `agent(d.prompt, …)`) — with badges
   for `model` / `effort` / `structured` (schema) / `worktree` (isolation) /
   `agentType`, an orchestration-shape summary (`pipeline` / `parallel` /
   `loop` / `sub-workflow`) with an agent count and a **dynamic fan-out**
   flag. (The rail was promoted out of the old collapsed "Under the hood" —
   the glanceable phase map earns its place; full prompts moved to the
   source view.) The full `.js` **source** stays on demand over
   `workflows:read-source` (validated against `listWorkflows()`), collapsed
   beneath the usage column.
5. **Copy actions.** Copy `/name`, copy the script path.
6. **Promote.** "Promote to…" copies the `.js` into another registered
   project's `.claude/workflows/`, refusing on name conflict.
7. **Run in session.** Opens a real interactive Claude session at a chosen
   project via a `claude-cli://` deep link with the invocation pre-filled. The
   args box is **arg-aware**: when the parser detected an arg contract it
   renders one labeled field per key and assembles the `{key: "value"}` object
   (`JSON.stringify`'d values), falling back to a free-text box otherwise — see
   below.
8. **Create / edit workflows.** "+ New workflow" opens a panel: pick a starter
   **template** (`blank` / `review-pipeline` / `research-fan-out` /
   `map-over-items`, from `workflow-templates.ts`) → name + project → finish by
   *Create & refine in a session* (scaffold the real template, then a deep link
   opens the new file to adapt it) or *Create & open in editor* (scaffold + open
   the `.js` in VS Code). The same two lanes — **Edit in session** /
   **Open in editor** — sit on every workflow's detail pane. Scaffolding is a
   conflict-refusing, registry-id-resolved write (promote's discipline); the
   name is slugged to kebab-case for both the `/invocation` and the filename.

## Authoring (create / edit)

`createWorkflowFromTemplate(key, name, projectId)` resolves the project by
registry id and calls the Electron-free `createWorkflowFile()` core, which
slugs the name, refuses to overwrite, and writes the template with `__NAME__`
substituted. The two finish lanes both take the freshly-created (or existing)
path: `openWorkflowInEditor` validates it against the set of known workflows
directories (`~/.claude/workflows` + each project's `.claude/workflows`) then
reuses promote's cmd-shim-safe `openPathInVSCode`; `launchWorkflowEdit` builds a
`buildWorkflowAuthorDeepLink` (URL-encoded, same safety as the other deep links)
that opens the script with an instruction pre-filled. Templates avoid
backticks/`${…}`/escapes so they live inline in `workflow-templates.ts` without
escaping; each is verified to parse back through `parseWorkflowFile` in tests.

## Run in session (deep link)

"Run in session…" opens a small setup panel: pick the **project** (working
directory; defaults to the workflow's own project), fill the **args** (one
labeled field per detected key, assembled into `{key: "value"}`; a free-text
box when no arg contract was detected), and a live **git context line** (branch
+ clean/dirty, from `getProjectStatus`). On Launch, `launchWorkflowSession`
builds `claude-cli://open?cwd=<enc>&q=<enc "Run /name args">` and fires
`shell.openExternal`. "Explain in a session ↗" uses the same safe construction
via `buildWorkflowExplainDeepLink` / `launchWorkflowExplain`, only the
pre-filled prompt asks Claude to *read and explain* the script rather than run
it.

- The session opens with the line **pre-filled, not run** — the user presses
  Enter. That one keypress is the deliberate, documented gate (deep links never
  auto-execute); it *is* the "human actually starts it" step.
- **Safe by construction:** every value is URL-encoded into the query string, so
  paths/args never reach a shell command line — this sidesteps the Windows
  cmd-shim injection hazard `launch.ts` guards against with
  `assertSafeForCmdShim`, and is why this is safer than the `spawn`-based launch
  actions. cwd resolves by registry-id; the workflow validates against
  `listWorkflows()`.
- The prompt uses the natural-language form the docs demonstrate
  (`Run /name <args>`) — the most reliable way to get it to run on Enter.

See the deep-link findings note in the personal memory for the empirical basis
(`-p "/name"` does **not** expand a workflow; the `claude-cli://` protocol is
registered as `claude.exe --handle-uri`).

## Files

| Concern | File |
|---|---|
| Types + IPC contract | `shared/ipc-types.ts` — `WorkflowEntry` (incl. `example`), `WorkflowComposition` (incl. `args`), `WorkflowStep` (incl. `prompt`), `WorkflowPhase`, `WorkflowOrchestration`, `WorkflowTemplate`, `CreateWorkflowResult`; channels `workflows:list` / `read-source` / `promote` / `launch-session` / `explain-session` / `list-templates` / `create-from-template` / `open-in-editor` / `edit-session` |
| Discovery + parser + source read + promote + deep-link builders | `electron/workflows.ts` (Electron-free) — `listWorkflows`, `parseWorkflowFile` (incl. `detectArgKeys` + `meta.example`), `readWorkflowSource`, `promoteWorkflowToProject`, `buildWorkflowDeepLink`, `buildWorkflowExplainDeepLink`, `buildWorkflowAuthorDeepLink` |
| Templates + scaffold (Electron-free) | `electron/workflow-templates.ts` — the 4 templates, `listWorkflowTemplates`, `sanitizeWorkflowName`, `createWorkflowFile` (core), `createWorkflowFromTemplate` (registry wrapper) |
| Session launch + editor (Electron/shell boundary) | `electron/launch.ts` — `launchWorkflowSession`, `launchWorkflowExplain`, `launchWorkflowEdit`, `openWorkflowInEditor` (+ `assertWorkflowsDirFile`) |
| Handler registration / preload | `electron/ipc-handlers.ts`, `electron/preload.ts` |
| Tests | `electron/workflows.test.ts` (16: meta/composition/prompt/arg-detection + run/explain/author deep-link encoding), `electron/workflow-templates.test.ts` (5: list, slug, each template scaffolds→parses, conflict/name guards) |
| UI slice | `src/features/workflows/` — `index.tsx` (master-detail container: grouped/collapsible list, selection, legend + new-workflow toggles), `useWorkflows.ts`, `WorkflowDetail.tsx` (detail pane + edit/open actions), `WorkflowHowToUse.tsx`, `WorkflowComposition.tsx`, `WorkflowLaunchPanel.tsx`, `WorkflowNewPanel.tsx` (create flow), `WorkflowLegend.tsx` + `glossary.ts` (label glossary), `workflows.css` |
| Shell wiring | `src/App.tsx` (VIEWS + Library nav), `WorkflowsIcon` in `shared/icons.tsx` |
| Seed workflow | `.claude/workflows/parallel-build.js` (research→plan fan-out; alongside the pre-existing `review-changes.js`) |
| Verification harness | `scripts/screenshot-app.mjs` (added `workflows` to its view list) |

## The parser, and its honest limits

`parseWorkflowFile` statically analyzes the script — it never executes the body.
It strips comments (string-aware) so a `// agent() ...` comment isn't counted as
a call site, evaluates the `meta` literal in isolation (`meta` is a contractual
pure literal), then scans for `phase()` calls and `agent()` call sites, reading
each agent's options object — and its first argument (the prompt) — with a
brace/quote-aware lexer. The prompt is captured only when that first arg is a
single string/template literal (unwrapped, `${…}` kept verbatim); a computed
prompt like `d.prompt` is left null, since it can't be resolved statically.

Deliberate boundaries:

- **Declared structure, not a runtime trace.** Agents spawned in a loop or with
  a computed label are one call site; the `dynamic` flag marks when the real
  count exceeds the static one. The card points to `/workflows` in-session for a
  live run.
- **No per-step nested fan-out drawn** — orchestration is summarized at the
  workflow level (a real AST would be needed, and no parser dependency is
  available).
- Phase mapping keys off the explicit `phase:` opt first, then the nearest
  preceding `phase()` call (`review-changes.js` has zero `phase()` calls — its
  phases come from `meta` and are wired via `phase:` opts).
- **Arg detection is textual, not a type.** `detectArgKeys` collects `args.X`
  plus `ALIAS.X` for any `const ALIAS = … args` alias. It surfaces the keys a
  workflow reads (its input contract) but not their types or which are required
  — the two built-ins take an object (`{task}` / `{range}`); a workflow reading
  `args` as a bare string or array shows no keys. A worked `meta.example` (and
  "Explain in a session") fills that gap where the key list can't.

## Explicitly out of scope

- **Executing workflows headlessly from the hub** (`claude -p`). Rejected: it's
  a degraded duplicate of the in-session `/workflows` live view (run progress is
  in-memory only, so the hub could show `started → done + cost` but not real
  per-agent progress), and it would run automation over an unverified substrate
  (the workflow scripts have no test coverage). "Run in session" delivers the
  real live view instead.
- **Run history / live-progress dashboard / editing.** Deferred; would only earn
  a place given (a) floor-verified workflow scripts and (b) a recurring
  fire-and-forget batch-run need that isn't evident yet.
