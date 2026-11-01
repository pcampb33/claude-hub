import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readSessionTitle } from './sessions.ts'

function tmpJsonl(lines: string[]): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-latest-')), 's.jsonl')
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

test('readSessionTitle prefers an ai-title line near the file start', async () => {
  const file = tmpJsonl([
    JSON.stringify({ message: { role: 'user', content: 'fix the login bug' } }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Login bug investigation' }),
  ])
  assert.equal(await readSessionTitle(file), 'Login bug investigation')
})

test('readSessionTitle falls back to the first user message', async () => {
  const file = tmpJsonl([
    JSON.stringify({ message: { role: 'assistant', content: 'hello' } }),
    'not json at all',
    JSON.stringify({ message: { role: 'user', content: 'fix the login bug' } }),
  ])
  assert.equal(await readSessionTitle(file), 'fix the login bug')
})

test('readSessionTitle skips sidechain user turns', async () => {
  const file = tmpJsonl([
    JSON.stringify({ message: { role: 'user', content: 'subagent prompt' }, isSidechain: true }),
    JSON.stringify({ message: { role: 'user', content: 'the real question' } }),
  ])
  assert.equal(await readSessionTitle(file), 'the real question')
})

test('readSessionTitle handles a file with no usable lines', async () => {
  const file = tmpJsonl(['{}', 'garbage'])
  assert.equal(await readSessionTitle(file), '(no message found)')
})

test('readSessionTitle skips the isMeta caveat and the command-name/command-message/stdout wrappers', async () => {
  const file = tmpJsonl([
    JSON.stringify({ message: { role: 'user', content: '<local-command-caveat>Caveat: …' }, isMeta: true }),
    JSON.stringify({ message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
    JSON.stringify({ message: { role: 'user', content: '<local-command-stdout>cleared</local-command-stdout>' } }),
    JSON.stringify({ message: { role: 'user', content: 'the recent sessions list is noisy' } }),
  ])
  assert.equal(await readSessionTitle(file), 'the recent sessions list is noisy')
})

test('readSessionTitle returns the no-message sentinel for a command-only session', async () => {
  const file = tmpJsonl([
    JSON.stringify({ message: { role: 'user', content: '<command-name>/model</command-name>' } }),
    JSON.stringify({ message: { role: 'user', content: '<local-command-stdout>Set model to Fable 5</local-command-stdout>' } }),
  ])
  assert.equal(await readSessionTitle(file), '(no message found)')
})

test('readSessionTitle still prefers an ai-title over a following user prompt', async () => {
  const file = tmpJsonl([
    JSON.stringify({ message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Clean up sessions list' }),
    JSON.stringify({ message: { role: 'user', content: 'the real prompt' } }),
  ])
  assert.equal(await readSessionTitle(file), 'Clean up sessions list')
})

test('readSessionTitle skips harness-injected promptSource:"system" turns', async () => {
  const file = tmpJsonl([
    JSON.stringify({
      message: { role: 'user', content: 'Ultraplan terminated: Request failed with status code 401' },
      promptSource: 'system',
    }),
    JSON.stringify({ message: { role: 'user', content: 'the real question' }, promptSource: 'typed' }),
  ])
  assert.equal(await readSessionTitle(file), 'the real question')
})

test('readSessionTitle does not title a session from a tool_result turn', async () => {
  const file = tmpJsonl([
    JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result' }] } }),
    JSON.stringify({ message: { role: 'user', content: 'the real question' } }),
  ])
  assert.equal(await readSessionTitle(file), 'the real question')
})

test('readSessionTitle keeps the prose of a turn that also carries placeholder blocks', async () => {
  const file = tmpJsonl([
    JSON.stringify({
      message: { role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'why is this chart empty' }] },
    }),
  ])
  assert.equal(await readSessionTitle(file), 'why is this chart empty')
})

test('readSessionTitle returns the no-message sentinel when only placeholder turns exist', async () => {
  const file = tmpJsonl([
    JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result' }] } }),
    JSON.stringify({ message: { role: 'user', content: [{ type: 'thinking' }] } }),
  ])
  assert.equal(await readSessionTitle(file), '(no message found)')
})

test('readSessionTitle falls back to a slash command and its args', async () => {
  const file = tmpJsonl([
    JSON.stringify({
      message: {
        role: 'user',
        content: '<command-message>loop</command-message> <command-name>/loop</command-name> <command-args>20m check the deploy</command-args>',
      },
    }),
    JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result' }] } }),
  ])
  assert.equal(await readSessionTitle(file), '/loop 20m check the deploy')
})

test('readSessionTitle prefers a command carrying args over a bare one', async () => {
  const file = tmpJsonl([
    JSON.stringify({ message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
    JSON.stringify({
      message: { role: 'user', content: '<command-name>/loop</command-name> <command-args>20m check the deploy</command-args>' },
    }),
  ])
  assert.equal(await readSessionTitle(file), '/loop 20m check the deploy')
})

test('readSessionTitle prefers a real message over a command with args', async () => {
  const file = tmpJsonl([
    JSON.stringify({
      message: { role: 'user', content: '<command-name>/loop</command-name> <command-args>20m check the deploy</command-args>' },
    }),
    JSON.stringify({ message: { role: 'user', content: 'actually, do this instead' } }),
  ])
  assert.equal(await readSessionTitle(file), 'actually, do this instead')
})

test('readSessionTitle prefers an ai-title over a command with args', async () => {
  const file = tmpJsonl([
    JSON.stringify({
      message: { role: 'user', content: '<command-name>/loop</command-name> <command-args>20m check the deploy</command-args>' },
    }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Deploy watch loop' }),
  ])
  assert.equal(await readSessionTitle(file), 'Deploy watch loop')
})

test('readSessionTitle accepts the legacy title field on ai-title lines', async () => {
  const file = tmpJsonl([
    JSON.stringify({ type: 'ai-title', title: 'Legacy-format title' }),
    JSON.stringify({ message: { role: 'user', content: 'the real prompt' } }),
  ])
  assert.equal(await readSessionTitle(file), 'Legacy-format title')
})

// ---- per-project newest session ----
// Needs the registry + a real session dir, so it redirects both roots the same
// way live-core.test.ts does. Kept last: everything above is pure.
test('latestSessionPerProject dates a project by its last turn, not by exit bookkeeping', async () => {
  const { sanitize } = await import('./status.ts')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'latest-home-'))
  process.env.USERPROFILE = home
  process.env.HOME = home
  process.env.APP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'latest-root-'))
  const project = { id: 'p1', name: 'alpha', path: 'C:\\proj\\alpha', addedAt: '2026-06-15T00:00:00.000Z' }
  fs.writeFileSync(path.join(process.env.APP_ROOT, 'registry.json'), JSON.stringify([project]))
  const dir = path.join(home, '.claude', 'projects', sanitize(project.path))
  fs.mkdirSync(dir, { recursive: true })

  // Last real turn two days ago; the terminal was closed just now, which
  // appended timestamp-free bookkeeping and so bumped the file's mtime.
  const lastTurn = '2026-06-15T12:00:00.000Z'
  fs.writeFileSync(
    path.join(dir, 'real.jsonl'),
    [
      JSON.stringify({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: 'the real question' }, timestamp: lastTurn }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, timestamp: lastTurn }),
      JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: lastTurn }),
      JSON.stringify({ type: 'bridge-session', bridgeSessionId: 'b1' }),
      JSON.stringify({ type: 'cost-state', totalCostUSD: 2 }),
    ].join('\n') + '\n',
  )

  const { latestSessionPerProject } = await import('./latest-sessions.ts')
  const [entry] = await latestSessionPerProject()
  assert.equal(entry.registryId, 'p1')
  assert.equal(entry.title, 'the real question')
  assert.equal(entry.timestamp, lastTurn, 'the mtime is today; the answer must be the turn')

  fs.rmSync(home, { recursive: true, force: true })
})
