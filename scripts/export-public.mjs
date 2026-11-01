#!/usr/bin/env node
// Exports a commit of this repo as the public repo's next commit: the tree at
// <ref>, minus every path .gitattributes marks export-ignore, with none of the
// private history.
//
// USAGE:
//   node scripts/export-public.mjs <targetDir> --author "Name <email>" [--ref HEAD] [-m message]
//
// The first run creates <targetDir> as a new repo with one commit. Later runs
// replace its tree and commit on top. --author is required on purpose: the
// global git identity on this machine is a personal address, and a commit made
// without it would publish that address.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i === -1 ? fallback : args[i + 1]
}
const target = args[0] && !args[0].startsWith('-') ? path.resolve(args[0]) : null
const author = opt('--author')
const ref = opt('--ref', 'HEAD')
const message = opt('-m', 'Initial public release')
const m = author?.match(/^(.+?) <(.+)>$/)
if (!target || !m) {
  console.error('usage: node scripts/export-public.mjs <targetDir> --author "Name <email>" [--ref HEAD] [-m message]')
  process.exit(1)
}
const [, name, email] = m

const run = (cwd, cmd, cmdArgs, input) =>
  execFileSync(cmd, cmdArgs, { cwd, input, windowsHide: true, encoding: input ? undefined : 'utf-8', maxBuffer: 1 << 30 })

const isRepo = fs.existsSync(path.join(target, '.git'))
if (!isRepo && fs.existsSync(target) && fs.readdirSync(target).length > 0) {
  console.error(`refusing: ${target} exists, is not empty and is not a git repo`)
  process.exit(1)
}
fs.mkdirSync(target, { recursive: true })
if (!isRepo) run(target, 'git', ['init', '-q', '-b', 'main'])

// Replace the working tree with the exported one, so files deleted upstream
// are deleted here too.
for (const entry of fs.readdirSync(target)) {
  if (entry !== '.git') fs.rmSync(path.join(target, entry), { recursive: true, force: true })
}
const tar = execFileSync('git', ['archive', '--format=tar', ref], { cwd: repoRoot, windowsHide: true, maxBuffer: 1 << 30 })
run(target, 'tar', ['-xf', '-'], tar)

run(target, 'git', ['add', '-A'])
run(target, 'git', ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', message])
console.log(run(target, 'git', ['log', '--format=%h %an <%ae> %s', '-1']).trim())
console.log(`${run(target, 'git', ['ls-files']).split('\n').filter(Boolean).length} files in ${target}`)
