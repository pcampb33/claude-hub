# claude-hub

Local Electron + Vite + React + TS desktop app that indexes Claude Code projects and runs the knowledge flywheel around them (curate → inbox → vault → recall). Single user, single machine.

## Verify

Before calling any change done, run `npm run lint && npm run typecheck && npm test`; all three must exit 0. For UI changes also run `npx vite build && node scripts/screenshot-app.mjs <outDir>`, which screenshots every view in the real app against real data, and look at the affected views.

Nothing a check runs may open a window or take focus: the user works (and games) while sessions run. `screenshot-app.mjs` renders offscreen and passive; a test must never detach a console program (Windows Terminal, the default console here, turns its console into a visible window). The user often has `npm run dev` up, which restarts the app on any `electron/` change, so do multi-step code work in a worktree when they may be busy.

## Where things are documented

Design history and rationale live in `docs/` and in commit messages. Never cite a `~/.claude/plans/*.md` path: those are generated per plan and get deleted.

- `docs/automation.md` — the global hooks, scheduled jobs and every `scripts/*.mjs`, with the measurements behind each design. Read a script's section before changing it.
- `docs/functionality-audit.md` — what each feature is worth, plus two binding rejection lists. Read both before proposing a feature; many ideas have already been measured and refuted.
- `docs/not-a-worktree-manager.md` — why there is no worktree dashboard, diff viewer or merge/PR flow (2.2% of 735 agent runs were worktree-isolated). Don't reopen without a fresh audit.
- `docs/workflows.md` — the Workflows feature. `docs/vault-linker.md` — the linker.
- `docs/leverage-architecture.md` is history; its Tier A/B/C plan is superseded by the automation-or-nothing principle (infra is global and hands-off, or it isn't built).
- `docs/loop-handoff.md` — session-to-session handoff log, newest on top; older entries in `docs/loop-handoff-archive.md`.
- `docs/redesign/` — the design prototypes behind the 2026-10 redesign (style gallery, Home, Session Desktop); all merged.

## Conventions

- Feature slices: `src/features/<name>/` holds a thin `index.tsx` (composition only), a `use<Name>.ts` data hook, and sub-components. Cross-feature components go in `src/features/shared/`.
- Main process: `electron/<name>.ts`, one concern per module. Domain modules never import from `'electron'`, because CLI scripts load them under plain `node` (e.g. `curate-session.mjs` imports `sessions.ts`, `vault-write-core.ts`, `rubric-core.ts`, `registry.ts`) and `'electron'` has no real exports outside Electron. Electron-free core logic often lives in `*-core.ts` files.
- IPC: `shared/ipc-types.ts` is the single source of truth for the main↔renderer contract; add channels and types there first. `electron/hub-service.ts` maps channel → handler, typed against `HubApi`. `electron/ipc-handlers.ts` registers that map in one loop, plus the Electron-only handlers (shell, clipboard, dialog) individually. `hub-service.test.ts` checks that the two sets exactly cover the contract.
- Headless `claude -p` calls all go through `electron/call-claude-core.ts` (`callClaudeSync` for scripts, `callClaudeAsync` for main). It owns the `.cmd`-shim `shell: true`, `CLAUDE_HUB_HEADLESS`, `windowsHide` and JSON-envelope handling, and `loginEnv()` strips the user-env `ANTHROPIC_API_KEY` (another project's key) so hub-spawned `claude` runs on the claude.ai login.
- Scripts run directly by `node` (`scripts/*.mjs`) need explicit `.ts` extensions on relative imports. Vite resolves extension-less imports; Node's native TS support does not.
- Session state read from a transcript's tail goes through `readActivityTail` (`electron/live-core.ts`): Claude Code logs ~400KB request blobs mid-turn, so a fixed-size tail misses the prompt.

## Security

- Launch and write actions resolve paths in the main process by registry id, or through `electron/resolve-known-path.ts` against a known-good enumerator (`listSkills()`, `listExperimentPaths()`, `listWorkflows()`, vault note ids). Never trust a raw path from the renderer.
- Two deliberate variations: `skills:promote-global` writes outside any project (into `~/.claude/skills`), so it validates its source through `listSkills()`. `commands:launch-session` has no enumerator for built-in commands, so it constrains the name to a slash-command slug. That is safe because the name only reaches a URL-encoded `claude-cli://` deep link, and the opened session still waits for Enter.
- `spawn()`/`execFileSync()` of Windows `.cmd`/`.bat` shims (`code`, `claude`) need `shell: true`. That is only safe when no untrusted data is in the argument array; see `electron/launch.ts` and `scripts/curate-session.mjs`.

## The bug class to avoid: a failure rendered as an absence

No flag may mean both "not yet" and "never". The recurring bug here is not a swallowed exception. It is a failure shown as an empty result: a `loading` a rejected fetch leaves set forever, a `.catch` that returns `[]` and renders "No matches.", a cache that stores an error as a negative result, a scan that could not read its input reporting "none". Each one fed a real decision.

- A fetch path has three states (`loading` / `error` / `data`; see `useProjectFanOut`).
- A cache never stores an error as a negative result.
- A scan that could not read its input reports unknown, never none. When the UI can't honestly make a claim, it says what it couldn't reach.
- Renderer hooks are testable for this: `src/features/test-dom.ts` and the hook tests beside it.

## Background machinery (details in `docs/automation.md`)

- Global hooks in `~/.claude/settings.json`, running in every project: `scripts/curate-session.mjs` (SessionEnd: haiku triage, then sonnet extraction queues candidates to the vault's `_inbox.md`) and `scripts/vault-recall.mjs` (UserPromptSubmit: a detached haiku worker matches the session's task against vault note titles and injects up to 3 offers with a `[vault-recall]` marker).
- Scheduled jobs, enumerated by the `claude-hub` name prefix: floor verify (04:45), inbox drain (noon, auto-promotes high-confidence clusters). A new job's action must be `wscript.exe //B //Nologo scripts\run-hidden.vbs <exe> [args]`; a direct `node.exe` or `powershell -WindowStyle Hidden` opens a console that steals focus.
- Every automation `claude -p` sets `CLAUDE_HUB_HEADLESS=1` so the hooks don't recurse on the hub's own calls.
- One shared vault (`C:\projects\claude-hub-vault`), not one per project. Decided on measured cross-project link value; don't re-litigate without new numbers.
- The Global view grades every hook and job on a work probe (log recency, ledger records), never on configuration. A job with no probe grades `unknown`, never `ok`. Anything `attention` or `unknown` also shows in the dashboard's Needs-attention feed.

There is no hub server or phone build anymore (retired 2026-10-17; see the end of `docs/automation.md`). Don't reintroduce an HTTP transport or Agent SDK session ownership without a new reason.
