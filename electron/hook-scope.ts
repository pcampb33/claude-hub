// Where claude-hub's global hooks (curate, recall) act. They are registered in
// ~/.claude/settings.json, so Claude Code starts them in every session on the
// machine; this decides which of those sessions they may read. In scope: the
// folder that holds the claude-hub install (C:\projects here), the sandbox, and
// every registered project. Anywhere else they exit before reading the
// transcript or spending a model call. There is no setting for it: registering
// a project brings it into scope, removing it takes it out.
//
// Electron-free: both hook scripts load it under plain node.
import path from 'node:path'
import { listProjects, SANDBOX_PATH } from './registry.ts'

export interface HookScope {
  roots: string[]
  // Set when the registry couldn't be read: the scope is then the workspace
  // and sandbox only, never wider, and the hooks log why.
  error: string | null
}

export function hookScope(appRoot: string): HookScope {
  const base = [path.dirname(path.resolve(appRoot)), SANDBOX_PATH]
  try {
    return { roots: [...base, ...listProjects().map((p) => p.path)], error: null }
  } catch (err) {
    return { roots: base, error: `couldn't read the project registry: ${(err as Error).message}` }
  }
}

const norm = (p: string) => path.resolve(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

export function inHookScope(cwd: string, roots: string[]): boolean {
  if (!cwd) return false
  const c = norm(cwd)
  return roots.some((root) => {
    const r = norm(root)
    return c === r || c.startsWith(r + '\\')
  })
}

// The line both hooks log when they stand down; the Global view counts it.
export const OUT_OF_SCOPE = "outside claude-hub's scope"
