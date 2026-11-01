// Spawn-based launch actions — Electron-free (child_process only), served
// through hub-service.ts. The shell/clipboard-backed actions stay in
// launch.ts, which only exists inside Electron's own process.
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { listProjects } from './registry.ts'
import { findSessionFiles } from './sessions.ts'

// Every launch action resolves its path by id lookup against registry.json
// (the same source step 2 seeds/maintains) — never accepts a raw path from
// the renderer, so it can't be pointed at an unregistered location.
export function resolvePath(id: string): string {
  const entry = listProjects().find((e) => e.id === id)
  if (!entry) throw new Error(`No registered project with id "${id}"`)
  return entry.path
}

// Windows routes `.cmd`/`.bat` targets through cmd.exe internally regardless
// of the `shell` option (this is what CVE-2024-27980 was about — argument
// injection via a second layer of cmd.exe re-tokenization). VS Code's `code`
// CLI is exactly such a shim. Relying on "args stay an array" alone is not
// sufficient — reject any path containing characters that have no business
// in a real Windows filesystem path but do have meaning to cmd.exe, as a
// defense-in-depth check independent of which Node patch level is running.
//
// This blocklist targets the characters cmd.exe re-tokenizes for argument
// injection (`& | ^ < >`, quotes, newlines); `%` is included too (variable
// expansion). It is deliberately NOT extended to `(`/`)`/`,`/`;`: those are
// legal, common characters in real Windows paths — "C:\Program Files (x86)\…"
// is the obvious one — so blocking them would reject legitimate launches while
// adding no protection against the argument-injection shape here (a single
// path passed as one argv element). `&`/`%` are also legal in filenames
// ("R&D", "50% Done") and are rejected anyway, accepting a rare false reject
// for defense-in-depth. The fully robust fix — resolve VS Code's actual
// Code.exe and spawn it shell:false, no cmd.exe at all — is still deferred
// (the folder-picker/drag-drop "Add project" paths now DO admit user-typed
// paths, so this validator, not the seed-only registry, is the real guard).
const CMD_INJECTION_CHARS = /[&|^%"<>\n\r]/
export function assertSafeForCmdShim(projectPath: string): void {
  if (CMD_INJECTION_CHARS.test(projectPath)) {
    throw new Error(`Path contains characters unsafe for a shell-shim launch: ${projectPath}`)
  }
  // A trailing backslash immediately before a closing quote lets `\"`
  // escape the quote and merge the next token into this argument — a
  // distinct, well-known Windows quoting bug, not covered by the character
  // blocklist above.
  if (projectPath.endsWith('\\')) {
    throw new Error(`Path ends in a trailing backslash, unsafe for a shell-shim launch: ${projectPath}`)
  }
}

// main.ts puts three vars on process.env at startup: APP_ROOT and VITE_PUBLIC
// directly, plus VITE_DEV_SERVER_URL which vite-plugin-electron injects under
// `npm run dev`. spawn() hands a child the whole of process.env by default, so
// every launch below passes them on. VITE_DEV_SERVER_URL is the one that bites:
// main.ts READS it before writing anything (main.ts:26), so an Electron app
// started from a hub-launched terminal or editor calls loadURL() against the
// dev server instead of loading its own built renderer — a stale or blank
// window once that dev server is gone. The other two are overwritten at
// main.ts startup so they can't misdirect a child app, but they mean nothing
// outside this process and a VITE_-prefixed var is exposed to client code by
// any other Vite project built in that terminal, so they go too.
const HUB_ONLY_ENV = ['VITE_DEV_SERVER_URL', 'VITE_PUBLIC', 'APP_ROOT']
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of HUB_ONLY_ENV) delete env[key]
  return env
}

export function logSpawnFailure(label: string) {
  // spawn() is an EventEmitter — with zero 'error' listeners, a failed spawn
  // (e.g. the target isn't on PATH) throws uncaught in the main process and
  // can take the whole app down. This just prevents that; it doesn't try to
  // round-trip success/failure back to the renderer for a fire-and-forget
  // launch action.
  return (err: Error) => console.error(`[launch] ${label} failed:`, err)
}

function launchVSCode(targetPath: string, label: string): void {
  assertSafeForCmdShim(targetPath)
  const child = spawn('code', [targetPath], { shell: true, detached: true, stdio: 'ignore', env: childEnv() })
  child.on('error', logSpawnFailure(label))
  child.unref()
}

export function openInVSCode(id: string): void {
  launchVSCode(resolvePath(id), 'openInVSCode')
}

// NOT exposed as its own IPC channel — no registry-id resolution exists for
// an arbitrary path, so this stays an internal helper only ever called with
// a path a caller just computed itself (e.g. promote.ts's own destPath,
// fresh from fs.cpSync), never with something passed up from the renderer.
export function openPathInVSCode(targetPath: string): void {
  launchVSCode(targetPath, 'openPathInVSCode')
}

// "Open CLAUDE.md" — the config-health findings CTA. Keeps the id-not-path
// discipline: a null projectId means the global ~/.claude/CLAUDE.md, anything
// else resolves through the registry, and the filename is appended here, so
// the renderer can't steer this at an arbitrary file.
export function openClaudeMd(projectId: string | null): void {
  const dir = projectId === null ? path.join(os.homedir(), '.claude') : resolvePath(projectId)
  openPathInVSCode(path.join(dir, 'CLAUDE.md'))
}

export function openTerminal(id: string): void {
  const projectPath = resolvePath(id)
  // cmd.exe is a native executable, not a .cmd/.bat shim, so this needs no
  // shell:true — `cwd` sets the new window's starting directory without
  // ever embedding the path into command-line text.
  const child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe'], { cwd: projectPath, detached: true, stdio: 'ignore', env: childEnv() })
  child.on('error', logSpawnFailure('openTerminal'))
  child.unref()
}

// "Resume in terminal" — hands a session back to the CLI, where the hub's
// read-only/adopt distinction doesn't apply.
//
// Unlike every other action here, this one puts renderer-supplied DATA on a
// cmd.exe command line, and `cmd /c start` re-tokenizes its own arguments
// (the CVE-2024-27980 shape the blocklist above exists for). So the id is
// checked twice, independently:
//   1. shape — every transcript basename on this machine is a UUID, so
//      anything else is not a session id, whatever produced it;
//   2. existence — it must be a transcript actually on disk for THIS
//      project, the known-good-enumerator discipline resolveKnownPath
//      applies to paths.
// Either check alone would do the job today. Both, because the cost is a
// regex and a readdir and the failure mode is arbitrary command execution.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`Not a session id: "${sessionId}"`)
}

export function resumeSessionInTerminal(projectId: string, sessionId: string): void {
  const projectPath = resolvePath(projectId)
  assertSessionId(sessionId)
  const known = findSessionFiles(projectPath).map((file) => file.id)
  if (!known.includes(sessionId)) {
    throw new Error(`No session "${sessionId}" recorded in that project`)
  }
  const child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', 'claude', '--resume', sessionId], {
    cwd: projectPath,
    detached: true,
    stdio: 'ignore',
    env: childEnv(),
  })
  child.on('error', logSpawnFailure('resumeSessionInTerminal'))
  child.unref()
}

export function openRemoteControl(id: string): void {
  const projectPath = resolvePath(id)
  // Opens a new terminal in the project running `claude --remote-control` — an
  // interactive session steerable from claude.ai/code + the Claude mobile app.
  // Same safe shape as openTerminal: `cwd` sets the new window's directory
  // (never embedded in command-line text), and every command token is a fixed
  // literal. So — unlike the VS Code `.cmd` shim path above — no path/user data
  // reaches a shell as re-tokenizable text, leaving no argument-injection
  // surface even though `claude` resolves off PATH.
  const child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', 'claude', '--remote-control'], {
    cwd: projectPath,
    detached: true,
    stdio: 'ignore',
    env: childEnv(),
  })
  child.on('error', logSpawnFailure('openRemoteControl'))
  child.unref()
}

// A workflow file must live in a known workflows directory — either the global
// ~/.claude/workflows or a registered project's .claude/workflows. This covers
// both existing workflows (from listWorkflows) and one the hub just scaffolded
// (not yet re-scanned), without trusting a raw renderer path. Exact-match
// (like resolveKnownPath) — no prefix/traversal games.
// The Commands view's Run action has no path-backed enumerator to validate
// against — built-in slash commands are a static renderer catalog, not files —
// so the name is constrained to a slash-command slug instead. That is enough
// because the name only ever reaches a URL-encoded claude-cli:// deep link,
// never a shell, and the session it opens still waits for the user's Enter.
// Lives here rather than beside its caller so it sits under tests: launch.ts
// imports `electron` and cannot be loaded outside it.
const COMMAND_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/

export function assertCommandName(commandName: string): void {
  if (!COMMAND_NAME_RE.test(commandName)) throw new Error(`Not a command name: "${commandName}"`)
}

export function assertWorkflowsDirFile(filePath: string): void {
  const dir = path.dirname(filePath)
  const known = [
    path.join(os.homedir(), '.claude', 'workflows'),
    ...listProjects().map((p) => path.join(p.path, '.claude', 'workflows')),
  ]
  if (!known.includes(dir)) {
    throw new Error(`Refusing to act on a file outside a known workflows directory: ${filePath}`)
  }
}

// "Open in editor" — opens a workflow .js in VS Code. The path is validated to
// a known workflows dir first, then handed to the same cmd-shim-safe launcher
// promote uses (openPathInVSCode → assertSafeForCmdShim).
export function openWorkflowInEditor(scriptPath: string): void {
  assertWorkflowsDirFile(scriptPath)
  openPathInVSCode(scriptPath)
}
