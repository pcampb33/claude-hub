// Integration: project-config against temp folders only. APP_ROOT (registry,
// boundaries.json), ~/.claude (CLAUDE_HUB_CLAUDE_HOME, with ~/.claude.json
// beside it) and the vault (CLAUDE_HUB_VAULT, read at import) all point into a
// temp dir, so no real project, settings file or transcript is touched. The
// sandbox experiments are the real ones, listed read-only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitize } from './status.ts'
import { rulePath } from './project-config-core.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-config-'))
const hub = path.join(root, 'hub')
const alpha = path.join(root, 'alpha')
const beta = path.join(root, 'beta proj')
const gamma = path.join(root, 'gamma')
const home = path.join(root, 'home', '.claude')
const vault = path.join(root, 'vault')
for (const d of [hub, alpha, beta, gamma, home, vault]) fs.mkdirSync(d, { recursive: true })
const entry = (id: string, name: string, p: string) => ({ id, name, path: p, addedAt: '2026-10-18T00:00:00.000Z' })
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify([entry('hub', 'hub', hub), entry('a', 'alpha', alpha), entry('b', 'beta proj', beta), entry('c', 'gamma', gamma)]))
// node --test runs each file in its own process, so these need no restoring.
process.env.APP_ROOT = hub
process.env.CLAUDE_HUB_CLAUDE_HOME = home
process.env.CLAUDE_HUB_VAULT = vault
const pc = await import('./project-config.ts')

const A = { kind: 'project' as const, key: 'a' }
const B = { kind: 'project' as const, key: 'b' }
const C = { kind: 'project' as const, key: 'c' }
const boundariesFile = path.join(hub, 'boundaries.json')
const localFile = path.join(alpha, '.claude', 'settings.local.json')

test.after(() => fs.rmSync(root, { recursive: true, force: true }))

test('boundaries: code defaults, round-trip through boundaries.json, validation, corrupt file refused', async () => {
  const fresh = await pc.getBoundary(A)
  assert.deepEqual(fresh.boundary, { target: A, tier: 'audit', neighbours: [], vaultAccess: 'read', isDefault: true, admin: false })
  assert.deepEqual(fresh.guard, { desktopLaunch: false, localSettings: 'absent', covers: 'Nothing is blocked; crossings are reported.' })
  assert.equal((await pc.getBoundary({ kind: 'project', key: 'hub' })).boundary.vaultAccess, 'write', 'the claude-hub repo maintains the vault')
  assert.equal(fs.existsSync(boundariesFile), false, 'reading writes nothing')

  const set = await pc.setBoundary(A, { tier: 'guarded', neighbours: [{ target: B, access: 'write' }, { target: B, access: 'read' }] })
  assert.deepEqual(set.boundary, { target: A, tier: 'guarded', neighbours: [{ target: B, access: 'read' }], vaultAccess: 'read', isDefault: false, admin: false })
  assert.equal(set.guard.desktopLaunch, true)
  assert.match(set.guard.covers, /shell commands aren't fenced on Windows/)
  assert.deepEqual(JSON.parse(fs.readFileSync(boundariesFile, 'utf-8')), { version: 1, targets: { 'project:a': { tier: 'guarded', neighbours: [{ target: B, access: 'read' }] } } })
  assert.deepEqual((await pc.getBoundary(A)).boundary, set.boundary)
  // A partial patch keeps the rest.
  assert.equal((await pc.setBoundary(A, { vaultAccess: 'write' })).boundary.neighbours.length, 1)

  await assert.rejects(pc.setBoundary(A, { neighbours: [{ target: A, access: 'read' }] }), /own neighbour/)
  await assert.rejects(pc.setBoundary(A, { neighbours: [{ target: { kind: 'project', key: 'nope' }, access: 'read' }] }), /No registered project/)
  await assert.rejects(pc.setBoundary({ kind: 'project', key: 'C:\\Windows' }, { tier: 'guarded' }), /No registered project/)
  await assert.rejects(pc.getBoundary({ kind: 'folder', key: 'x' } as never), /project or an experiment/)

  const before = fs.readFileSync(boundariesFile, 'utf-8')
  fs.writeFileSync(boundariesFile, '{ broken')
  await assert.rejects(pc.getBoundary(A), /boundaries\.json is unreadable/)
  await assert.rejects(pc.setBoundary(A, { tier: 'audit' }), /won't overwrite it/)
  assert.equal(fs.readFileSync(boundariesFile, 'utf-8'), '{ broken')
  fs.writeFileSync(boundariesFile, before)
})

test('admin: the claude-hub repo itself has no boundary; it cannot be given one, guarded or audited', async () => {
  const HUB = { kind: 'project' as const, key: 'hub' }
  const view = await pc.getBoundary(HUB)
  assert.equal(view.boundary.admin, true)
  assert.equal(view.guard.desktopLaunch, false)
  assert.match(view.guard.covers, /^No boundary: claude-hub administers every project/)
  await assert.rejects(pc.setBoundary(HUB, { tier: 'guarded' }), /administers every project/)
  await assert.rejects(pc.writeLocalGuard(HUB), /administers every project/)
  const audit = await pc.auditBoundary(HUB, 30)
  assert.deepEqual([audit.crossings.length, audit.sessionsScanned], [0, 0])
  assert.match(audit.error ?? '', /not audited/, 'no audit is said as a reason, never as zero crossings')
  const places = { projects: [{ id: 'hub', name: 'hub', path: hub }], experiments: [] } as unknown as Parameters<typeof pc.planBoundaryLaunch>[1]
  assert.deepEqual(pc.planBoundaryLaunch(HUB, places), { tier: 'admin', args: [], settings: null })
})

test('local guard: guarded only; merges into settings.local.json keeping user keys and rules; stale on change; remove takes only the hub rules; corrupt refused', async () => {
  await pc.setBoundary(A, { tier: 'audit', neighbours: [], vaultAccess: 'read' })
  await assert.rejects(pc.writeLocalGuard(A), /only for guarded/)

  fs.mkdirSync(path.dirname(localFile), { recursive: true })
  const user = { model: 'sonnet', enabledMcpjsonServers: ['ruflo'], permissions: { allow: ['Bash(npm test)'], deny: ['Read(./.env)', `Read(${rulePath(gamma)})`] } }
  fs.writeFileSync(localFile, JSON.stringify(user, null, 2))
  await pc.setBoundary(A, { tier: 'guarded', neighbours: [{ target: B, access: 'read' }] })
  // The user's own Read(<gamma>/**) is shaped like a hub rule, and with no
  // record the hub can't tell whose it is, so it doesn't claim "absent".
  assert.equal((await pc.getBoundary(A)).guard.localSettings, 'unrecorded')

  const written = await pc.writeLocalGuard(A)
  assert.equal(written.localSettings, 'current')
  const after = JSON.parse(fs.readFileSync(localFile, 'utf-8'))
  assert.equal(after.model, 'sonnet')
  assert.deepEqual(after.enabledMcpjsonServers, ['ruflo'])
  assert.deepEqual(after.permissions.allow, ['Bash(npm test)'])
  const deny: string[] = after.permissions.deny
  assert.deepEqual(deny.slice(0, 2), user.permissions.deny, 'user rules first and kept')
  for (const r of [`Edit(${rulePath(beta)})`, `Read(${rulePath(gamma)})`, `Edit(${rulePath(gamma)})`, `Read(${rulePath(hub)})`, `Edit(${rulePath(vault)})`]) assert.ok(deny.includes(r), r)
  assert.equal(deny.includes(`Read(${rulePath(beta)})`), false, 'read neighbour')
  const recorded: string[] = JSON.parse(fs.readFileSync(boundariesFile, 'utf-8')).targets['project:a'].localGuard.rules
  assert.equal(recorded.includes(`Read(${rulePath(gamma)})`), false, "the user's own identical rule isn't claimed by the hub")
  assert.deepEqual(new Set([...user.permissions.deny, ...recorded]), new Set(deny))

  // The boundary changes: beta becomes a write neighbour, so its Edit rule must go.
  await pc.setBoundary(A, { neighbours: [{ target: B, access: 'write' }] })
  assert.equal((await pc.getBoundary(A)).guard.localSettings, 'stale')
  assert.ok((await pc.getProjectConfig(A)).findings.some((f) => f.severity === 'warn' && f.text.startsWith("The hub's guard rules")))
  assert.equal((await pc.writeLocalGuard(A)).localSettings, 'current')
  assert.equal(JSON.parse(fs.readFileSync(localFile, 'utf-8')).permissions.deny.includes(`Edit(${rulePath(beta)})`), false)

  const removed = await pc.removeLocalGuard(A)
  assert.equal(removed.localSettings, 'unrecorded', "the user's own hub-shaped rule is still there")
  assert.deepEqual(JSON.parse(fs.readFileSync(localFile, 'utf-8')), user, 'exactly the user file again')
  assert.equal(JSON.parse(fs.readFileSync(boundariesFile, 'utf-8')).targets['project:a'].localGuard, undefined)

  // Unreadable settings.local.json: reported, never overwritten.
  fs.writeFileSync(localFile, '{ "permissions": ')
  assert.equal((await pc.getBoundary(A)).guard.localSettings, 'unreadable')
  await assert.rejects(pc.writeLocalGuard(A), /won't overwrite it/)
  assert.equal(fs.readFileSync(localFile, 'utf-8'), '{ "permissions": ')

  // No .claude folder yet: created (the project folder itself never is).
  await pc.setBoundary(C, { tier: 'guarded' })
  assert.equal((await pc.writeLocalGuard(C)).localSettings, 'current')
  assert.ok(fs.existsSync(path.join(gamma, '.claude', 'settings.local.json')))
  fs.rmSync(path.join(alpha, '.claude'), { recursive: true, force: true })
  fs.rmSync(path.join(gamma, '.claude'), { recursive: true, force: true })
  fs.rmSync(boundariesFile)
})

test('project config: three layers, names and redacted targets only, the ruflo finding, a broken settings file is an error not an absence', async () => {
  const SECRET = 'sk-live-SECRET-VALUE'
  fs.writeFileSync(
    path.join(home, 'settings.json'),
    JSON.stringify({
      model: 'opus',
      permissions: { defaultMode: 'auto', allow: ['Read'], ask: [] },
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: `node "C:/x/scripts/curate-session.mjs" --token ${SECRET}` }] }] },
      env: { API_KEY: SECRET },
    }),
  )
  fs.writeFileSync(path.join(home, 'CLAUDE.md'), '# Global\n\nBe brief.\n')
  fs.mkdirSync(path.join(home, 'skills', 'review'), { recursive: true })
  fs.writeFileSync(path.join(home, 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\n')
  fs.writeFileSync(
    path.join(path.dirname(home), '.claude.json'),
    JSON.stringify({
      oauthAccount: { accessToken: SECRET },
      mcpServers: { github: { command: 'npx', args: ['server', '--api-key', SECRET], env: { GITHUB_TOKEN: SECRET } } },
      projects: { [alpha.replace(/\\/g, '/')]: { mcpServers: { db: { url: `https://user:${SECRET}@db.example.com/?token=${SECRET}` } } } },
    }),
  )
  fs.mkdirSync(path.join(alpha, '.claude', 'agents'), { recursive: true })
  fs.mkdirSync(path.join(alpha, '.claude', 'commands', 'ops'), { recursive: true })
  fs.writeFileSync(path.join(alpha, 'CLAUDE.md'), '# Alpha\n')
  fs.writeFileSync(path.join(alpha, '.claude', 'agents', 'tester.md'), 'x')
  fs.writeFileSync(path.join(alpha, '.claude', 'commands', 'ops', 'deploy.md'), 'x')
  fs.writeFileSync(path.join(alpha, '.claude', 'settings.json'), '{ "model": ')
  fs.writeFileSync(localFile, JSON.stringify({ model: 'haiku', enabledMcpjsonServers: ['ruflo'], permissions: { allow: ['Bash(ls)'] } }))

  const report = await pc.getProjectConfig(A)
  assert.equal(report.error, null)
  assert.equal(JSON.stringify(report).includes('SECRET'), false, 'no env, token or secret-bearing arg reaches the renderer')
  const [g, p, l] = report.layers
  assert.deepEqual([g?.scope, p?.scope, l?.scope], ['global', 'project', 'local'])
  assert.equal(g?.model, 'opus')
  assert.deepEqual(g?.hooks, [{ event: 'SessionEnd', command: 'node curate-session.mjs …' }])
  assert.deepEqual(g?.mcpServers, [{ name: 'github', target: 'npx server --api-key …', enabled: null }])
  assert.deepEqual(g?.skills, ['review'])
  assert.ok((g?.claudeMdTokens ?? 0) > 0)
  assert.equal(g?.files.find((f) => f.label === '~/.claude/agents')?.exists, false)
  // The broken project settings: an error on that file, and a warning, never "no settings".
  const broken = p?.files.find((f) => f.label === '.claude/settings.json')
  assert.deepEqual([broken?.exists, broken?.error], [true, "it isn't valid JSON"])
  assert.equal(p?.permissions, null)
  assert.deepEqual(p?.agents, ['tester'])
  assert.deepEqual(p?.commands, ['ops:deploy'])
  assert.equal(l?.model, 'haiku')
  assert.deepEqual(l?.mcpServers, [{ name: 'db', target: 'https://…@db.example.com/?…', enabled: null }])
  const texts = report.findings.map((f) => `${f.severity}:${f.layer}:${f.text}`)
  assert.ok(texts.includes("warn:local:settings.local.json enables MCP server 'ruflo', but there's no .mcp.json"), texts.join('\n'))
  assert.ok(texts.some((t) => t.startsWith("warn:project:.claude/settings.json couldn't be used")))
  assert.ok(texts.includes("info:local:settings.local.json sets model 'haiku', overriding 'opus' from the global settings"))
  assert.ok(texts.some((t) => t.includes("default mode is 'auto'")))

  // With a .mcp.json that defines it, the server shows as enabled and the warning goes.
  fs.writeFileSync(path.join(alpha, '.mcp.json'), JSON.stringify({ mcpServers: { ruflo: { command: 'npx', args: ['ruflo@latest', 'mcp'] } } }))
  const fixed = await pc.getProjectConfig(A)
  assert.deepEqual(fixed.layers[1]?.mcpServers, [{ name: 'ruflo', target: 'npx ruflo@latest mcp', enabled: true }])
  assert.equal(fixed.findings.some((f) => f.text.includes('ruflo')), false)

  const missing = await pc.getProjectConfig({ kind: 'project', key: 'gone' })
  assert.match(missing.error ?? '', /No registered project/)
  fs.rmSync(path.join(alpha, '.claude'), { recursive: true, force: true })
  for (const f of ['CLAUDE.md', '.mcp.json']) fs.rmSync(path.join(alpha, f))
})

test('audit: interactive sessions in the folder (and its subfolders, and their subagents) within the window; headless and old skipped; unclassifiable folders counted', async () => {
  const projects = path.join(home, 'projects')
  const now = Date.now()
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
  const line = (o: object) => JSON.stringify(o) + '\n'
  const user = (cwd: string, entrypoint = 'cli') => line({ type: 'user', cwd, entrypoint, timestamp: at(100), message: { role: 'user', content: 'hi' } })
  const tools = (cwd: string, minutesAgo: number, uses: object[]) =>
    line({ type: 'assistant', cwd, timestamp: at(minutesAgo), message: { content: uses.map((input, i) => ({ type: 'tool_use', id: `t${i}`, ...input })) } })
  const write = (dir: string, file: string, text: string) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, file), text)
  }
  const own = path.join(projects, sanitize(alpha))
  write(
    own,
    's1.jsonl',
    user(alpha) +
      tools(alpha, 60 * 24 * 40, [{ name: 'Read', input: { file_path: path.join(beta, 'old.md') } }]) +
      tools(alpha, 50, [
        { name: 'Read', input: { file_path: path.join(beta, 'x.md') } },
        { name: 'Read', input: { file_path: 'notes.md' } },
        { name: 'Write', input: { file_path: path.join(home, 'plans', 'p.md') } },
        { name: 'Read', input: { file_path: path.join(vault, 'n.md') } },
      ]) +
      tools(alpha, 40, [
        { name: 'Edit', input: { file_path: path.join(beta, 'y.md') } },
        { name: 'Bash', input: { command: `ls "${gamma.replace(/\\/g, '/')}"` } },
        { name: 'Edit', input: { file_path: path.join(vault, 'n.md') } },
      ]) +
      // Refused calls: a deny rule and a user rejection. They didn't run, so they're blocked, not crossings.
      tools(alpha, 35, [
        { id: 'deny1', name: 'Read', input: { file_path: path.join(beta, 'secret.md') } },
        { id: 'deny2', name: 'Edit', input: { file_path: path.join(gamma, 'g.md') } },
      ]) +
      line({
        type: 'user',
        cwd: alpha,
        timestamp: at(35),
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'deny1', is_error: true, content: `Permission to read ${path.join(beta, 'secret.md')} has been denied.` },
            { type: 'tool_result', tool_use_id: 'deny2', is_error: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected." },
          ],
        },
      }),
  )
  write(path.join(own, 's1', 'subagents'), 'agent-x1.jsonl', tools(alpha, 30, [{ name: 'Grep', input: { pattern: 'x', path: gamma } }]))
  write(own, 'h1.jsonl', user(alpha, 'sdk-cli') + tools(alpha, 20, [{ name: 'Read', input: { file_path: path.join(beta, 'z.md') } }]))
  write(path.join(projects, sanitize(path.join(alpha, 'sub'))), 's2.jsonl', user(path.join(alpha, 'sub')) + tools(path.join(alpha, 'sub'), 10, [{ name: 'Read', input: { file_path: path.join(beta, 'w.md') } }]))
  write(path.join(projects, `${sanitize(alpha)}-mystery`), 'u1.jsonl', line({ type: 'summary', summary: 'no cwd here' }))
  write(path.join(projects, sanitize(beta)), 'b1.jsonl', user(beta) + tools(beta, 5, [{ name: 'Read', input: { file_path: path.join(alpha, 'a.md') } }]))

  const audit = await pc.auditBoundary(A, 30)
  assert.equal(audit.error, null)
  assert.deepEqual([audit.sessionsScanned, audit.sessionsUnreadable, audit.total, audit.blocked], [2, 1, 6, 2])
  assert.deepEqual(
    audit.crossings.map((c) => [c.sessionId, c.tool, c.access, c.into]),
    [
      ['s2', 'Read', 'read', 'beta proj'],
      ['s1', 'Grep', 'read', 'gamma'],
      ['s1', 'Edit', 'write', 'beta proj'],
      ['s1', 'Bash', 'shell', 'gamma'],
      ['s1', 'Edit', 'write', 'vault'],
      ['s1', 'Read', 'read', 'beta proj'],
    ],
  )
  assert.equal(audit.crossings[0]?.detail, path.join(beta, 'w.md'))
  assert.ok(Date.parse(audit.sinceIso) < now - 29 * 86_400_000)

  // A write neighbour and a writable vault are inside the boundary.
  await pc.setBoundary(A, { neighbours: [{ target: B, access: 'write' }], vaultAccess: 'write' })
  assert.deepEqual((await pc.auditBoundary(A, 30)).crossings.map((c) => c.into), ['gamma', 'gamma'])
  fs.rmSync(boundariesFile)
  await assert.rejects(pc.auditBoundary(A, 0), /Days must be/)
  assert.match((await pc.auditBoundary({ kind: 'project', key: 'gone' }, 30)).error ?? '', /No registered project/)
})
