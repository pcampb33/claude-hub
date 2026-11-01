import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertSafeForCmdShim,
  resolvePath,
  assertWorkflowsDirFile,
  assertCommandName,
  assertSessionId,
  resumeSessionInTerminal,
  openClaudeMd,
  childEnv,
} from './launch-core.ts'

// resolvePath/openClaudeMd/assertWorkflowsDirFile all reach listProjects(),
// which joins process.env.APP_ROOT — so point it at a scratch dir holding an
// empty registry, the same shape skills.test.ts and session-search.test.ts use.
// Until now these three passed only because a terminal launched from a
// dev-mode hub inherited APP_ROOT (exactly the leak childEnv closes); run in a
// clean shell, registryPath() threw a TypeError instead of the rejection each
// test expects. Writing an empty registry also stops readRegistry seeding and
// writing the real registry.json as a side effect of running the suite.
const SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-launch-'))
process.env.APP_ROOT = SCRATCH_ROOT
fs.writeFileSync(path.join(SCRATCH_ROOT, 'registry.json'), '[]')

// Restores prior values rather than blind-deleting: APP_ROOT is set above and
// every test below that reaches listProjects() depends on it still being set.
function setEnv(vars: Record<string, string>): () => void {
  const prior = Object.keys(vars).map((k) => [k, process.env[k]] as const)
  Object.assign(process.env, vars)
  return () => {
    for (const [k, v] of prior) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

// The launch actions spawn VS Code's `code` .cmd shim with shell:true, which
// routes through cmd.exe — so a path reaching it must not carry cmd.exe
// re-tokenization metacharacters (CVE-2024-27980 shape). This validator is the
// guard now that folder-picker/drag-drop admit user-typed paths.

test('assertSafeForCmdShim accepts ordinary Windows paths', () => {
  for (const p of [
    'C:\\Users\\me\\projects\\claude-hub',
    'C:\\my project with spaces\\app',
    'D:\\code\\thing-1_2.3',
  ]) {
    assert.doesNotThrow(() => assertSafeForCmdShim(p), p)
  }
})

// Parens / commas / semicolons are legal, common path characters — blocking
// them would reject "Program Files (x86)". They must pass.
test('assertSafeForCmdShim accepts paths with parens, commas, semicolons', () => {
  for (const p of [
    'C:\\Program Files (x86)\\Microsoft VS Code',
    'C:\\projects\\a,b',
    'C:\\projects\\a;b',
  ]) {
    assert.doesNotThrow(() => assertSafeForCmdShim(p), p)
  }
})

test('assertSafeForCmdShim rejects every cmd.exe injection metacharacter', () => {
  for (const bad of ['&', '|', '^', '%', '"', '<', '>', '\n', '\r']) {
    assert.throws(() => assertSafeForCmdShim(`C:\\a${bad}b`), /unsafe for a shell-shim launch/, `char ${JSON.stringify(bad)}`)
  }
})

test('assertSafeForCmdShim rejects a trailing backslash (quote-escape bug)', () => {
  assert.throws(() => assertSafeForCmdShim('C:\\projects\\app\\'), /trailing backslash/)
})

test('assertSafeForCmdShim allows an interior backslash (normal path separator)', () => {
  assert.doesNotThrow(() => assertSafeForCmdShim('C:\\a\\b\\c'))
})

test('resolvePath rejects an unregistered project id', () => {
  assert.throws(() => resolvePath('definitely-not-a-registered-id-xyz'), /No registered project/)
})

// The non-null branch must resolve through the registry before it appends
// CLAUDE.md — so an id the renderer made up throws instead of spawning. (The
// global branch isn't covered: exercising it would open VS Code for real.)
test('openClaudeMd rejects an unregistered project id', () => {
  assert.throws(() => openClaudeMd('definitely-not-a-registered-id-xyz'), /No registered project/)
})

// A launched terminal/editor is long-lived, and anything started from it
// inherits whatever we handed the shell. main.ts reads VITE_DEV_SERVER_URL
// before writing it, so leaking it makes a child Electron app load the dev
// server (blank once that server is gone) instead of its built renderer.
test('childEnv drops the vars main.ts owns but keeps the rest of the env', () => {
  const restore = setEnv({
    VITE_DEV_SERVER_URL: 'http://localhost:5173/',
    VITE_PUBLIC: 'C:\\projects\\claude-hub\\public',
    APP_ROOT: 'C:\\projects\\claude-hub',
    // Asserted below instead of PATH: process.env lookups are case-insensitive
    // on Windows but childEnv's spread copy is not, so a PATH-vs-Path
    // assertion would be platform-dependent.
    CLAUDE_HUB_ENV_PROBE: 'kept',
  })
  try {
    const env = childEnv()
    assert.equal(env.VITE_DEV_SERVER_URL, undefined)
    assert.equal(env.VITE_PUBLIC, undefined)
    assert.equal(env.APP_ROOT, undefined)
    assert.equal(env.CLAUDE_HUB_ENV_PROBE, 'kept')
  } finally {
    restore()
  }
})

// childEnv scrubs a copy — the hub's own process still needs APP_ROOT.
test('childEnv does not mutate process.env', () => {
  const before = process.env.APP_ROOT
  childEnv()
  assert.equal(process.env.APP_ROOT, before)
  assert.equal(process.env.APP_ROOT, SCRATCH_ROOT)
})

test('assertWorkflowsDirFile rejects a file outside any known workflows dir', () => {
  assert.throws(
    () => assertWorkflowsDirFile('C:\\tmp\\evil\\workflow.js'),
    /outside a known workflows directory/,
  )
})

// ---- the command-name guard ----
//
// The only launch input with no path-backed enumerator behind it: built-in
// slash commands are a static renderer catalog, so the shape of the name is
// the whole check. It is a weaker guard than the others by necessity, which is
// exactly why it should be pinned rather than assumed.

test('assertCommandName accepts the shapes a real slash command takes', () => {
  for (const name of ['compact', 'code-review', 'parallel_build', 'plugin:skill', 'loop2']) {
    assert.doesNotThrow(() => assertCommandName(name), name)
  }
})

// Nothing here reaches a shell — the name only ever lands in a URL-encoded
// deep link — but a name that is not a command name means the renderer is
// sending something it was never meant to, and that is worth refusing loudly
// rather than passing along.
test('assertCommandName refuses anything that is not a command name', () => {
  const rejected = [
    '', // nothing at all
    '-leading-dash', // must start alphanumeric
    'has space',
    'quote"inside',
    'semi;colon',
    'path/traversal',
    'back\\slash',
    'newline\nafter',
    'a'.repeat(65), // past the 64-character ceiling
  ]
  for (const name of rejected) {
    assert.throws(() => assertCommandName(name), /Not a command name/, JSON.stringify(name))
  }
})

// resumeSessionInTerminal is the only launch action that puts renderer-supplied
// DATA on a cmd.exe command line, and `cmd /c start` re-tokenizes its own
// arguments — so these pin the two independent guards, not the spawn.
test('a session id must be a UUID, because it reaches a cmd.exe command line', () => {
  assertSessionId('c007389a-de54-4436-8dc3-299f7815ed02')
  assertSessionId('C007389A-DE54-4436-8DC3-299F7815ED02')
  for (const bad of [
    'c007389a-de54-4436-8dc3-299f7815ed02 & calc',
    'c007389a-de54-4436-8dc3-299f7815ed02"&calc&"',
    '../../etc/passwd',
    '',
    'c007389a-de54-4436-8dc3-299f7815ed0',
  ]) {
    assert.throws(() => assertSessionId(bad), /Not a session id/, `should reject ${JSON.stringify(bad)}`)
  }
})

test('resuming refuses an unregistered project before it spawns anything', () => {
  assert.throws(
    () => resumeSessionInTerminal('no-such-project', 'c007389a-de54-4436-8dc3-299f7815ed02'),
    /No registered project/,
  )
})

test('resuming refuses a well-formed id with no transcript on disk', () => {
  // The registry is the empty scratch one, so add a project whose session
  // directory holds exactly one transcript and ask for a different id.
  const projectPath = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'proj-'))
  fs.writeFileSync(
    path.join(SCRATCH_ROOT, 'registry.json'),
    JSON.stringify([{ id: 'p1', name: 'p1', path: projectPath }]),
  )
  assert.throws(
    () => resumeSessionInTerminal('p1', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    /No session .* recorded in that project/,
  )
  fs.writeFileSync(path.join(SCRATCH_ROOT, 'registry.json'), '[]')
})
