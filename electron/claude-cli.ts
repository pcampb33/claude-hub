// Runs a non-`-p` `claude` subcommand (`mcp list`, `plugin list --json`,
// `plugin details <id>`, `plugin enable|disable <id>`) and returns its stdout.
// call-claude-core.ts owns the headless `-p` calls; this is its sibling for
// the management CLI, with the same invariants:
//
// - `claude` is a .cmd shim on Windows, so the spawn needs shell:true. That is
//   only safe with no untrusted text in argv, so every argument must pass
//   SAFE_ARG: callers pass fixed literals or an id they already validated
//   against `claude plugin list --json`. The check here is the backstop that
//   keeps a future caller from handing a renderer string to cmd.exe.
// - loginEnv() strips the user-env ANTHROPIC_API_KEY (another project's key).
// - windowsHide stops the cmd.exe wrapper flashing a console.
// - every call is on a deadline that tree-kills: with shell:true the pid is
//   the wrapper, and killing only it leaves `claude` running underneath.
//
// Electron-free.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { loginEnv } from './call-claude-core.ts'

// Letters, digits and `@ . _ : -` only: enough for subcommands, flags and
// plugin ids (`design@synced`, `frontend-design@claude-plugins-official`),
// and nothing cmd.exe treats specially (no space, quote, &, |, <, >, ^, %).
const SAFE_ARG = /^[A-Za-z0-9@._:-]+$/

export function assertSafeArgs(args: string[]): void {
  for (const arg of args) {
    if (!SAFE_ARG.test(arg)) throw new Error(`Refusing to pass ${JSON.stringify(arg)} to the claude CLI`)
  }
}

export function runClaudeCli(args: string[], opts: { timeoutMs: number; cwd?: string }): Promise<string> {
  assertSafeArgs(args)
  const child = spawn('claude', args, { shell: true, windowsHide: true, env: loginEnv(), cwd: opts.cwd })
  return awaitCliChild(child, `claude ${args.join(' ')}`, opts.timeoutMs)
}

// Exported for its own tests: the deadline and the settle-once guard can't
// be observed from the call site without a real `claude` that hangs.
export function awaitCliChild(child: ChildProcessWithoutNullStreams, label: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    // A timed-out call stays timed out: the kill produces its own 'close'.
    let settled = false
    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      finish()
    }
    const timer = setTimeout(() => {
      // taskkill /T walks the tree from the cmd.exe wrapper. Killing the
      // wrapper first (child.kill) leaves taskkill nothing to walk from, and
      // orphans `claude` plus every MCP server it started — measured.
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
          .on('error', () => child.kill())
          .on('close', (code) => code !== 0 && child.kill())
      } else child.kill()
      settle(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)))
    }, timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf-8')))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf-8')))
    child.on('error', (error) => settle(() => reject(error)))
    child.stdin.on('error', () => {})
    child.stdin.end()
    child.on('close', (code) =>
      settle(() => {
        if (code === 0) resolve(out)
        else reject(new Error(`${label} exited ${code}: ${(err || out).trim().slice(0, 300)}`))
      }),
    )
  })
}
