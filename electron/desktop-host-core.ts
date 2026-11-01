// Pure pieces of the Session Desktop host (desktop-host.ts), split out so
// node --test can exercise them without starting a host. Electron-free.
import path from 'node:path'
import type { Terminal } from '@xterm/headless'

// Claude Code's permission, trust and question dialogs all render a numbered
// menu with the cursor on a choice ("❯ 1. Yes"). While the cursor sits on any
// choice (arrowing down moves it) the menu is waiting for an answer; that is
// the "needs you" signal.
const PROMPT_CURSOR = /^\s*❯\s*\d+\.\s/
// Dialog borders some versions draw down the sides of the box.
const BORDER = /^[\s│┃|]+|[\s│┃|]+$/g

export const PROMPT_SCAN_LINES = 20

// Output settles for SETTLE_MS before the screen is checked for a choice menu,
// but a UI that never stops redrawing (a spinner) is still checked at least
// every MAX_SETTLE_WAIT_MS. pendingSinceMs: the first chunk not yet checked.
export const SETTLE_MS = 150
export const MAX_SETTLE_WAIT_MS = 1_000
export function settleDelay(pendingSinceMs: number, nowMs: number): number {
  return Math.max(0, Math.min(SETTLE_MS, pendingSinceMs + MAX_SETTLE_WAIT_MS - nowMs))
}

export interface PromptState {
  prompting: boolean
  line: string | null // the question above the menu, if one ends with '?'
}

// Given the bottom lines of the screen, top to bottom: is a choice menu up,
// and what is it asking? The question is the nearest line above the cursor
// that ends with '?'. The trust dialog puts a path and a paragraph between
// the question and the menu, so "the line right above" would miss it.
export function detectPrompt(lines: string[]): PromptState {
  const clean = lines.map((line) => line.replace(BORDER, ''))
  for (let i = clean.length - 1; i >= 0; i--) {
    if (!PROMPT_CURSOR.test(clean[i])) continue
    for (let j = i - 1; j >= 0; j--) {
      const text = clean[j].trim()
      if (text.endsWith('?')) return { prompting: true, line: text }
    }
    return { prompting: true, line: null }
  }
  return { prompting: false, line: null }
}

// The last `count` rows of output on the visible screen of the active buffer
// (the alternate buffer while a full-screen UI is up), as plain text. Counted
// up from the last non-blank row, not the screen's bottom edge: Claude Code
// renders inline, so on a fresh screen its menu sits near the top with empty
// rows below it.
export function bottomLines(term: Terminal, count = PROMPT_SCAN_LINES): string[] {
  const buffer = term.buffer.active
  const text = (y: number) => buffer.getLine(y)?.translateToString(true) ?? ''
  let end = buffer.baseY + term.rows
  while (end > buffer.baseY && text(end - 1).trim() === '') end--
  const lines: string[] = []
  for (let y = Math.max(0, end - count); y < end; y++) lines.push(text(y))
  return lines
}

// Variables a desktop session must not inherit: hub-only ones (see
// launch-core.ts childEnv for why VITE_DEV_SERVER_URL in particular misdirects
// an Electron app built from that terminal), and the session markers Claude
// Code injects into its own children (measured: none is set at user or
// machine scope). Other CLAUDE_CODE_* names are user configuration
// (CLAUDE_CODE_GIT_BASH_PATH, CLAUDE_CODE_USE_BEDROCK…) and pass through.
const STRIPPED = new Set([
  'ANTHROPIC_API_KEY',
  'ELECTRON_RUN_AS_NODE',
  'CLAUDE_HUB_HEADLESS',
  'VITE_DEV_SERVER_URL',
  'VITE_PUBLIC',
  'APP_ROOT',
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
])

// The environment a desktop session's Claude Code runs in.
// - ANTHROPIC_API_KEY belongs to another project; without it claude runs on
//   the claude.ai login (call-claude-core.ts loginEnv).
// - Claude Code's session markers: an inherited CLAUDE_CODE_CHILD_SESSION
//   turns transcript saving off, which blinds the state reader that reads it.
// - CLAUDE_HUB_HEADLESS would switch the user's own hooks off; a desktop
//   session is a real session and must run them.
// Windows env names are case-insensitive, so compare upper-cased.
export function ptyEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (STRIPPED.has(key.toUpperCase())) continue
    out[key] = value
  }
  return out
}

// The Claude Code binary, spawned directly (no cmd.exe, no shell): the first
// claude.exe on PATH, else the native binary the npm package ships beside a
// claude.cmd shim. Returns what was searched when neither exists.
export function resolveClaudeExe(
  pathVar: string | undefined,
  isFile: (file: string) => boolean,
): { exe: string } | { error: string } {
  const dirs = (pathVar ?? '').split(path.delimiter).filter((dir) => dir.trim().length > 0)
  for (const dir of dirs) {
    const exe = path.join(dir, 'claude.exe')
    if (isFile(exe)) return { exe }
  }
  const shimDirs: string[] = []
  for (const dir of dirs) {
    if (!isFile(path.join(dir, 'claude.cmd'))) continue
    shimDirs.push(dir)
    const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    if (isFile(exe)) return { exe }
  }
  const shims = shimDirs.length > 0 ? `; claude.cmd found in ${shimDirs.join(', ')} but no claude.exe under its node_modules\\@anthropic-ai\\claude-code\\bin` : '; no claude.cmd on PATH either'
  return { error: `Claude Code not found: no claude.exe in any of ${dirs.length} PATH folders${shims}` }
}
