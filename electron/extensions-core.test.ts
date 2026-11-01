import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildItems,
  claudeJsonFacts,
  classifyServer,
  parseMcpList,
  parsePluginDetails,
  parsePluginList,
  parseTokens,
  redactTarget,
  type BuildInput,
} from './extensions-core.ts'
import { normalizeServerName } from './skill-usage.ts'

// Captured from `claude mcp list` (Claude Code 2.1.302) on 2026-10-17, plus
// two synthetic lines for states this machine didn't show.
const MCP_LIST = [
  'Checking MCP server health…',
  '',
  'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected',
  'plugin:design:slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication',
  'plugin:design:google calendar:  (HTTP) - - Not configured',
  'playwright: npx @playwright/mcp --browser chromium - ✔ Connected',
  'desktop-control: C:\\Users\\P_cam\\mcp-servers\\desktop-control\\.venv\\Scripts\\python.exe C:\\Users\\P_cam\\server.py - ✔ Connected',
  'ewm-config: C:\\Users\\P_cam\\mcp-servers\\ewm-config\\run-mcp.cmd  - ✔ Connected',
  'odd: node run.js --label "a - b" (stdio) - ✗ Failed to connect',
  'local-thing: .mcp.json server - ⏸ Pending approval',
  'weird: x - ? Sleeping',
].join('\r\n')

test('parseMcpList reads every line shape, splitting on the right ` - `', () => {
  const { entries, unparsed } = parseMcpList(MCP_LIST)
  assert.deepEqual(unparsed, [])
  const by = Object.fromEntries(entries.map((e) => [e.name, e]))
  assert.deepEqual(by['claude.ai Gmail'], {
    name: 'claude.ai Gmail',
    target: 'https://gmailmcp.googleapis.com/mcp/v1',
    status: 'connected',
    statusText: 'Connected',
  })
  assert.equal(by['plugin:design:slack'].status, 'needs-auth')
  assert.equal(by['plugin:design:slack'].target, 'https://mcp.slack.com/mcp')
  // The `-` glyph after a ` - ` must not be read as the separator.
  assert.deepEqual(by['plugin:design:google calendar'], {
    name: 'plugin:design:google calendar',
    target: null,
    status: 'not-configured',
    statusText: 'Not configured',
  })
  assert.equal(by['playwright'].target, 'npx @playwright/mcp --browser chromium')
  assert.match(by['desktop-control'].target!, /^C:\\Users\\.*server\.py$/)
  assert.equal(by['ewm-config'].target, 'C:\\Users\\P_cam\\mcp-servers\\ewm-config\\run-mcp.cmd')
  assert.equal(by['odd'].target, 'node run.js --label "a - b"')
  assert.equal(by['odd'].status, 'failed')
  assert.equal(by['local-thing'].status, 'pending-approval')
  // An unrecognised state keeps the CLI's words.
  assert.deepEqual([by['weird'].status, by['weird'].statusText], ['unknown', 'Sleeping'])
})

test('parseMcpList reports lines it cannot read instead of dropping them', () => {
  const { entries, unparsed } = parseMcpList('Checking MCP server health…\n\nsomething went sideways\n')
  assert.deepEqual(entries, [])
  assert.deepEqual(unparsed, ['something went sideways'])
  assert.deepEqual(parseMcpList('No MCP servers configured. Use `claude mcp add` to add a server.\n'), {
    entries: [],
    unparsed: [],
  })
})

test('classifyServer and normalizeServerName match transcript names', () => {
  assert.deepEqual(classifyServer('claude.ai Claude Docs'), { kind: 'connector', display: 'Claude Docs' })
  assert.deepEqual(classifyServer('plugin:design:google calendar'), { kind: 'plugin', plugin: 'design', server: 'google calendar' })
  assert.deepEqual(classifyServer('desktop-control'), { kind: 'plain' })
  assert.equal(normalizeServerName('claude.ai Vercel'), 'claude_ai_Vercel')
  assert.equal(normalizeServerName('plugin:design:slack'), 'plugin_design_slack')
  assert.equal(normalizeServerName('plugin:desktop-commander:desktop-commander'), 'plugin_desktop-commander_desktop-commander')
  assert.equal(normalizeServerName('desktop-control'), 'desktop-control')
})

const DETAILS = `engineering 1.2.0
  Description: Streamline engineering workflows.
  Source: engineering@synced

Component inventory
  Skills (3)  architecture, code-review, debug
  Agents (1)  helper
  Hooks (0)
  MCP servers (3)  slack, google calendar, gmail  (tool schemas resolved at runtime; not counted)
  LSP servers (0)

Projected token cost
  Always-on:   ~1,576 tok   added to every session

Per-component (rounded)
  component          always-on  on-invoke
  architecture            ~100       ~730
  code-review              ~90      ~1.2k
  debug                    ~90        ~3k
  helper                   ~80        ~1k

  On-invoke cost is paid each time a skill or agent fires.
`

test('parsePluginDetails reads always-on cost, components and bundled servers', () => {
  const d = parsePluginDetails(DETAILS.replace(/\n/g, '\r\n'))
  assert.equal(d.alwaysOnTokens, 1576)
  assert.deepEqual(d.mcpServers, ['slack', 'google calendar', 'gmail'])
  assert.deepEqual(d.components, [
    { name: 'architecture', kind: 'skill', alwaysOnTokens: 100, onInvokeTokens: 730 },
    { name: 'code-review', kind: 'skill', alwaysOnTokens: 90, onInvokeTokens: 1200 },
    { name: 'debug', kind: 'skill', alwaysOnTokens: 90, onInvokeTokens: 3000 },
    { name: 'helper', kind: 'agent', alwaysOnTokens: 80, onInvokeTokens: 1000 },
  ])
})

test('parsePluginDetails reports null, not zero, when the cost is missing', () => {
  const d = parsePluginDetails('cowork 0.2.2\n\nComponent inventory\n  MCP servers (0)\n')
  assert.equal(d.alwaysOnTokens, null)
  assert.deepEqual(d.components, [])
  assert.deepEqual(d.mcpServers, [])
  assert.equal(parseTokens('~873'), 873)
  assert.equal(parseTokens('~1.2k'), 1200)
  assert.equal(parseTokens('—'), null)
})

test('parsePluginList collapses per-project duplicates into one plugin', () => {
  const list = parsePluginList(
    JSON.stringify([
      { id: 'frontend-design@claude-plugins-official', version: 'unknown', scope: 'project', enabled: false, projectPath: 'C:\\a' },
      { id: 'frontend-design@claude-plugins-official', version: 'unknown', scope: 'project', enabled: true, projectPath: 'C:\\b' },
      { id: 'design@synced', version: '1.2.0', scope: 'synced', enabled: true, installPath: 'x' },
    ]),
  )
  assert.deepEqual(list, [
    { id: 'frontend-design@claude-plugins-official', name: 'frontend-design', version: 'unknown', scope: 'project', enabled: true, projectPaths: ['C:\\a', 'C:\\b'] },
    { id: 'design@synced', name: 'design', version: '1.2.0', scope: 'synced', enabled: true, projectPaths: [] },
  ])
  assert.throws(() => parsePluginList('{}'))
})

test('claudeJsonFacts keeps names and targets and never reads env', () => {
  const facts = claudeJsonFacts({
    mcpServers: { secret: { type: 'stdio', command: 'run.cmd', args: ['--x'], env: { TOKEN: 'hunter2' } } },
    projects: { 'C:/p': { mcpServers: { docs: { type: 'http', url: 'https://d', headers: { Authorization: 'k' } } } } },
    claudeAiMcpEverConnected: ['claude.ai Stripe', 7],
  })
  assert.deepEqual(facts, {
    userServers: [{ name: 'secret', target: 'run.cmd --x', projectPath: null }],
    localServers: [{ name: 'docs', target: 'https://d', projectPath: 'C:/p' }],
    everConnected: ['claude.ai Stripe'],
  })
  assert.doesNotMatch(JSON.stringify(facts), /hunter2|Authorization/)
})

function input(over: Partial<BuildInput> = {}): BuildInput {
  return {
    plugins: [
      { id: 'design@synced', name: 'design', version: '1.2.0', scope: 'synced', enabled: true, projectPaths: [] },
      { id: 'engineering@synced', name: 'engineering', version: '1.2.0', scope: 'synced', enabled: true, projectPaths: [] },
    ],
    details: new Map([
      ['design@synced', { alwaysOnTokens: 619, components: [], mcpServers: ['slack', 'asana'] }],
      ['engineering@synced', { alwaysOnTokens: 873, components: [], mcpServers: ['slack', 'github'] }],
    ]),
    config: {
      userServers: [{ name: 'playwright', target: 'npx @playwright/mcp', projectPath: null }],
      localServers: [{ name: 'svgmaker', target: 'npx svgmaker', projectPath: 'C:/b' }],
      everConnected: ['claude.ai Gmail', 'claude.ai Stripe'],
    },
    health: { entries: parseMcpList(MCP_LIST).entries, current: true },
    usage: {
      mcp: new Map([['playwright', { calls: 12, lastUsedIso: '2026-10-17T00:00:00Z', topTools: [{ tool: 'browser_click', count: 12 }] }]]),
      skills: new Map([['design:ux-copy', { calls: 2, lastUsedIso: '2026-10-16T00:00:00Z', topTools: [] }]]),
    },
    ...over,
  }
}

const byId = (items: ReturnType<typeof buildItems>) => Object.fromEntries(items.map((i) => [i.id, i]))

test('buildItems: a successful check grades servers; history-only connectors are not-listed', () => {
  const items = byId(buildItems(input()))
  assert.equal(items['mcp:playwright'].status, 'connected')
  assert.equal(items['mcp:playwright'].usage?.calls, 12)
  assert.equal(items['mcp:plugin:design:slack'].pluginId, 'design@synced')
  assert.equal(items['mcp:plugin:design:slack'].usage?.calls, 0, 'scanned and never called is 0, not null')
  assert.equal(items['connector:claude.ai Gmail'].status, 'connected')
  assert.equal(items['connector:claude.ai Stripe'].status, 'not-listed')
  // In a plugin's inventory but listed by no check: not-listed, once.
  assert.equal(items['mcp:plugin:design:asana'].status, 'not-listed')
  assert.equal(items['mcp:plugin:engineering:github'].status, 'not-listed')
  assert.equal(items['mcp:plugin:engineering:slack'], undefined, 'shared server is listed under its first plugin only')
  assert.equal(items['mcp:local:C:/b:svgmaker'].status, 'unchecked')
  assert.equal(items['plugin:design@synced'].status, 'enabled')
  assert.equal(items['plugin:design@synced'].alwaysOnTokens, 619)
  assert.deepEqual(items['plugin:design@synced'].usage, {
    calls: 2,
    lastUsedIso: '2026-10-16T00:00:00Z',
    topTools: [{ tool: 'ux-copy', count: 2 }],
  })
})

test('buildItems: a failed check leaves every server and connector unchecked, never not-configured', () => {
  const items = buildItems(input({ health: { entries: parseMcpList(MCP_LIST).entries, current: false } }))
  for (const i of items.filter((x) => x.kind !== 'plugin')) assert.equal(i.status, 'unchecked', i.id)
  const none = buildItems(input({ health: { entries: null, current: true } }))
  for (const i of none.filter((x) => x.kind !== 'plugin')) assert.equal(i.status, 'unchecked', i.id)
  // With no check ever, plugin servers still appear from the inventory.
  assert.ok(byId(none)['mcp:plugin:design:slack'])
})

test('buildItems: an unreadable usage scan is null usage, and a details failure is surfaced', () => {
  const items = byId(
    buildItems(input({ usage: null, details: new Map([['design@synced', new Error('timed out')]]) })),
  )
  assert.equal(items['mcp:playwright'].usage, null)
  assert.equal(items['plugin:design@synced'].usage, null)
  assert.equal(items['plugin:design@synced'].alwaysOnTokens, null)
  assert.equal(items['plugin:design@synced'].detailsError, 'timed out')
})

test('redactTarget masks credential-shaped values and keeps the shape', () => {
  assert.equal(redactTarget('npx @playwright/mcp --browser chromium'), 'npx @playwright/mcp --browser chromium')
  assert.equal(redactTarget('npx srv --api-key sk-123 --port 3000'), 'npx srv --api-key … --port 3000')
  assert.equal(redactTarget('npx srv --token=abc'), 'npx srv --token=…')
  assert.equal(redactTarget('docker run -e GITHUB_TOKEN=ghp_x img'), 'docker run -e GITHUB_TOKEN=… img')
  assert.equal(redactTarget('https://mcp.example.com/mcp?api_key=abc&x=1'), 'https://mcp.example.com/mcp?…')
  assert.equal(redactTarget('https://user:pw@host/mcp'), 'https://…@host/mcp')
  assert.equal(redactTarget('https://mcp.slack.com/mcp'), 'https://mcp.slack.com/mcp')
})
