// The one way hub automation talks to `claude -p`. Every headless call —
// curate triage/extract, inbox drain, vault linker (backfill + incremental),
// recall worker — goes through here, so the invariants live in exactly one
// place instead of drifting across per-script copies (the incremental linker
// shipped without the CLAUDE_HUB_HEADLESS guard for a month that way):
//
// - `claude` is a .cmd shim on Windows (same PATHEXT issue as VS Code's CLI
//   in launch.ts), so the spawn needs shell:true. No injection surface:
//   every argv entry is a fixed literal and the prompt goes through stdin,
//   never argv.
// - CLAUDE_HUB_HEADLESS=1 marks the child session as hub automation so the
//   global vault-recall UserPromptSubmit hook skips it
//   (scripts/vault-recall.mjs). Prompt-size ceilings alone are NOT a
//   reliable guard — a curate triage of a small transcript slips under them.
// - windowsHide keeps the cmd.exe shell child from flashing a visible
//   console when the caller has none (observed live from the detached
//   recall worker, 2026-08-09; a no-op for console-attached callers).
// - --output-format json so per-call cost is logged (the
//   instrument-before-opus decision); the envelope is unwrapped here.
// - every call is on a deadline, both variants. A `claude` that never answers
//   used to leave the async variant pending forever, and the Knowledge view's
//   "Relinking…" with it — a loading flag that means both "not yet" and
//   "never". The sync variant's deadline is weaker than the async one and
//   says so at callClaudeSync: it bounds the caller, not the spend.
//
// Electron-free — imported by CLI scripts via plain `node` (hence the
// explicit .ts extension) and by main-process modules alike.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { extractResultFromJsonOutput } from './curate-core.ts'

export interface CallClaudeResult {
  text: string
  costUsd: number | null
}

// Ceiling, not an allocation — sized for the largest caller (drain's
// whole-inbox call).
const MAX_BUFFER = 20 * 1024 * 1024

// Both exported for their own tests. They are the whole reason this module
// exists — the argv shape and the recursion guard are what drifted when each
// script built its own call, and neither is observable from the outside
// without spawning a real model.
export function claudeArgs(model: string): string[] {
  return ['-p', '--model', model, '--output-format', 'json']
}

// Hub-spawned `claude` runs on the claude.ai login, never on an API key. The
// key is set in the Windows *user* environment for another project, which
// every scheduled task inherits — and an API key takes
// precedence over the login. When that key's account hit its spend limit
// (2026-10-10) the drain, linker and curate calls all exited 1 with "You have
// reached your specified API usage limits" while interactive sessions, which
// don't carry the key, kept working.
export function loginEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  return env
}

export function headlessEnv(): NodeJS.ProcessEnv {
  return { ...loginEnv(), CLAUDE_HUB_HEADLESS: '1' }
}

// Chosen from the logs, not from taste. Across 1300 curate hook runs a single
// `claude -p` call sits at ~21s median, ~44s p90, ~238s p99
// (scripts/curate-session.log), and the slowest per-note linker call ever
// recorded is 110s (scripts/link-vault.log). 300s is also the budget the
// SessionEnd hook is already registered with in ~/.claude/settings.json, so no
// caller upstream would wait longer than this anyway. Past it the call is
// hung, not slow.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

// One phrasing for both variants. A caller that learns to recognise a deadline
// from one of them must not miss it from the other.
const timedOutError = (timeoutMs: number) => new Error(`claude -p timed out after ${timeoutMs}ms`)

// Blocking variant for CLI scripts, where a synchronous wait is fine. Throws
// execFileSync's error (with .status) on a nonzero exit, and a named timeout
// error on the deadline.
//
// The deadline bounds THIS process, not the spend, and the difference is the
// whole caveat. shell:true means the child is a cmd.exe wrapper, so
// execFileSync's `timeout` SIGTERMs the wrapper while the `claude` beneath it
// keeps running and keeps billing (measured 2026-08-22: the grandchild is
// still alive after the throw, and the error message names cmd.exe). The async
// twin tree-kills for exactly this reason, and that option is not available
// here: spawnSync has already reaped the wrapper by the time it throws, so
// `taskkill /T` would have no live tree to walk from — and a reaped pid is
// reusable, so killing it later is someone else's process. A caller that must
// not leak a billed child has to move to callClaudeAsync; what a sync caller
// gets from this deadline is a deterministic, named failure at a known bound
// instead of being killed at an arbitrary point by its own hook harness (304
// of 1681 curate runs, 18.1%, ended with no logged outcome that way).
export function callClaudeSync(
  model: string,
  prompt: string,
  opts: { timeoutMs?: number } = {},
  // Seam for this module's own tests, the way awaitClaudeChild takes its
  // child: watching a real `claude` hang costs a model call per test run.
  exec: typeof execFileSync = execFileSync,
): CallClaudeResult {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const raw = exec('claude', claudeArgs(model), {
      shell: true,
      input: prompt,
      encoding: 'utf-8',
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      env: headlessEnv(),
      windowsHide: true,
    })
    return extractResultFromJsonOutput(raw)
  } catch (error) {
    // ETIMEDOUT is spawnSync's own code for its deadline — it arrives with a
    // null status and SIGTERM, where a nonzero exit carries a status and no
    // code, so the two never blur. Renamed here because spawnSync's own
    // wording ("spawnSync C:\WINDOWS\system32\cmd.exe ETIMEDOUT") reads as a
    // spawn failure and names the wrapper rather than the call that hung.
    if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT') throw timedOutError(timeoutMs)
    throw error
  }
}

// Async variant for the Electron main process, where a sync call would block
// the event loop for the whole LLM call and freeze IPC/UI in every window
// (execFile's async form has no `input` option, so this writes stdin itself).
export function callClaudeAsync(model: string, prompt: string, opts: { timeoutMs?: number } = {}): Promise<CallClaudeResult> {
  const child = spawn('claude', claudeArgs(model), {
    shell: true,
    windowsHide: true,
    env: headlessEnv(),
  })
  return awaitClaudeChild(child, prompt, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
}

// Exported for its own tests, for the same reason claudeArgs/headlessEnv are:
// the deadline, the kill and the settle-once guard are invisible from the call
// site, and the only way to watch a real `claude` hang is to pay for a model
// call per test run.
export function awaitClaudeChild(
  child: ChildProcessWithoutNullStreams,
  prompt: string,
  timeoutMs: number,
): Promise<CallClaudeResult> {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    // A timed-out call must stay timed out. Killing the child produces its own
    // 'close', and a close carrying 0 would otherwise resolve a promise that
    // already reported the timeout — the failure-rendered-as-a-normal-result
    // shape CLAUDE.md names.
    let settled = false
    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      // Every path into settle() is an async event, so `timer` below is always
      // assigned by the time this reads it. Keep it that way: a synchronous
      // settle added above the assignment would hit its dead zone.
      clearTimeout(timer)
      finish()
    }
    const timer = setTimeout(() => {
      // shell:true means child.pid is the cmd.exe wrapper: kill() stops that
      // wrapper, but on its own it orphans the `claude` process underneath
      // (the same leak run-verify.ts and sandbox.ts tree-kill to avoid), so
      // the deadline takes the whole tree down. A timeout that leaves a live
      // model call running is half a fix. taskkill alone, never after kill():
      // once the wrapper is dead taskkill /T finds no process and walks no tree.
      if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill()
      // Named as a timeout, never as a plain failure — the caller has to be
      // able to tell "the model said no" from "nobody ever answered".
      settle(() => reject(timedOutError(timeoutMs)))
    }, timeoutMs)
    // A pending call must not hold a CLI script open past its work, the way
    // usage.ts's deadline does.
    timer.unref?.()
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf-8')))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf-8')))
    child.on('error', (error) => settle(() => reject(error)))
    // 'error' on the ChildProcess does NOT cover its stdin. A `claude` that
    // dies before reading the prompt makes the write below raise EPIPE on that
    // stream, and an unhandled stream 'error' throws out of the event loop —
    // taking down the Electron main process, not just this call.
    child.stdin.on('error', (error) => settle(() => reject(error)))
    child.on('close', (code) =>
      settle(() => {
        if (code === 0) resolve(extractResultFromJsonOutput(out))
        else reject(new Error(`claude -p exited ${code}: ${err.slice(0, 300)}`))
      }),
    )
    child.stdin.write(prompt)
    child.stdin.end()
  })
}
