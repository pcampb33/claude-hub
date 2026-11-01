import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  decideTakeOver,
  isClaudeWrapper,
  parseClaudeRecord,
  parseProcessFacts,
  queryProcess,
  readClaudeProcesses,
  resolveTargetIn,
  targetForCwd,
  toOutsideSession,
  type ProcessFacts,
} from './desktop-outside.ts'
import type { RegistryEntry } from '../shared/ipc-types.ts'

const SID = 'b67256ae-1111-4222-8333-444455556666'
// The shape measured on this machine (2.1.302), trimmed of the socket fields.
const real = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    pid: 270052,
    sessionId: SID,
    cwd: 'C:\\projects\\trading-bot-v3',
    startedAt: 1792320148390,
    procStart: '134367937471987430',
    version: '2.1.302',
    kind: 'interactive',
    entrypoint: 'cli',
    name: 'trading-bot-v3-bd',
    nameSource: 'derived',
    status: 'shell',
    updatedAt: 1792323765882,
    ...over,
  })

test('parseClaudeRecord reads the measured format', () => {
  assert.deepEqual(parseClaudeRecord(real(), '270052.json'), {
    pid: 270052,
    sessionId: SID,
    cwd: 'C:\\projects\\trading-bot-v3',
    name: 'trading-bot-v3-bd',
    procStart: '134367937471987430',
    interactive: true,
    status: 'shell',
    updatedAtIso: new Date(1792323765882).toISOString(),
  })
})

test('parseClaudeRecord: headless runs are not interactive; odd fields read as unknown, not guessed', () => {
  assert.equal(parseClaudeRecord(real({ entrypoint: 'sdk-cli' }), '270052.json')?.interactive, false)
  assert.equal(parseClaudeRecord(real({ kind: 'background' }), '270052.json')?.interactive, false)
  const odd = parseClaudeRecord(real({ status: 'thinking', procStart: 12, updatedAt: 'soon', name: 7 }), '270052.json')
  assert.equal(odd?.status, 'unknown')
  assert.equal(odd?.procStart, null)
  assert.equal(odd?.updatedAtIso, null)
  assert.equal(odd?.name, '')
})

test('parseClaudeRecord: malformed records are unusable', () => {
  for (const [text, file] of [
    ['{ not json', '270052.json'],
    ['null', '270052.json'],
    [real(), '1.json'], // pid disagrees with the file name
    [real(), '270052.abc.key'],
    [real({ pid: '270052' }), '270052.json'],
    [real({ sessionId: 'not-a-uuid' }), '270052.json'],
    [real({ cwd: '' }), '270052.json'],
    [real({ cwd: undefined }), '270052.json'],
  ]) {
    assert.equal(parseClaudeRecord(text, file), null, `${file}: ${text}`)
  }
})

test('readClaudeProcesses: live pids only, never the .key files; an unreadable live record is counted; no folder is an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-'))
  try {
    fs.writeFileSync(path.join(dir, '100.json'), real({ pid: 100 }))
    fs.writeFileSync(path.join(dir, '100.0123abcd.key'), 'secret')
    fs.writeFileSync(path.join(dir, '200.json'), real({ pid: 200 })) // dead
    fs.writeFileSync(path.join(dir, '300.json'), '{"pid":30') // live, mid-write
    fs.writeFileSync(path.join(dir, '400.json'), real({ pid: 400, entrypoint: 'sdk-cli' }))
    const read = readClaudeProcesses(dir, (pid) => pid !== 200)
    assert.ok(read.ok)
    assert.deepEqual(read.processes.map((p) => [p.pid, p.interactive]), [[100, true], [400, false]])
    assert.match(read.error ?? '', /1 running Claude Code session record\(s\) couldn't be read/)

    fs.rmSync(path.join(dir, '300.json'))
    const clean = readClaudeProcesses(dir, () => true)
    assert.ok(clean.ok)
    assert.equal(clean.error, null)

    const missing = readClaudeProcesses(path.join(dir, 'nope'), () => true)
    assert.equal(missing.ok, false)
    assert.match(missing.ok ? '' : missing.error, /Couldn't read Claude Code's session records/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const projects: RegistryEntry[] = [
  { id: 'p1', name: 'Trading', path: 'C:\\projects\\trading-bot-v3', addedAt: '2026-10-18T00:00:00.000Z' },
  { id: 'sb', name: 'sandbox', path: 'C:\\projects\\claude-hub-sandbox', addedAt: '2026-10-18T00:00:00.000Z' },
]
const experiments = ['C:\\projects\\claude-hub-sandbox\\tiny-exp']

test('targetForCwd: exact folder, case- and slash-insensitive; experiments by path; anything else is unknown', () => {
  for (const cwd of ['C:\\projects\\trading-bot-v3', 'c:\\PROJECTS\\Trading-Bot-V3\\', 'C:/projects/trading-bot-v3']) {
    assert.deepEqual(targetForCwd(cwd, projects, experiments), { target: { kind: 'project', key: 'p1' }, name: 'Trading' }, cwd)
  }
  assert.deepEqual(targetForCwd('C:\\projects\\claude-hub-sandbox\\Tiny-Exp', projects, experiments), { target: { kind: 'experiment', key: 'tiny-exp' }, name: 'tiny-exp' })
  assert.deepEqual(targetForCwd('C:\\projects\\claude-hub-sandbox', projects, experiments)?.target, { kind: 'project', key: 'sb' })
  assert.equal(targetForCwd('C:\\projects\\trading-bot-v3\\src', projects, experiments), null)
  assert.equal(targetForCwd('C:\\projects\\claude-hub-sandbox\\other', projects, experiments), null)

  const parsed = parseClaudeRecord(real({ pid: 5, cwd: 'D:\\elsewhere' }), '5.json')!
  assert.deepEqual(toOutsideSession(parsed, projects, experiments), {
    pid: 5,
    sessionId: SID,
    name: 'trading-bot-v3-bd',
    cwd: 'D:\\elsewhere',
    target: null,
    targetName: null,
    status: 'shell',
    updatedAtIso: new Date(1792323765882).toISOString(),
  })
})

test('resolveTargetIn: registry id or enumerated experiment folder name, never a path', () => {
  assert.deepEqual(resolveTargetIn({ kind: 'project', key: 'p1' }, projects, experiments), { path: 'C:\\projects\\trading-bot-v3', name: 'Trading' })
  assert.deepEqual(resolveTargetIn({ kind: 'experiment', key: 'tiny-exp' }, projects, experiments), { path: experiments[0], name: 'tiny-exp' })
  assert.throws(() => resolveTargetIn({ kind: 'project', key: 'C:\\Windows' }, projects, experiments), /No registered project/)
  for (const key of ['C:\\projects\\claude-hub-sandbox\\tiny-exp', '..\\tiny-exp', 'Tiny-Exp']) {
    assert.throws(() => resolveTargetIn({ kind: 'experiment', key }, projects, experiments), /No sandbox experiment/, key)
  }
})

test('isClaudeWrapper: cmd /k or /c running claude, nothing else', () => {
  for (const line of [
    'cmd /k claude',
    'C:\\WINDOWS\\system32\\cmd.exe /c claude --resume x',
    '"C:\\WINDOWS\\system32\\cmd.exe" /d /c "claude.cmd"',
    'cmd.exe /c C:\\Users\\me\\AppData\\Local\\Temp\\x\\claude.exe C:\\x\\outside.mjs',
    'CMD /K "C:\\tools\\claude.exe"',
  ]) {
    assert.equal(isClaudeWrapper(line), true, line)
  }
  for (const line of ['cmd', 'cmd /k', 'cmd /k npm run dev', 'cmd /c claudette', 'powershell -c claude', 'cmd /k echo claude', '']) {
    assert.equal(isClaudeWrapper(line), false, line)
  }
})

const START = '134367937471987430'
const facts = (over: Partial<ProcessFacts> = {}): ProcessFacts => ({ pid: 42, name: 'claude.exe', created: START, parent: null, ...over })
const wrapper = (over: Partial<NonNullable<ProcessFacts['parent']>> = {}) => ({ pid: 41, name: 'cmd.exe', created: '134367937400000000', commandLine: 'cmd /k claude', ...over })
const decide = (over: Partial<Parameters<typeof decideTakeOver>[0]> = {}) =>
  decideTakeOver({ closeOld: true, status: 'idle', procStart: START, facts: facts(), factsError: null, ...over })

test('decideTakeOver closes only the verified, idle claude.exe; through its cmd wrapper when there is one', () => {
  assert.deepEqual(decide(), { close: true, killPid: 42, viaWrapper: false })
  // Within 2s of the record's start time is the same process.
  assert.deepEqual(decide({ facts: facts({ created: String(BigInt(START) + 19_000_000n) }) }), { close: true, killPid: 42, viaWrapper: false })
  assert.deepEqual(decide({ facts: facts({ name: 'CLAUDE.EXE', parent: wrapper() }) }), { close: true, killPid: 41, viaWrapper: true })
  // A parent that isn't a claude wrapper, or is younger than claude (its pid recycled), is left alone.
  assert.deepEqual(decide({ facts: facts({ parent: wrapper({ commandLine: 'cmd /k npm start' }) }) }), { close: true, killPid: 42, viaWrapper: false })
  assert.deepEqual(decide({ facts: facts({ parent: wrapper({ name: 'pwsh.exe' }) }) }), { close: true, killPid: 42, viaWrapper: false })
  assert.deepEqual(decide({ facts: facts({ parent: wrapper({ created: String(BigInt(START) + 1n) }) }) }), { close: true, killPid: 42, viaWrapper: false })
})

test('decideTakeOver forks, saying why, in every other case', () => {
  const cases: Array<[Partial<Parameters<typeof decideTakeOver>[0]>, RegExp]> = [
    [{ closeOld: false }, /chose to leave it running/],
    [{ status: 'busy' }, /^It was busy, so it's still running; the conversation continues here as a fork\.$/],
    [{ status: 'shell' }, /shell command/],
    [{ status: 'unknown' }, /state couldn't be read/],
    [{ facts: null, factsError: 'powershell failed' }, /Couldn't inspect the process \(powershell failed\)/],
    [{ facts: null }, /not found/],
    [{ facts: facts({ name: 'node.exe' }) }, /is node\.exe, not claude\.exe/],
    [{ facts: facts({ created: String(BigInt(START) + 21_000_000n) }) }, /didn't start when Claude Code's record says/],
    [{ facts: facts({ created: String(BigInt(START) - 21_000_000n) }) }, /didn't start when/],
    [{ procStart: null }, /didn't start when/],
  ]
  for (const [over, note] of cases) {
    const decision = decide(over)
    assert.equal(decision.close, false, JSON.stringify(over))
    assert.match(decision.close ? '' : decision.note, note)
    assert.match(decision.close ? '' : decision.note, /fork\.$/)
  }
})

test('parseProcessFacts: the query output, or null for no process', () => {
  assert.equal(parseProcessFacts('null\r\n', 7), null)
  assert.deepEqual(parseProcessFacts('{"name":"claude.exe","created":"1","parent":null}', 7), { pid: 7, name: 'claude.exe', created: '1', parent: null })
  assert.deepEqual(parseProcessFacts('{"name":"claude.exe","created":"5","parent":{"pid":3,"name":"cmd.exe","created":"4","commandLine":null}}', 7)?.parent, {
    pid: 3,
    name: 'cmd.exe',
    created: '4',
    commandLine: '',
  })
})

test('queryProcess reads a real process and its parent; a dead pid is null', { skip: process.platform !== 'win32' }, async () => {
  const self = await queryProcess(process.pid)
  assert.equal(self?.name.toLowerCase(), 'node.exe')
  assert.match(self?.created ?? '', /^\d{18}$/)
  // FILETIME of this process's start: within a minute of now, never after it.
  const nowFt = BigInt(Date.now() + 11_644_473_600_000) * 10_000n
  assert.ok(BigInt(self!.created) <= nowFt && nowFt - BigInt(self!.created) < 600_000_000n)
  assert.ok(self?.parent && self.parent.pid === process.ppid)
  const gone = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' })
  await new Promise((resolve) => gone.on('exit', resolve))
  assert.equal(await queryProcess(gone.pid!), null)
  await assert.rejects(queryProcess(1.5), /Not a process id/)
  await assert.rejects(queryProcess(-3), /Not a process id/)
})
