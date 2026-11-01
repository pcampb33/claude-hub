// Test-only helpers for the Session Desktop integration tests: a stand-in for
// the Claude Code binary (CLAUDE_HUB_DESKTOP_EXE) and small polling waits.
// Never run the real `claude` from a test.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// The stand-in prints its args and two env vars the host must strip, shows a
// Claude-style trust menu, echoes input, clears the screen on "clear" and
// exits with code 3 on "quit". Returns the .cmd to point the host at. It also
// appends its args to args.log beside it (launchedArgs), since long args
// (the boundary statement) wrap on the terminal screen.
export function writeStandIn(dir: string): string {
  const script = path.join(dir, 'stand-in.mjs')
  fs.writeFileSync(
    script,
    [
      "import fs from 'node:fs'",
      `fs.appendFileSync(${JSON.stringify(path.join(dir, 'args.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n')`,
      "console.log('args:' + JSON.stringify(process.argv.slice(2)))",
      "console.log('env:' + JSON.stringify({ headless: process.env.CLAUDE_HUB_HEADLESS ?? null, child: process.env.CLAUDE_CODE_CHILD_SESSION ?? null }))",
      "console.log('Do you trust this folder?')",
      "console.log('')",
      "console.log('Claude Code may read files here.')",
      "console.log('\\u276F 1. Yes, proceed')",
      "console.log('  2. No, exit')",
      'process.stdin.setRawMode?.(true)',
      "process.stdin.on('data', (b) => {",
      '  const s = b.toString()',
      "  if (s.includes('quit')) process.exit(3)",
      "  if (s.includes('clear')) { process.stdout.write('\\x1b[2J\\x1b[3J\\x1b[Hready>'); return }",
      "  process.stdout.write('echo:' + JSON.stringify(s) + '\\r\\n')",
      '})',
      '',
    ].join('\n'),
  )
  const cmd = path.join(dir, 'stand-in.cmd')
  fs.writeFileSync(cmd, `@"${process.execPath}" "${script}" %*\r\n`)
  return cmd
}

// Every argv the stand-in in `dir` was started with, oldest first.
export function launchedArgs(dir: string): string[][] {
  try {
    return fs.readFileSync(path.join(dir, 'args.log'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
  } catch {
    return []
  }
}

// The first launch whose args begin with `prefix`, waited for.
export function launchedWith(dir: string, prefix: string[]): Promise<string[]> {
  const starts = (args: string[]) => prefix.every((a, i) => args[i] === a)
  return waitFor(() => launchedArgs(dir).find(starts), `a launch with args ${prefix.join(' ')}`)
}

export async function waitFor<T>(probe: () => T | undefined | null | false, what: string, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Ends every stand-in started from `dir`. Closing a session kills the pty's
// cmd.exe wrapper, which can leave its node child running (real sessions
// spawn claude.exe directly, so production has no wrapper). Matches only
// command lines that name this test's own stand-in script.
export function killStandIns(dir: string): void {
  if (process.platform !== 'win32') return
  const script = path.join(dir, 'stand-in.mjs')
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:STAND_IN) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      ],
      { env: { ...process.env, STAND_IN: script }, windowsHide: true, stdio: 'ignore', timeout: 15_000 },
    )
  } catch {
    // best effort: a teardown must not mask the test's own result
  }
}
