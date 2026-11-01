#!/usr/bin/env node
// Builds a synthetic environment for screenshots that can be shared: three
// fictional projects with git history, a month of Claude Code transcripts, a
// small vault with an inbox, and a ~/.claude with skills and hooks. Nothing in
// it comes from the machine's real data.
//
// USAGE (from a checkout or worktree whose registry you can replace):
//   node scripts/demo-env.mjs [demoDir]        # default <os-temp>/claude-hub-demo
//   npx vite build
//   USERPROFILE=<demoDir>/home CLAUDE_HUB_VAULT=<demoDir>/vault \
//     LOCALAPPDATA=<demoDir>/localappdata node scripts/screenshot-app.mjs <outDir>
//
// The demo home holds an empty AppData\Roaming: Electron keeps its user data
// there and crashes at launch (exit 0x80000003) when the folder is missing.
// It also keeps the shots' localStorage out of your real profile.
//
// The registry lives at <repo>/registry.json, so this script writes the demo
// registry there and refuses if a non-demo one is already present: run it in a
// worktree, never in the checkout that holds your real registry. Delete the
// worktree's usage-index.json, skill-usage-index.json and extensions-cache.json
// first if the app ever ran there against real data: they are caches.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const demo = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'claude-hub-demo'))
const registryFile = path.join(repoRoot, 'registry.json')

if (fs.existsSync(registryFile)) {
  const existing = JSON.parse(fs.readFileSync(registryFile, 'utf-8'))
  if (!existing.every((e) => e.path.startsWith(demo))) {
    console.error(`refusing: ${registryFile} is a real registry. Run this in a worktree.`)
    process.exit(1)
  }
}
fs.rmSync(demo, { recursive: true, force: true })

const home = path.join(demo, 'home')
const claudeDir = path.join(home, '.claude')
const vault = path.join(demo, 'vault')
const now = Date.now()
const DAY = 864e5
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'ignore' })

// Seeded PRNG so every run produces the same pictures.
let seed = 7
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const pick = (xs) => xs[Math.floor(rand() * xs.length)]

const PROJECTS = [
  {
    name: 'project 1',
    blurb: 'Next.js trip planner for multi-day hikes.',
    files: {
      'src/gpx.ts': `// Reads a GPX file's track into a flat list of points.
export interface Point { lat: number; lon: number; ele?: number }

export function readTrack(doc: Document): Point[] {
  const seg = doc.querySelector('trk > trkseg')
  if (!seg) return []
  return Array.from(seg.querySelectorAll('trkpt')).map((pt) => ({
    lat: Number(pt.getAttribute('lat')),
    lon: Number(pt.getAttribute('lon')),
    ele: pt.querySelector('ele') ? Number(pt.querySelector('ele')!.textContent) : undefined,
  }))
}
`,
    },
    prompts: [
      'add an elevation profile chart to the route page',
      'the GPX import drops waypoints after the first track segment — find out why',
      'write tests for the permit-availability scraper',
      'make the packing list sync between devices',
      'why does the map flicker when switching basemaps?',
      'add offline caching for downloaded routes',
    ],
  },
  {
    name: 'project 2',
    blurb: 'Python service that parses supplier invoices into structured line items.',
    files: {
      'invoice.py': `"""Totals for parsed invoices."""


def line_total(qty, unit_price, vat_rate):
    net = round(qty * unit_price, 2)
    return round(net * (1 + vat_rate), 2)


def invoice_total(lines):
    return sum(line_total(l["qty"], l["unit_price"], l["vat_rate"]) for l in lines)
`,
    },
    prompts: [
      'the VAT total is off by a cent on multi-currency invoices',
      'add a CLI command to re-run extraction on a folder',
      'profile the PDF parser, it takes 4s per page',
      'refactor the line-item matcher into its own module',
      'add a confidence score to each extracted field',
    ],
  },
  {
    name: 'project 3',
    blurb: 'Rust CLI for batch image resizing and format conversion.',
    files: {
      'presets.toml': `# Named output presets for \`forge batch --preset <name>\`.
[thumbnail]
width = 320
format = "webp"
quality = 80

[archive]
format = "png"
strip_metadata = false
`,
    },
    prompts: [
      'add AVIF output behind a feature flag',
      'resizing a 16-bit PNG panics — reproduce and fix',
      'parallelize the batch mode with rayon',
      'write a README section on the preset file format',
    ],
  },
]
const TOOLS = ['Read', 'Read', 'Read', 'Edit', 'Edit', 'Bash', 'Bash', 'Grep', 'Glob', 'Write']
const SKILLS = ['verify-gate', 'review-changes', 'release-notes']
const MODELS = ['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']

// ---- projects + transcripts ----------------------------------------------
const registry = []
for (const p of PROJECTS) {
  const dir = path.join(demo, 'projects', p.name)
  write(path.join(dir, 'README.md'), `# ${p.name}\n\n${p.blurb}\n`)
  write(path.join(dir, 'CLAUDE.md'), `# ${p.name}\n\n${p.blurb}\n\n## Verify\n\nRun the test suite before calling a change done.\n`)
  for (const [file, text] of Object.entries(p.files)) write(path.join(dir, file), text)
  // A real Claude Code session run here for a screenshot must not fire the
  // machine's global hooks (curate would queue demo notes into the real vault).
  write(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: true }, null, 2) + '\n')
  git(dir, 'init', '-q')
  git(dir, '-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'add', '-A')
  git(dir, '-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'commit', '-q', '-m', 'Initial commit')
  write(path.join(dir, 'NOTES.md'), 'work in progress\n') // one uncommitted change
  registry.push({ id: randomUUID(), name: p.name, path: dir, addedAt: new Date(now - 40 * DAY).toISOString() })

  const sessionDir = path.join(claudeDir, 'projects', dir.replace(/[.:\\/_ ]/g, '-'))
  for (let s = 0; s < p.prompts.length * 2; s++) {
    const sessionId = randomUUID()
    let t = now - rand() * 28 * DAY - 2 * 3600e3
    const lines = []
    let parent = null
    const push = (rec) => {
      const uuid = randomUUID()
      lines.push(JSON.stringify({ parentUuid: parent, isSidechain: false, uuid, timestamp: new Date(t).toISOString(), sessionId, cwd: dir, entrypoint: 'cli', version: '2.1.316', gitBranch: 'main', userType: 'external', ...rec }))
      parent = uuid
      t += (20 + rand() * 90) * 1000
    }
    const model = pick(MODELS)
    const turns = 2 + Math.floor(rand() * 6)
    for (let turn = 0; turn < turns; turn++) {
      const text = turn === 0 ? p.prompts[s % p.prompts.length] : pick(['looks good, continue', 'run the tests', 'yes, go with that', 'can you also check the edge case with an empty input?'])
      push({ type: 'user', message: { role: 'user', content: text } })
      const calls = 1 + Math.floor(rand() * 5)
      for (let c = 0; c < calls; c++) {
        const name = rand() < 0.08 ? 'Skill' : pick(TOOLS)
        const input = name === 'Skill' ? { skill: pick(SKILLS) } : { file_path: path.join(dir, 'src', 'index.ts') }
        const id = `toolu_${randomUUID().replace(/-/g, '')}`
        push({ type: 'assistant', message: { model, id: `msg_${randomUUID().replace(/-/g, '')}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage: usage() } })
        push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
      }
      push({ type: 'assistant', message: { model, id: `msg_${randomUUID().replace(/-/g, '')}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done. The change is in place and the tests pass.' }], stop_reason: 'end_turn', usage: usage() } })
    }
    write(path.join(sessionDir, `${sessionId}.jsonl`), lines.join('\n') + '\n')
    const mtime = new Date(t)
    fs.utimesSync(path.join(sessionDir, `${sessionId}.jsonl`), mtime, mtime)
  }
}
function usage() {
  return { input_tokens: 4, cache_creation_input_tokens: Math.floor(2000 + rand() * 20000), cache_read_input_tokens: Math.floor(40000 + rand() * 160000), output_tokens: Math.floor(200 + rand() * 3000) }
}
write(registryFile, JSON.stringify(registry, null, 2) + '\n')

// ---- ~/.claude: skills + hooks ---------------------------------------------
const SKILL_TEXT = {
  'verify-gate': 'Definition-of-done gate: run lint, typecheck and tests, then drive the changed flow.',
  'review-changes': 'Review the working diff across dimensions and adversarially verify each finding.',
  'release-notes': 'Draft release notes from the commits since the last tag.',
}
for (const [name, description] of Object.entries(SKILL_TEXT)) {
  write(path.join(claudeDir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n`)
}
const script = (f) => `node "${path.join(repoRoot, 'scripts', f).replace(/\\/g, '/')}"`
write(path.join(claudeDir, 'settings.json'), JSON.stringify({
  hooks: {
    SessionEnd: [{ hooks: [{ type: 'command', command: script('curate-session.mjs') }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: script('vault-recall.mjs') }] }],
  },
}, null, 2))

// ---- vault -----------------------------------------------------------------
const NOTES = [
  ['GPX files can hold several track segments — iterate trkseg, not just the first', 'project 1', ['Fixture files should include the multi-part case']],
  ['Fixture files should include the multi-part case', null, []],
  ['Leaflet basemap swaps flicker unless the old layer is removed after the new one loads', 'project 1', []],
  ['Round money only at the invoice total, never per line', 'project 2', ['Use Decimal, not float, for currency']],
  ['Use Decimal, not float, for currency', 'project 2', []],
  ['pdfplumber re-parses the page for every crop — extract words once and filter', 'project 2', ['Profile before parallelizing']],
  ['Profile before parallelizing', null, ['Measure the regression before and after the fix']],
  ['The image crate decodes 16-bit PNGs as Rgba16 — convert before resizing', 'project 3', ['Fixture files should include the multi-part case']],
  ['rayon par_iter over files saturates disk before CPU on spinning drives', 'project 3', ['Profile before parallelizing']],
  ['Measure the regression before and after the fix', null, []],
  ['A test that never fails proves nothing — reintroduce the bug once', null, ['Measure the regression before and after the fix']],
]
for (const [title, project, related] of NOTES) {
  const front = project ? `---\nproject: ${project}\n---\n\n` : ''
  const rel = related.length ? `\n## Related\n${related.map((r) => `- [[${r}]] *(see-also)*`).join('\n')}\n` : ''
  write(path.join(vault, `${title}.md`), `${front}# ${title}\n\nA short, specific lesson captured from a session.\n${rel}`)
}
write(path.join(vault, 'index.md'), `# Knowledge Vault Index\n\n${NOTES.map(([t]) => `- [[${t}]]`).join('\n')}\n`)
const stamp = (d) => new Date(now - d * DAY).toISOString()
write(path.join(vault, '_inbox.md'), `# Inbox\n
## AVIF encoding is 10x slower than WebP at default speed — set speed 6 for batch jobs

_${stamp(0.2)} — project 3 — session ${randomUUID()} — high — measured during the AVIF feature work_

Default encoder speed made a 200-image batch take 9 minutes; speed 6 brought it to 70s with no visible loss.

## Permit pages render availability client-side — scrape the JSON endpoint instead

_${stamp(1.1)} — project 1 — session ${randomUUID()} — medium — the scraper returned empty tables until this was found_

The HTML has no availability data; the page fetches it from an XHR endpoint after load.
`)
git(vault, 'init', '-q')

// ---- hook logs + ~/.claude.json --------------------------------------------
// The hooks log into <repo>/scripts; seed them only where none exist yet.
const sessionIds = fs.readdirSync(path.join(claudeDir, 'projects'), { recursive: true })
  .filter((f) => f.endsWith('.jsonl')).map((f) => path.basename(f, '.jsonl'))
const logLine = (d, msg) => `${stamp(d)} [pid ${1000 + Math.floor(rand() * 9000)}] ${msg}`
const curateLog = sessionIds.map((id, i) => logLine(28 - i * 0.9, i % 4 === 0
  ? `done: queued 1 note(s) (cost=$${(0.15 + rand() * 0.2).toFixed(4)})`
  : `done: triage=no-candidate (cost=$${(0.008 + rand() * 0.01).toFixed(4)})`))
const recallLog = NOTES.slice(0, 6).map(([title], i) => logLine(20 - i * 3,
  `worker done: matched 1 ${JSON.stringify([title])} (session=${sessionIds[i]} cost=$${(0.005 + rand() * 0.003).toFixed(4)})`))
for (const [file, lines] of [['curate-session.log', curateLog], ['vault-recall.log', recallLog]]) {
  const target = path.join(repoRoot, 'scripts', file)
  if (!fs.existsSync(target)) fs.writeFileSync(target, lines.join('\n') + '\n')
}
write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }, null, 2))

fs.mkdirSync(path.join(demo, 'localappdata'), { recursive: true })
fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true }) // for CLAUDE_HUB_SESSIONS_DIR

console.log(`demo environment: ${demo}`)
console.log(`registry: ${registryFile} (${registry.length} projects)`)
console.log(`USERPROFILE=${home}\nCLAUDE_HUB_VAULT=${vault}\nLOCALAPPDATA=${path.join(demo, 'localappdata')}`)
