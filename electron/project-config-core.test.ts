import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COVERS,
  boundaryStatement,
  classifyFact,
  configFindings,
  defaultVaultAccess,
  extractFacts,
  guardRules,
  isWriteish,
  localGuardState,
  mcpjsonApproval,
  mergeGuardRules,
  parseBoundaries,
  parseSettingsObject,
  readHooks,
  redactHookCommand,
  refusedToolUseIds,
  removeGuardRules,
  rulePath,
  validatePatch,
  type AuditContext,
  type FindingsInput,
  type Place,
  type ToolFact,
} from './project-config-core.ts'
import type { ConfigLayer } from '../shared/ipc-types.ts'

const SANDBOX = 'C:\\projects\\claude-hub-sandbox'
const VAULT = 'C:\\projects\\claude-hub-vault'
const place = (name: string, p: string, kind: Place['kind'] = 'project'): Place => ({ kind, key: kind === 'project' ? `id-${name}` : name, name, path: p })
const PLACES: Place[] = [
  place('trading-bot', 'C:\\projects\\trading-bot'),
  place('trading-bot-v2', 'C:\\projects\\trading-bot-v2'),
  place('trading-bot-v3', 'C:\\projects\\trading-bot-v3'),
  place('sandbox', SANDBOX),
  place('Stock Trading', `${SANDBOX}\\Stock Trading`, 'experiment'),
  place('delta 8', `${SANDBOX}\\delta 8`, 'experiment'),
  place('Rational', 'C:\\Users\\me\\Desktop\\claude projects\\Rational'),
]
const PROTECTED = ['C:\\Users\\me\\.claude', 'C:\\Users\\me\\AppData\\Local\\Temp']
const rules = (folder: string, extra: Partial<Parameters<typeof guardRules>[0]> = {}) =>
  guardRules({ folder, places: PLACES, neighbours: [], vault: VAULT, vaultAccess: 'read', protectedDirs: PROTECTED, ...extra })
const all3 = (p: string) => ['Read', 'Edit', 'NotebookEdit'].map((t) => `${t}(${rulePath(p)})`)

test('rulePath writes Windows folders in the POSIX, root-anchored form Claude Code matches', () => {
  assert.equal(rulePath('C:\\projects\\trading-bot-v2'), '//c/projects/trading-bot-v2/**')
  assert.equal(rulePath('C:\\projects\\trading-bot-v2\\'), '//c/projects/trading-bot-v2/**')
  assert.equal(rulePath('D:/work/x'), '//d/work/x/**')
  assert.equal(rulePath('C:\\Users\\me\\Desktop\\claude projects\\Rational'), '//c/Users/me/Desktop/claude projects/Rational/**')
})

test('guard rules: other projects fully denied; own folder open; a parent rule covers its children', () => {
  const r = rules('C:\\projects\\trading-bot-v3')
  for (const p of ['C:\\projects\\trading-bot', 'C:\\projects\\trading-bot-v2', SANDBOX]) for (const x of all3(p)) assert.ok(r.includes(x), x)
  assert.equal(r.some((x) => x.includes('trading-bot-v3')), false)
  // The sandbox root's rules already cover its experiments.
  assert.equal(r.some((x) => x.includes('Stock Trading')), false)
  // Read-only vault: no edits, reads allowed.
  assert.ok(r.includes(`Edit(${rulePath(VAULT)})`) && r.includes(`NotebookEdit(${rulePath(VAULT)})`))
  assert.equal(r.includes(`Read(${rulePath(VAULT)})`), false)
  assert.equal(rules('C:\\projects\\trading-bot-v3', { vaultAccess: 'write' }).some((x) => x.includes('claude-hub-vault')), false)
})

test("guard rules: an experiment's ancestor (the sandbox root) is never denied, its siblings are", () => {
  const r = rules(`${SANDBOX}\\Stock Trading`)
  assert.equal(r.some((x) => x === `Read(${rulePath(SANDBOX)})` || x === `Edit(${rulePath(SANDBOX)})`), false, 'denying the root would deny the session its own cwd')
  for (const x of all3(`${SANDBOX}\\delta 8`)) assert.ok(r.includes(x), x)
  assert.equal(r.some((x) => x.includes('Stock Trading')), false)
})

test('guard rules: read neighbour loses edits only; write neighbour is open; a folder holding a neighbour is denied no more than it allows', () => {
  const v3 = 'C:\\projects\\trading-bot-v3'
  const read = rules(v3, { neighbours: [{ name: 'trading-bot-v2', path: 'C:\\projects\\trading-bot-v2', access: 'read' }] })
  assert.ok(read.includes(`Edit(${rulePath('C:\\projects\\trading-bot-v2')})`))
  assert.equal(read.includes(`Read(${rulePath('C:\\projects\\trading-bot-v2')})`), false)
  const write = rules(v3, { neighbours: [{ name: 'trading-bot-v2', path: 'C:\\projects\\trading-bot-v2', access: 'write' }] })
  assert.equal(write.some((x) => x.includes('trading-bot-v2')), false)
  // An experiment as write neighbour: the sandbox root can't be denied (deny wins), the other experiments are.
  const exp = rules(v3, { neighbours: [{ name: 'delta 8', path: `${SANDBOX}\\delta 8`, access: 'write' }] })
  assert.equal(exp.some((x) => x.endsWith(`(${rulePath(SANDBOX)})`)), false)
  for (const x of all3(`${SANDBOX}\\Stock Trading`)) assert.ok(exp.includes(x), x)
})

test('guard rules: a place inside the own folder or an allowed neighbour is denied no more than its nearest allowed folder', () => {
  const tb3 = 'C:\\projects\\trading-bot-v3'
  const exps = [`${SANDBOX}\\Stock Trading`, `${SANDBOX}\\delta 8`]
  // The sandbox project guarded: its own experiments are inside its boundary.
  assert.equal(rules(SANDBOX).some((x) => x.includes('claude-hub-sandbox')), false)
  const sandbox = (access: 'read' | 'write') => ({ name: 'sandbox', path: SANDBOX, access })
  // The sandbox as a write neighbour: its experiments are open too.
  assert.equal(rules(tb3, { neighbours: [sandbox('write')] }).some((x) => x.includes('claude-hub-sandbox')), false)
  // As a read neighbour: its experiments lose edits only (the root's rules cover them).
  const read = rules(tb3, { neighbours: [sandbox('read')] })
  for (const p of exps) assert.equal(read.includes(`Read(${rulePath(p)})`), false, p)
  assert.ok(read.includes(`Edit(${rulePath(SANDBOX)})`))
  // An experiment's own narrower declaration wins over its folder's.
  const mixed = rules(tb3, { neighbours: [sandbox('write'), { name: 'delta 8', path: exps[1], access: 'read' }] })
  assert.deepEqual(mixed.filter((x) => x.includes('claude-hub-sandbox')), [`Edit(${rulePath(exps[1])})`, `NotebookEdit(${rulePath(exps[1])})`])
})

test('guard rules never deny ~/.claude or the temp dir, even via a project registered above them', () => {
  const r = guardRules({ folder: 'C:\\projects\\a', places: [place('home', 'C:\\Users\\me'), place('a', 'C:\\projects\\a')], neighbours: [], vault: VAULT, vaultAccess: 'read', protectedDirs: PROTECTED })
  assert.equal(r.some((x) => x.includes('/Users/me')), false)
})

test('the vault defaults to write only for the claude-hub repo itself', () => {
  assert.equal(defaultVaultAccess('C:\\projects\\claude-hub', 'C:\\projects\\claude-hub\\'), 'write')
  assert.equal(defaultVaultAccess('C:\\projects\\trading-bot', 'C:\\projects\\claude-hub'), 'read')
  assert.equal(defaultVaultAccess('C:\\projects\\claude-hub', undefined), 'read')
})

test('boundary statement: plain words per tier, neighbours with access, vault, no quotes, capped', () => {
  const base = { name: 'trading-bot-v3', folder: 'C:\\projects\\trading-bot-v3', vault: VAULT }
  const audit = boundaryStatement({ ...base, tier: 'audit', neighbours: [], vaultAccess: 'read' })
  assert.match(audit, /belongs to trading-bot-v3 at C:\\projects\\trading-bot-v3\./)
  assert.match(audit, /no neighbour projects/)
  assert.match(audit, /read the knowledge vault at C:\\projects\\claude-hub-vault but not change it/)
  assert.match(audit, /Stay within these folders; crossings are logged\.$/)
  const guarded = boundaryStatement({ ...base, tier: 'guarded', neighbours: [{ name: 'trading-bot-v2', path: 'C:\\projects\\trading-bot-v2', access: 'write' }, { name: 'x"y', path: 'C:\\x', access: 'read' }], vaultAccess: 'write' })
  assert.match(guarded, /trading-bot-v2 at C:\\projects\\trading-bot-v2 \(read and write\); x y at C:\\x \(read only\)/)
  assert.match(guarded, /read and write the knowledge vault/)
  assert.match(guarded, /Claude's file tools are blocked from other projects; don't use shell commands to reach them either\.$/)
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `neighbour-${i}`, path: `C:\\some\\long\\folder\\path\\neighbour-${i}`, access: 'read' as const }))
  const capped = boundaryStatement({ ...base, tier: 'guarded', neighbours: many, vaultAccess: 'read' })
  assert.ok(capped.length <= 1000, String(capped.length))
  assert.equal(capped.includes('"'), false)
  assert.equal(COVERS.audit, 'Nothing is blocked; crossings are reported.')
  assert.match(COVERS.guarded, /file tools are blocked outside this boundary; shell commands aren't fenced on Windows/)
})

test('validatePatch: tiers, access, neighbours resolve, no self-neighbour, deduped', () => {
  const where: Record<string, string> = { 'project:a': 'C:\\a', 'project:b': 'C:\\b', 'experiment:e': 'C:\\s\\e' }
  const resolves = (t: { kind: string; key: string }) => {
    const p = where[`${t.kind}:${t.key}`]
    if (!p) throw new Error(`No registered project with id "${t.key}"`)
    return p
  }
  const a = { kind: 'project' as const, key: 'a' }
  assert.deepEqual(validatePatch(a, { tier: 'guarded', vaultAccess: 'write' }, resolves), { tier: 'guarded', vaultAccess: 'write' })
  assert.throws(() => validatePatch(a, { tier: 'locked' }, resolves), /Tier must be/)
  assert.throws(() => validatePatch(a, { vaultAccess: 'all' }, resolves), /Vault access/)
  assert.throws(() => validatePatch(a, null, resolves), /must be an object/)
  assert.throws(() => validatePatch(a, { neighbours: [{ target: a, access: 'read' }] }, resolves), /own neighbour/)
  assert.throws(() => validatePatch(a, { neighbours: [{ target: { kind: 'project', key: 'zz' }, access: 'read' }] }, resolves), /No registered project/)
  assert.throws(() => validatePatch(a, { neighbours: [{ target: { kind: 'project', key: 'b' }, access: 'admin' }] }, resolves), /access must be/)
  assert.throws(() => validatePatch(a, { neighbours: [{ target: 'C:\\b', access: 'read' }] }, resolves), /project or an experiment/)
  const b = { kind: 'project' as const, key: 'b' }
  const e = { kind: 'experiment' as const, key: 'e' }
  assert.deepEqual(validatePatch(a, { neighbours: [{ target: b, access: 'read' }, { target: e, access: 'read' }, { target: { ...b, extra: 1 }, access: 'write' }] }, resolves).neighbours, [
    { target: b, access: 'write' },
    { target: e, access: 'read' },
  ])
})

test('parseBoundaries refuses anything malformed', () => {
  assert.deepEqual(parseBoundaries('{"version":1,"targets":{}}'), { version: 1, targets: {} })
  for (const bad of ['{ nope', '[]', '{"version":2,"targets":{}}', '{"version":1,"targets":{"project:a":{"tier":"x"}}}', '{"version":1,"targets":{"project:a":{"neighbours":[{"target":"C:\\\\x","access":"read"}]}}}', '{"version":1,"targets":{"project:a":{"localGuard":{"rules":[1]}}}}']) {
    assert.throws(() => parseBoundaries(bad), Error, bad)
  }
})

// ---- settings.local.json -------------------------------------------------------

test('mergeGuardRules keeps every other key and the user rules, and replaces only the hub’s previous rules', () => {
  const user = { model: 'sonnet', enabledMcpjsonServers: ['ruflo'], permissions: { allow: ['Bash(npm test)'], deny: ['Read(./.env)', 'Read(//c/x/**)'], defaultMode: 'acceptEdits' } }
  const first = mergeGuardRules(user, ['Read(//c/x/**)', 'Edit(//c/x/**)', 'Edit(//c/y/**)'], [])
  assert.deepEqual(first.settings, { ...user, permissions: { ...user.permissions, deny: ['Read(./.env)', 'Read(//c/x/**)', 'Edit(//c/x/**)', 'Edit(//c/y/**)'] } })
  assert.deepEqual(first.hubAdded, ['Edit(//c/x/**)', 'Edit(//c/y/**)'], "a rule the user already had stays theirs")
  // The boundary changed: y dropped, z added.
  const second = mergeGuardRules(first.settings, ['Read(//c/x/**)', 'Edit(//c/x/**)', 'Edit(//c/z/**)'], first.hubAdded)
  assert.deepEqual((second.settings.permissions as { deny: string[] }).deny, ['Read(./.env)', 'Read(//c/x/**)', 'Edit(//c/x/**)', 'Edit(//c/z/**)'])
  const removed = removeGuardRules(second.settings, second.hubAdded)
  assert.deepEqual(removed, user, 'remove leaves exactly the user file')
  assert.deepEqual(mergeGuardRules({}, ['Edit(//c/x/**)'], []).settings, { permissions: { deny: ['Edit(//c/x/**)'] } })
})

test('parseSettingsObject refuses files the hub must never overwrite', () => {
  assert.deepEqual(parseSettingsObject('\uFEFF{"a":1}'), { a: 1 })
  assert.throws(() => parseSettingsObject('{ "a": '), /valid JSON/)
  assert.throws(() => parseSettingsObject('[1]'), /JSON object/)
  assert.throws(() => parseSettingsObject('{"permissions":[]}'), /permissions entry/)
  assert.throws(() => parseSettingsObject('{"permissions":{"deny":"Read(x)"}}'), /permissions.deny/)
  // The error never quotes the file (it can hold tokens).
  assert.throws(() => parseSettingsObject('{"token":"sk-secret" oops}'), (err: Error) => !err.message.includes('sk-secret'))
})

test('localGuardState: absent / current / stale / unreadable', () => {
  const ok = (deny: string[]) => ({ kind: 'ok' as const, settings: { permissions: { deny } } })
  const rec = { rules: ['Edit(//c/x/**)'] }
  assert.equal(localGuardState({ kind: 'unreadable' }, rec, ['Edit(//c/x/**)']), 'unreadable')
  assert.equal(localGuardState({ kind: 'missing' }, rec, ['Edit(//c/x/**)']), 'absent')
  // No record (boundaries.json reset) but hub-shaped rules still in force: never "absent".
  assert.equal(localGuardState(ok(['Edit(//c/x/**)']), undefined, ['Edit(//c/x/**)']), 'unrecorded')
  assert.equal(localGuardState(ok(['Read(//c/y/**)']), undefined, null), 'unrecorded')
  assert.equal(localGuardState(ok(['Bash(rm:*)', 'Read(./.env)']), undefined, ['Edit(//c/x/**)']), 'absent')
  assert.equal(localGuardState({ kind: 'missing' }, undefined, ['Edit(//c/x/**)']), 'absent')
  assert.equal(localGuardState(ok(['Edit(//c/x/**)', 'Read(u)']), rec, ['Edit(//c/x/**)']), 'current')
  assert.equal(localGuardState(ok(['Edit(//c/x/**)']), rec, ['Edit(//c/x/**)', 'Edit(//c/y/**)']), 'stale')
  assert.equal(localGuardState(ok([]), rec, ['Edit(//c/x/**)']), 'stale')
  assert.equal(localGuardState(ok(['Edit(//c/x/**)']), rec, null), 'stale', 'hub rules left behind under the audit tier')
  assert.equal(localGuardState(ok([]), rec, null), 'absent')
})

// ---- Config ----------------------------------------------------------------------

test('hook commands show the script, never its arguments or folders', () => {
  assert.equal(redactHookCommand('node "C:/projects/claude-hub/scripts/curate-session.mjs"'), 'node curate-session.mjs')
  assert.equal(redactHookCommand('node C:/x/vault-recall.mjs --token abc123 C:\\secret\\dir'), 'node vault-recall.mjs …')
  assert.equal(redactHookCommand('C:\\tools\\notify.exe --key=SECRET'), 'notify …')
  assert.equal(redactHookCommand('powershell -File "C:\\Users\\me\\hooks\\stop.ps1"'), 'powershell stop.ps1')
  assert.deepEqual(readHooks({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node C:/a/b.mjs x' }] }], Custom: [{ hooks: [{ command: 'echo hi' }] }] } }), [
    { event: 'SessionEnd', command: 'node b.mjs …' },
    { event: 'Custom', command: 'echo …' },
  ])
})

test('mcpjsonApproval: local beats project; disabled beats enabled; enableAll', () => {
  assert.equal(mcpjsonApproval('ruflo', [{ enabledMcpjsonServers: ['ruflo'] }, null]), true)
  assert.equal(mcpjsonApproval('ruflo', [{ disabledMcpjsonServers: ['ruflo'] }, { enabledMcpjsonServers: ['ruflo'] }]), false)
  assert.equal(mcpjsonApproval('x', [null, { enableAllProjectMcpServers: true }]), true)
  assert.equal(mcpjsonApproval('x', [{}, {}]), null)
})

const layer = (scope: ConfigLayer['scope'], over: Partial<ConfigLayer> = {}): ConfigLayer => ({
  scope,
  files: [],
  claudeMdTokens: null,
  model: null,
  permissions: null,
  hooks: [],
  mcpServers: [],
  skills: [],
  agents: [],
  commands: [],
  workflows: [],
  ...over,
})

test('findings: the ruflo case, a server .mcp.json lacks, auto with no deny, local overrides, stale guard, unparseable settings', () => {
  const input = (over: Partial<FindingsInput>): FindingsInput => ({
    global: { settings: { model: 'opus', permissions: { defaultMode: 'auto', allow: [] } } },
    project: { settings: null },
    local: { settings: { enabledMcpjsonServers: ['ruflo'] } },
    mcpJson: null,
    layers: [layer('global', { permissions: { defaultMode: 'auto', allow: [], ask: [], deny: [] } }), layer('project'), layer('local')],
    guard: 'absent',
    ...over,
  })
  assert.deepEqual(configFindings(input({})), [
    { severity: 'warn', layer: 'local', text: "settings.local.json enables MCP server 'ruflo', but there's no .mcp.json" },
    { severity: 'info', layer: 'global', text: "The global default mode is 'auto' and no layer has a deny rule, so nothing is blocked outright" },
  ])
  const texts = (i: FindingsInput) => configFindings(i).map((f) => `${f.severity}:${f.text}`)
  assert.ok(texts(input({ mcpJson: ['other'] })).includes("warn:settings.local.json enables MCP server 'ruflo', but .mcp.json doesn't define it"))
  assert.equal(texts(input({ mcpJson: ['ruflo'] })).some((t) => t.includes('ruflo')), false)
  assert.equal(texts(input({ mcpJson: 'unreadable' })).some((t) => t.includes('ruflo')), false, 'no claim about a file nobody could read')
  const withDeny = input({ layers: [layer('global'), layer('project', { permissions: { defaultMode: null, allow: [], ask: [], deny: ['Read(.env)'] } }), layer('local')] })
  assert.equal(texts(withDeny).some((t) => t.includes("'auto'")), false)
  const overriding = input({ local: { settings: { model: 'haiku', permissions: { defaultMode: 'plan' } } } })
  assert.ok(texts(overriding).includes("info:settings.local.json sets model 'haiku', overriding 'opus' from the global settings"))
  assert.ok(texts(overriding).includes("info:settings.local.json sets defaultMode 'plan', overriding 'auto' from the global settings"))
  assert.ok(texts(input({ guard: 'stale' })).some((t) => t.startsWith("warn:The hub's guard rules")))
  const broken = input({
    layers: [
      layer('global', { files: [{ label: '~/.claude.json', path: 'C:\\h\\.claude.json', exists: true, error: "it isn't valid JSON" }] }),
      layer('project', { files: [{ label: '.claude/settings.json', path: 'C:\\p\\.claude\\settings.json', exists: true, error: "it isn't valid JSON" }] }),
      layer('local', { files: [{ label: "~/.claude.json (this folder's entry)", path: 'C:\\h\\.claude.json', exists: true, error: "it isn't valid JSON" }] }),
    ],
  })
  assert.equal(texts(broken).some((t) => t.includes('nothing is blocked')), false, 'an unreadable layer may hold deny rules')
  assert.ok(texts(broken).some((t) => t.startsWith("warn:The global default mode is 'auto'") && t.includes('unknown')))
  const parseWarnings = configFindings(broken).filter((f) => f.text.includes("couldn't be used"))
  assert.deepEqual(parseWarnings.map((f) => [f.layer, f.text]), [
    ['global', "~/.claude.json couldn't be used (it isn't valid JSON), so its settings aren't shown"],
    ['project', ".claude/settings.json couldn't be used (it isn't valid JSON), so its settings aren't shown"],
  ])
})

// ---- Audit -------------------------------------------------------------------------

const V3 = 'C:\\projects\\trading-bot-v3'
const ctx = (over: Partial<AuditContext> = {}): AuditContext => ({
  folder: V3,
  places: PLACES,
  neighbours: [],
  vault: VAULT,
  vaultAccess: 'read',
  zones: PROTECTED,
  home: 'C:\\Users\\me',
  ...over,
})
const fact = (tool: string, target: { path?: string; command?: string }, cwd: string | null = V3): ToolFact => ({ at: '2026-10-10T00:00:00.000Z', tool, cwd, ...target })
const into = (f: ToolFact, c: AuditContext = ctx()) => {
  const x = classifyFact(f, c)
  return x ? `${x.access}:${x.into}` : null
}

test('audit: file tools inside the boundary, in ~/.claude or temp, or reading the vault are not crossings', () => {
  assert.equal(into(fact('Read', { path: 'C:\\projects\\trading-bot-v3\\src\\a.py' })), null)
  assert.equal(into(fact('Edit', { path: 'src/a.py' })), null, 'relative to the cwd')
  assert.equal(into(fact('Read', { path: '/c/projects/trading-bot-v3/README.md' })), null, 'Git Bash spelling')
  assert.equal(into(fact('Write', { path: 'C:/Users/me/.claude/projects/x/memory/a.md' })), null)
  assert.equal(into(fact('Write', { path: '~/.claude/plans/p.md' })), null)
  assert.equal(into(fact('Write', { path: 'C:\\Users\\me\\AppData\\Local\\Temp\\claude\\scratch\\x.mjs' })), null)
  assert.equal(into(fact('Read', { path: 'C:\\projects\\claude-hub-vault\\note.md' })), null)
  assert.equal(into(fact('Edit', { path: 'C:\\projects\\claude-hub-vault\\note.md' }), ctx({ vaultAccess: 'write' })), null)
})

test('audit: file tools reaching other projects, a read-only vault, or elsewhere are crossings', () => {
  assert.equal(into(fact('Read', { path: 'C:\\projects\\trading-bot-v2\\bot.py' })), 'read:trading-bot-v2')
  assert.equal(into(fact('Edit', { path: '..\\trading-bot-v2\\bot.py' })), 'write:trading-bot-v2')
  assert.equal(into(fact('Grep', { path: 'C:/projects/trading-bot' })), 'read:trading-bot')
  assert.equal(into(fact('Edit', { path: 'C:\\projects\\claude-hub-vault\\note.md' })), 'write:vault')
  assert.equal(into(fact('Read', { path: 'D:\\data\\prices.csv' })), 'read:elsewhere')
  assert.equal(into(fact('Read', { path: `${SANDBOX}\\delta 8\\x.md` })), 'read:delta 8')
  // Neighbours per access.
  const readN = ctx({ neighbours: [{ name: 'trading-bot-v2', path: 'C:\\projects\\trading-bot-v2', access: 'read' }] })
  assert.equal(into(fact('Read', { path: 'C:\\projects\\trading-bot-v2\\bot.py' }), readN), null)
  assert.equal(into(fact('MultiEdit', { path: 'C:\\projects\\trading-bot-v2\\bot.py' }), readN), 'write:trading-bot-v2')
  const writeN = ctx({ neighbours: [{ name: 'trading-bot-v2', path: 'C:\\projects\\trading-bot-v2', access: 'write' }] })
  assert.equal(into(fact('Write', { path: 'C:\\projects\\trading-bot-v2\\bot.py' }), writeN), null)
  // An experiment session reaching its sandbox root is outside its boundary.
  const exp = ctx({ folder: `${SANDBOX}\\Stock Trading` })
  assert.equal(into(fact('Read', { path: `${SANDBOX}\\Stock Trading\\a.md` }, `${SANDBOX}\\Stock Trading`), exp), null)
  assert.equal(into(fact('Read', { path: `${SANDBOX}\\notes.md` }, `${SANDBOX}\\Stock Trading`), exp), 'read:sandbox')
})

test('audit: shell commands naming another project (not a longer sibling, not an ancestor) are crossings', () => {
  assert.equal(into(fact('Bash', { command: 'cd /c/projects/trading-bot-v2 && python bot.py' })), 'shell:trading-bot-v2')
  assert.equal(into(fact('PowerShell', { command: 'Get-Content "C:\\Projects\\Trading-Bot\\config.yaml"' })), 'shell:trading-bot')
  assert.equal(into(fact('Bash', { command: 'ls C:/projects/trading-bot-v3/src && git status' })), null, 'own folder: trading-bot is a prefix, not a match')
  assert.equal(into(fact('Bash', { command: 'python run.py --data ./trading-bot' })), null)
  assert.equal(into(fact('Bash', { command: `ls "${SANDBOX}\\Stock Trading"` }, `${SANDBOX}\\Stock Trading`), ctx({ folder: `${SANDBOX}\\Stock Trading` })), null, 'own path contains the ancestor')
  // Vault and read neighbours: only write-ish commands cross.
  assert.equal(into(fact('Bash', { command: 'cat C:/projects/claude-hub-vault/index.md' })), null)
  assert.equal(into(fact('Bash', { command: 'echo x > C:/projects/claude-hub-vault/new.md' })), 'shell:vault')
  assert.equal(into(fact('Bash', { command: 'echo x > C:/projects/claude-hub-vault/new.md' }), ctx({ vaultAccess: 'write' })), null)
  const readN = ctx({ neighbours: [{ name: 'trading-bot-v2', path: 'C:\\projects\\trading-bot-v2', access: 'read' }] })
  assert.equal(into(fact('Bash', { command: 'git -C C:/projects/trading-bot-v2 log 2>&1' }), readN), null)
  assert.equal(into(fact('Bash', { command: 'cp a.py C:/projects/trading-bot-v2/' }), readN), 'shell:trading-bot-v2')
  const writeN = ctx({ neighbours: [{ name: 'trading-bot-v2', path: 'C:\\projects\\trading-bot-v2', access: 'write' }] })
  assert.equal(into(fact('Bash', { command: 'rm -rf C:/projects/trading-bot-v2/tmp' }), writeN), null)
})

test('audit: a place inside the own folder, a neighbour or the vault belongs to the nearest of them', () => {
  const inExp = `${SANDBOX}\\delta 8\\a.txt`
  const sandbox = (access: 'read' | 'write') => ctx({ neighbours: [{ name: 'sandbox', path: SANDBOX, access }] })
  assert.equal(into(fact('Write', { path: inExp }), sandbox('write')), null)
  assert.equal(into(fact('Bash', { command: `rm "${inExp}"` }), sandbox('write')), null)
  assert.equal(into(fact('Read', { path: inExp }), sandbox('read')), null)
  assert.equal(into(fact('Bash', { command: `cat "${inExp}"` }), sandbox('read')), null)
  assert.equal(into(fact('Write', { path: inExp }), sandbox('read')), 'write:delta 8')
  assert.equal(into(fact('Bash', { command: `rm "${inExp}"` }), sandbox('read')), 'shell:delta 8')
  // The sandbox project's own sessions reaching its experiments.
  const own = ctx({ folder: SANDBOX })
  assert.equal(into(fact('Edit', { path: inExp }, SANDBOX), own), null)
  assert.equal(into(fact('Bash', { command: `rm "${inExp}"` }, SANDBOX), own), null)
  // An explicit declaration on the nested place still wins.
  const mixed = ctx({ neighbours: [{ name: 'sandbox', path: SANDBOX, access: 'write' }, { name: 'delta 8', path: `${SANDBOX}\\delta 8`, access: 'read' }] })
  assert.equal(into(fact('Write', { path: inExp }), mixed), 'write:delta 8')
  assert.equal(into(fact('Write', { path: `${SANDBOX}\\Stock Trading\\b.txt` }), mixed), null)
})

test('isWriteish ignores stderr/null redirects', () => {
  assert.equal(isWriteish('ls C:/x 2>&1'), false)
  assert.equal(isWriteish('ls C:/x 2>/dev/null'), false)
  assert.equal(isWriteish('cat C:/x | head > out.txt'), true)
  assert.equal(isWriteish('Remove-Item C:/x'), true)
  assert.equal(isWriteish('git -C C:/x commit -m y'), true)
})

test('extractFacts reads file-tool paths (and absolute Glob patterns) and shell commands from assistant lines', () => {
  const line = {
    type: 'assistant',
    timestamp: '2026-10-10T00:00:00.000Z',
    cwd: V3,
    message: {
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.py' } },
        { type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: 'C:/x/n.ipynb' } },
        { type: 'tool_use', name: 'Glob', input: { pattern: 'C:/projects/trading-bot-v2/**/*.py' } },
        { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.py' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', name: 'WebFetch', input: { url: 'https://x' } },
      ],
    },
  }
  assert.deepEqual(
    extractFacts(line).map((f) => [f.tool, f.path ?? f.command]),
    [
      ['Read', 'a.py'],
      ['NotebookEdit', 'C:/x/n.ipynb'],
      ['Glob', 'C:/projects/trading-bot-v2'],
      ['Bash', 'ls'],
    ],
  )
  assert.equal(extractFacts(line)[0]?.id, 'toolu_1', 'kept so the call can be paired with its result')
  assert.deepEqual(extractFacts({ type: 'user', message: { content: [] } }), [])
})

test('refusedToolUseIds: calls Claude Code refused to run (deny rule, classifier, safety check, user rejection, worktree isolation); other errors ran', () => {
  const result = (tool_use_id: string, content: unknown, is_error = true) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id, is_error, content }] } })
  const refused = [
    'Permission to read C:\\projects\\trading-bot-v2\\bot.py has been denied.',
    '<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>',
    'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [x].',
    'Permission for this command was denied by a built-in Claude Code safety check, not by the user.',
    "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing.",
    'This agent is isolated in the worktree C:\\x but this command runs outside it.',
  ]
  refused.forEach((text, i) => assert.deepEqual(refusedToolUseIds(result(`r${i}`, text)), [`r${i}`], text))
  assert.deepEqual(refusedToolUseIds(result('a', [{ type: 'text', text: refused[0] }])), ['a'], 'array content')
  // Errors from a call that ran, and successes that merely mention a denial, are not refusals.
  for (const text of ['Exit code 1\nls: cannot access x: Permission denied', 'File does not exist.', '<tool_use_error>File has not been read yet.</tool_use_error>']) {
    assert.deepEqual(refusedToolUseIds(result('e', text)), [], text)
  }
  assert.deepEqual(refusedToolUseIds(result('ok', refused[0], false)), [])
  assert.deepEqual(refusedToolUseIds({ type: 'api-request-blob', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', is_error: true, content: refused[0] }] } }), [])
})
