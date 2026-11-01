// Commit the vault after an unattended write.
//
// Round 1's audit found "the vault had no version control while a daily
// unattended job promoted into it" and fixed it with `git init` plus one
// baseline commit. That repo has held exactly one commit ever, and nothing in
// `scripts/` or `electron/` has ever run `git commit` — so it recovers the
// state of the vault at the moment of the snapshot and protects nothing written
// afterwards. A safety net that is present and holds nothing is this codebase's
// own bug class at the recovery layer, so this closes it where the writes
// happen.
//
// Deliberately NOT a general git wrapper. It commits everything currently in
// the vault working tree under a generated message and reports what happened;
// it never pushes, never branches, never resolves a conflict, and never touches
// a repo other than the vault.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { VaultCommitOutcome } from '../shared/ipc-types.ts'

// The four outcomes, defined in shared/ipc-types.ts because this rides
// VaultWriteResult across IPC:
//   committed         - with the short sha
//   nothing-to-commit - the write was a no-op, or everything it touched is gitignored
//   not-a-repo        - a first-class answer, not a failure: a user who has not
//                       run `git init` still gets working writes
//   failed            - git ran and failed. Reported, never swallowed, because
//                       "the commit failed" and "there was nothing to commit"
//                       must not look alike.
export type VaultCommitResult = VaultCommitOutcome

export function commitVault(vaultPath: string, message: string): VaultCommitResult {
  if (!fs.existsSync(path.join(vaultPath, '.git'))) return { kind: 'not-a-repo' }

  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: vaultPath, encoding: 'utf-8', windowsHide: true }).trim()

  try {
    // --porcelain is empty exactly when the tree is clean. Checked before
    // staging so an unattended job that changed nothing does not mint an empty
    // commit every night.
    if (git(['status', '--porcelain']) === '') return { kind: 'nothing-to-commit' }
    git(['add', '-A'])
    // Re-check AFTER staging: everything the write touched may be gitignored
    // (the vault ignores _backups/, _inbox-backups/ and the run-state files),
    // in which case `commit` would exit nonzero and read as a real failure.
    if (git(['diff', '--cached', '--name-only']) === '') return { kind: 'nothing-to-commit' }
    git(['commit', '-m', message])
    return { kind: 'committed', sha: git(['rev-parse', '--short', 'HEAD']) }
  } catch (err) {
    const e = err as { message?: string; stderr?: Buffer | string }
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf-8')
    return { kind: 'failed', message: (stderr || e.message || String(err)).slice(0, 300).trim() }
  }
}
