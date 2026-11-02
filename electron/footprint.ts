// What claude-hub has applied outside its own folder, for the Settings page.
// Read from the real state every time (the registry, the hooks' logs,
// boundaries.json), never from a list kept by hand, so it can't drift from
// what is actually there. The global hooks and scheduled tasks themselves are
// the page's automation rows; this adds their reach and everything else.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hookScope, inHookScope, OUT_OF_SCOPE } from './hook-scope.ts'
import { listProjects, SANDBOX_PATH } from './registry.ts'
import { VAULT_PATH } from './vault-core.ts'
import { parseBoundaries } from './project-config-core.ts'
import { parseLogStamp } from './job-freshness.ts'
import { startMenuShortcutPath } from './app-identity.ts'
import type { HubFootprint } from '../shared/ipc-types.ts'

const DAY_MS = 864e5

// Lines in the last `days` that contain each needle. A missing log is zeros
// (the hook has not run yet); any other read failure is null, not zero.
export function countLogLines(file: string, needles: string[], now: number, days = 30): number[] | null {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? needles.map(() => 0) : null
  }
  const since = now - days * DAY_MS
  const counts = needles.map(() => 0)
  for (const line of text.split('\n')) {
    const stamp = parseLogStamp(line)
    if (!stamp || Date.parse(stamp) < since) continue
    needles.forEach((needle, i) => {
      if (line.includes(needle)) counts[i]++
    })
  }
  return counts
}

export function getFootprint(now: number = Date.now()): HubFootprint {
  const appRoot = process.env.APP_ROOT!
  const workspace = path.dirname(path.resolve(appRoot))
  const scope = hookScope(appRoot)
  const outside = scope.error
    ? []
    : listProjects()
        .filter((p) => !inHookScope(p.path, [workspace]))
        .map((p) => ({ name: p.name, path: p.path }))

  const scripts = path.join(appRoot, 'scripts')
  // A run's closing line carries cost= only when it paid for a model call, so
  // that counts the sessions curate actually read (most starts stand down).
  const curate = countLogLines(path.join(scripts, 'curate-session.log'), ['cost=', `exit: ${OUT_OF_SCOPE}`], now)
  const recall = countLogLines(path.join(scripts, 'vault-recall.log'), [`exit: ${OUT_OF_SCOPE}`], now)

  let denyRules: HubFootprint['denyRules'] = null
  let denyRulesError: string | null = null
  try {
    const file = path.join(appRoot, 'boundaries.json')
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null
    const targets = text === null ? {} : parseBoundaries(text).targets
    const names = new Map(listProjects().map((p) => [`project:${p.id}`, p.name]))
    denyRules = Object.entries(targets)
      .filter(([, b]) => (b.localGuard?.rules.length ?? 0) > 0)
      .map(([key, b]) => ({
        name: names.get(key) ?? key.replace(/^experiment:/, ''),
        rules: b.localGuard!.rules.length,
      }))
  } catch (err) {
    denyRulesError = `Couldn't read boundaries.json: ${(err as Error).message}`
  }

  const shortcut = startMenuShortcutPath()
  let shortcutPresent: boolean | null
  try {
    fs.statSync(shortcut)
    shortcutPresent = true
  } catch (err) {
    shortcutPresent = (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : null
  }

  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return {
    scope: { workspace, outside, error: scope.error },
    curate: curate ? { reviewed: curate[0], outside: curate[1] } : null,
    recallOutside: recall ? recall[0] : null,
    denyRules,
    denyRulesError,
    folders: [
      { label: 'Vault', path: VAULT_PATH },
      { label: 'Sandbox', path: SANDBOX_PATH },
      { label: 'Session host', path: path.join(localAppData, 'claude-hub') },
    ],
    startMenuShortcut: { path: shortcut, present: shortcutPresent },
  }
}
