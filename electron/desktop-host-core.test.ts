import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import xtermHeadless from '@xterm/headless'
import { bottomLines, detectPrompt, ptyEnv, resolveClaudeExe, settleDelay } from './desktop-host-core.ts'

// Feed text through a real headless terminal, then scan it as the host does.
function screenOf(text: string, rows = 24): Promise<string[]> {
  const term = new xtermHeadless.Terminal({ cols: 80, rows, allowProposedApi: true })
  return new Promise((resolve) => term.write(text.replace(/\n/g, '\r\n'), () => resolve(bottomLines(term))))
}

test('permission dialog: prompting, with the question above the menu', async () => {
  const lines = await screenOf(' Bash command\n   rm -rf build\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again\n   3. No\n')
  assert.deepEqual(detectPrompt(lines), { prompting: true, line: 'Do you want to proceed?' })
})

test('trust dialog: the question is several lines above the menu', async () => {
  const lines = await screenOf('Do you trust the files in this folder?\n\nC:\\projects\\x\n\nClaude Code may read files here.\n\n❯ 1. Yes, proceed\n  2. No, exit\n')
  assert.deepEqual(detectPrompt(lines), { prompting: true, line: 'Do you trust the files in this folder?' })
})

test('boxed dialog borders are ignored', async () => {
  const lines = await screenOf('│ Allow this edit?       │\n│ ❯ 1. Yes               │\n│   2. No                │\n')
  assert.deepEqual(detectPrompt(lines), { prompting: true, line: 'Allow this edit?' })
})

test('a menu with no question still counts as prompting', async () => {
  assert.deepEqual(detectPrompt(await screenOf('Pick one\n❯ 1. Alpha\n  2. Beta\n')), { prompting: true, line: null })
})

test('the cursor on any choice is prompting: arrowing down the menu keeps needs-you', async () => {
  assert.deepEqual(detectPrompt(await screenOf('Do it?\n  1. Yes\n❯ 2. No\n')), { prompting: true, line: 'Do it?' })
  assert.deepEqual(detectPrompt(await screenOf('Pick?\n  1. a\n  2. b\n ❯ 12. l\n')), { prompting: true, line: 'Pick?' })
})

test('no menu, a menu with no cursor, or plain prose: not prompting', async () => {
  assert.deepEqual(detectPrompt(await screenOf('> what next?\n')), { prompting: false, line: null })
  assert.deepEqual(detectPrompt(await screenOf('Do it?\n  1. Yes\n  2. No\n')), { prompting: false, line: null })
  assert.deepEqual(detectPrompt(await screenOf('Step 1. Build it\n')), { prompting: false, line: null })
  assert.deepEqual(detectPrompt(await screenOf('❯ fix the build\n')), { prompting: false, line: null })
})

test('settleDelay waits for output to settle, but never past the max wait since the first unchecked chunk', () => {
  assert.equal(settleDelay(1000, 1000), 150)
  assert.equal(settleDelay(1000, 1800), 150)
  assert.equal(settleDelay(1000, 1900), 100)
  assert.equal(settleDelay(1000, 2000), 0)
  assert.equal(settleDelay(1000, 5000), 0)
})

test('a menu scrolled far above the last output is out of the scan window', async () => {
  const filler = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
  assert.deepEqual(detectPrompt(await screenOf(`Proceed?\n❯ 1. Yes\n${filler}\n`)), { prompting: false, line: null })
})

test('the scan window ends at the last non-blank row, not the screen bottom', async () => {
  const lines = await screenOf('Proceed?\n❯ 1. Yes\n', 50)
  assert.ok(lines.length <= 20)
  assert.deepEqual(detectPrompt(lines), { prompting: true, line: 'Proceed?' })
})

test("ptyEnv strips exactly the API key, Claude Code's session markers, the headless flag and hub-only vars, case-insensitively", () => {
  const markers = [
    'CLAUDECODE',
    'CLAUDE_CODE_BRIDGE_SESSION_ID',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_EFFORT',
    'CLAUDE_PID',
  ]
  const env = ptyEnv({
    PATH: 'C:\\bin',
    anthropic_api_key: 'sk-x',
    ...Object.fromEntries(markers.map((m) => [m, '1'])),
    Claude_Code_Entrypoint: 'cli',
    CLAUDE_HUB_HEADLESS: '1',
    ELECTRON_RUN_AS_NODE: '1',
    VITE_DEV_SERVER_URL: 'http://localhost:5173',
    VITE_PUBLIC: 'C:\\hub\\public',
    APP_ROOT: 'C:\\hub',
    // User configuration Claude Code reads: kept.
    CLAUDE_CONFIG_DIR: 'C:\\cfg',
    CLAUDE_CODE_GIT_BASH_PATH: 'C:\\git\\bash.exe',
    CLAUDE_CODE_USE_BEDROCK: '1',
    EMPTY: undefined,
  })
  assert.deepEqual(env, { PATH: 'C:\\bin', CLAUDE_CONFIG_DIR: 'C:\\cfg', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\git\\bash.exe', CLAUDE_CODE_USE_BEDROCK: '1' })
})

test('resolveClaudeExe prefers claude.exe on PATH', () => {
  const files = new Set([path.join('A', 'claude.cmd'), path.join('B', 'claude.exe')])
  assert.deepEqual(resolveClaudeExe(['A', 'B'].join(path.delimiter), (f) => files.has(f)), { exe: path.join('B', 'claude.exe') })
})

test('resolveClaudeExe falls back to the npm package binary beside claude.cmd', () => {
  const exe = path.join('npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  const files = new Set([path.join('npm', 'claude.cmd'), exe])
  assert.deepEqual(resolveClaudeExe(['X', 'npm'].join(path.delimiter), (f) => files.has(f)), { exe })
})

test('resolveClaudeExe names what it searched when nothing is found', () => {
  const none = resolveClaudeExe(['X', 'Y'].join(path.delimiter), () => false)
  assert.ok('error' in none && /2 PATH folders/.test(none.error) && /no claude\.cmd/.test(none.error))
  const shimOnly = resolveClaudeExe('npm', (f) => f === path.join('npm', 'claude.cmd'))
  assert.ok('error' in shimOnly && shimOnly.error.includes('claude.cmd found in npm'))
})
