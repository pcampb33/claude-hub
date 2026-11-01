// Feature dossier extractor — the evidence substrate for a functionality audit
// (see docs/functionality-audit.md and the council-audit skill).
//
// Produces one frozen dossier per feature — the functionality audit's analog of
// a baseline screenshot. Facts come from disk, logs and git; nothing here is a
// model's opinion.
//
// House rule, enforced structurally: a feature with no evidence probe grades
// `unknown`, NEVER `unused`. "Never measured" and "measured zero" are different
// facts and this instrument is not allowed to conflate them.
//
// usage: node extract.mjs <outDir>

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { FEATURES } from './audit-catalog.mjs'

// Repo-relative rather than hardcoded: this script is run from the repo it
// audits, and a second copy pointed at the wrong tree would silently grade
// somebody else's code.
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const TRANSCRIPTS = path.join(os.homedir(), '.claude', 'projects')
const OUT = process.argv[2] || path.join(REPO, 'audit-dossiers')

fs.mkdirSync(OUT, { recursive: true })

const sh = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', cwd: REPO, maxBuffer: 1 << 28, ...opts }).trim()
  } catch (e) {
    return { __error: e.message?.slice(0, 200) ?? String(e) }
  }
}

const isErr = (v) => v && typeof v === 'object' && v.__error

// ---------------------------------------------------------------- statics ---

function walkFiles(target) {
  const abs = path.join(REPO, target)
  if (!fs.existsSync(abs)) return []
  if (fs.statSync(abs).isFile()) {
    // A feature declared as `electron/foo.ts` owns `electron/foo.test.ts` too;
    // without this every electron module reported 0 tests.
    const sibling = abs.replace(/\.ts$/, '.test.ts')
    return fs.existsSync(sibling) ? [abs, sibling] : [abs]
  }
  const out = []
  for (const entry of fs.readdirSync(abs, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(path.join(entry.parentPath ?? entry.path, entry.name))
  }
  return out
}

function statics(feature) {
  const files = feature.src.flatMap(walkFiles)
  const code = files.filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
  const tests = files.filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))
  let loc = 0
  let catches = []
  for (const f of code) {
    const text = fs.readFileSync(f, 'utf8')
    loc += text.split('\n').length
    // The repo's own named bug class: a rejected fetch that becomes an empty
    // collection the UI then reports as a confident absence.
    // Handlers are multi-line and hit a ')' almost immediately
    // (`.catch((err: unknown) => {`), so scan a window past the call rather
    // than capturing up to the first paren. The paren-bounded version of this
    // matched nothing and reported 0 suspicious catches across the whole repo.
    let i = -1
    while ((i = text.indexOf('.catch(', i + 1)) !== -1) {
      const win = text.slice(i, i + 400).replace(/\s+/g, ' ')
      const line = text.slice(0, i).split('\n').length
      const substitutesEmpty =
        /(=>|return)\s*(\[\]|\{\}|null|undefined|'')/.test(win) ||
        /set[A-Z]\w*\(\s*(\[\]|\{\}|null)\s*\)/.test(win)
      if (substitutesEmpty) {
        catches.push(`${path.relative(REPO, f).replace(/\\/g, '/')}:${line} — ${win.slice(0, 120)}`)
      }
    }
  }
  const rel = feature.src.map((s) => s.replace(/\\/g, '/'))
  const commits = sh('git', ['log', '--oneline', '--', ...rel])
  const firstLast = sh('git', ['log', '--format=%ad', '--date=short', '--', ...rel])
  const dates = isErr(firstLast) ? [] : firstLast.split('\n').filter(Boolean)
  return {
    files: code.length,
    testFiles: tests.length,
    loc,
    commits: isErr(commits) ? 'unknown' : commits.split('\n').filter(Boolean).length,
    firstTouched: dates.at(-1) ?? 'unknown',
    lastTouched: dates[0] ?? 'unknown',
    suspiciousCatches: catches,
  }
}

// --------------------------------------------------------------- evidence ---

const taskInfoCache = {}
function taskInfo(name) {
  if (taskInfoCache[name]) return taskInfoCache[name]
  const raw = sh('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `$t = Get-ScheduledTask -TaskName '${name}' -ErrorAction Stop; $i = $t | Get-ScheduledTaskInfo; $s = $t.Settings; ` +
    `"$($t.State)|$($i.LastRunTime)|$($i.LastTaskResult)|$($i.NextRunTime)|$($s.WakeToRun)|$($s.StartWhenAvailable)|$($s.DisallowStartIfOnBatteries)|$($s.StopIfGoingOnBatteries)"`,
  ])
  const value = isErr(raw)
    ? { error: raw.__error }
    : (() => {
        const [state, last, result, next, wake, catchUp, acOnly, stopOnBattery] = raw.split('|')
        const out = { state, lastRun: last, lastResult: result, nextRun: next }
        // Whether a missed run is ever recovered. WakeToRun=False plus
        // StartWhenAvailable=False means a machine asleep at the trigger time
        // silently skips that day entirely and never catches up — the log just
        // stops, which reads as "quiet", not "did not run".
        out.wakeToRun = wake
        out.catchesUpIfMissed = catchUp
        out.acPowerOnly = acOnly
        out.killedOnBattery = stopOnBattery
        if (wake === 'False' && catchUp === 'False') {
          out.CAN_SILENTLY_SKIP = 'asleep at trigger time => this run never happens and is never retried'
        }
        if (acOnly === 'True') {
          out.BATTERY_GATED = 'will not start on battery' + (stopOnBattery === 'True' ? '; also killed mid-run if unplugged' : '')
        }
        return out
      })()
  taskInfoCache[name] = value
  return value
}

function logProbe(p) {
  const abs = path.join(REPO, p.path)
  if (!fs.existsSync(abs)) return { status: 'unknown', detail: `log ${p.path} does not exist — nothing was instrumented` }
  const lines = fs.readFileSync(abs, 'utf8').split('\n').filter((l) => l.includes(p.pattern))
  if (lines.length === 0) return { status: 'zero', count: 0, detail: `log exists, 0 lines match "${p.pattern}"` }
  const stamp = (l) => (l.match(/^\S+/) || [''])[0]
  return { status: 'used', count: lines.length, first: stamp(lines[0]), last: stamp(lines.at(-1)) }
}

function dirCount(p) {
  const dir = p.path.startsWith('C:') ? p.path : path.join(REPO, p.path)
  if (!fs.existsSync(dir)) return { status: 'unknown', detail: `${p.path} does not exist` }
  let names = fs.readdirSync(dir)
  if (p.glob) names = names.filter((n) => n.endsWith(p.glob))
  const mtimes = names
    .map((n) => { try { return fs.statSync(path.join(dir, n)).mtime } catch { return null } })
    .filter(Boolean)
    .sort((a, b) => b - a)
  return {
    status: names.length ? 'used' : 'zero',
    count: names.length,
    last: mtimes[0] ? mtimes[0].toISOString().slice(0, 10) : 'unknown',
  }
}

function jsonCount(p) {
  const abs = p.path.startsWith('C:') ? p.path : path.join(REPO, p.path)
  if (!fs.existsSync(abs)) return { status: 'unknown', detail: `${p.path} missing` }
  try {
    const data = JSON.parse(fs.readFileSync(abs, 'utf8'))
    const n = Array.isArray(data) ? data.length : Object.keys(data).length
    return { status: n ? 'used' : 'zero', count: n, last: fs.statSync(abs).mtime.toISOString().slice(0, 10) }
  } catch (e) {
    return { status: 'unknown', detail: `${p.path} did not parse: ${e.message.slice(0, 60)}` }
  }
}

// Scans in Node rather than shelling to ripgrep. `rg` here is a Bash function
// that re-execs claude.exe, so it does not exist for a child process at all —
// and the failure surfaced as exit 1 with empty stdout, which the first
// version read as "0 matches" and reported as ZERO for a feature with real
// hits on disk. A missing tool must never be indistinguishable from a real
// zero, so the dependency is gone instead of patched around.
function scanFiles(root, ext, test) {
  if (!fs.existsSync(root)) return { __unreadable: `${root} does not exist` }
  const hits = { files: 0, matches: 0, unreadable: 0 }
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { hits.unreadable++; continue }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { stack.push(full); continue }
      if (!e.name.endsWith(ext)) continue
      let text
      try { text = fs.readFileSync(full, 'utf8') } catch { hits.unreadable++; continue }
      const n = test(text)
      if (n > 0) { hits.files++; hits.matches += n }
    }
  }
  return hits
}

function countOccurrences(text, needle) {
  let n = 0
  let i = -1
  while ((i = text.indexOf(needle, i + 1)) !== -1) n++
  return n
}

// A marker string found in a transcript proves only that the string was in
// that session — which includes every session that READ THE SOURCE containing
// it. Round 1 caught this once (a `[vault-recall]` pattern that also lived in
// CLAUDE.md, inflating 60 to 1327) and fixed the magnitude by lengthening the
// pattern, not the bug class: the longer pattern still counts 72 against 14
// real deliveries, because reading recall-core.ts puts the sentence in the
// transcript just as delivering it does. A probe that cannot separate "the
// feature ran" from "somebody read the feature" is not first-party evidence,
// so a transcript probe must now declare how it recognises a real invocation.
const LINE_TESTS = {
  // The recall hook's injection lands as a UserPromptSubmit hook_success
  // attachment. Anything else carrying the same sentence is source or chatter.
  'recall-injection': (o, needle) =>
    o.type === 'attachment' &&
    o.attachment?.type === 'hook_success' &&
    o.attachment?.hookEvent === 'UserPromptSubmit' &&
    typeof o.attachment?.content === 'string' &&
    o.attachment.content.includes(needle),
}

function countDiscriminated(text, needle, testName) {
  const test = LINE_TESTS[testName]
  let n = 0
  for (const line of text.split('\n')) {
    if (!line.includes(needle)) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (test(o, needle)) n++
  }
  return n
}

function transcriptProbe(p) {
  // An undeclared line test is a broken probe, not a clean result.
  if (p.lineTest && !LINE_TESTS[p.lineTest]) {
    return { status: 'unknown', detail: `no line test named "${p.lineTest}" — matches cannot be validated` }
  }
  const r = p.lineTest
    ? scanFiles(TRANSCRIPTS, '.jsonl', (t) => countDiscriminated(t, p.pattern, p.lineTest))
    : scanFiles(TRANSCRIPTS, '.jsonl', (t) => countOccurrences(t, p.pattern))
  if (r.__unreadable) return { status: 'unknown', detail: r.__unreadable }
  if (r.unreadable > 0 && r.matches === 0) {
    return { status: 'unknown', detail: `${r.unreadable} files could not be read and nothing matched — cannot claim zero` }
  }
  return { status: r.matches ? 'used' : 'zero', count: r.matches, sessions: r.files, unreadable: r.unreadable }
}

function grepCount(p) {
  const r = scanFiles(p.dir, '.md', (t) => (t.includes(p.pattern) ? 1 : 0))
  if (r.__unreadable) return { status: 'unknown', detail: r.__unreadable }
  if (r.unreadable > 0 && r.files === 0) {
    return { status: 'unknown', detail: `${r.unreadable} files unreadable and nothing matched — cannot claim zero` }
  }
  return { status: r.files ? 'used' : 'zero', count: r.files, unreadable: r.unreadable }
}

function subagentDirs(p) {
  if (!fs.existsSync(p.path)) return { status: 'unknown', detail: 'transcript root missing' }
  // subagentsRoot() in electron/subagents.ts is
  // <projectDir>/<sessionId>/subagents — one level deeper than the first
  // version of this probe looked. That version reported ZERO against 110 real
  // directories: a false absence inside the instrument built to catch them.
  let dirs = 0
  let records = 0
  for (const proj of fs.readdirSync(p.path)) {
    let sessions = []
    try { sessions = fs.readdirSync(path.join(p.path, proj), { withFileTypes: true }) } catch { continue }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const sub = path.join(p.path, proj, s.name, 'subagents')
      if (!fs.existsSync(sub)) continue
      dirs++
      try {
        for (const e of fs.readdirSync(sub, { withFileTypes: true, recursive: true })) {
          if (e.isFile() && e.name.endsWith('.jsonl')) records++
        }
      } catch { /* unreadable dir stays uncounted */ }
    }
  }
  return { status: dirs ? 'used' : 'zero', count: records, detail: `${dirs} sessions carry a subagents/ folder` }
}

function artifact(p) {
  const abs = p.path.startsWith('C:') ? p.path : path.join(REPO, p.path)
  if (!fs.existsSync(abs)) return { status: 'zero', detail: `${p.path} does not exist` }
  const st = fs.statSync(abs)
  return { status: 'used', count: st.size, last: st.mtime.toISOString().slice(0, 10), detail: `${st.size} bytes` }
}

function lineCount(p) {
  const abs = p.path.startsWith('C:') ? p.path : path.join(REPO, p.path)
  if (!fs.existsSync(abs)) return { status: 'unknown', detail: `${p.path} missing` }
  const n = fs.readFileSync(abs, 'utf8').split('\n').filter(Boolean).length
  return { status: n ? 'used' : 'zero', count: n }
}

// electron/workflows.ts enumerates ~/.claude/workflows (global) PLUS
// <project>/.claude/workflows for every registered project. The catalog first
// probed only the global dir, which does not exist — reporting the feature
// unmeasurable while five real workflows sat in project dirs.
function workflowDirs() {
  const globalDir = path.join(os.homedir(), '.claude', 'workflows')
  let total = 0
  const places = []
  if (fs.existsSync(globalDir)) {
    const n = fs.readdirSync(globalDir).length
    total += n
    places.push(`global=${n}`)
  } else {
    places.push('global=absent')
  }
  try {
    for (const proj of JSON.parse(fs.readFileSync(path.join(REPO, 'registry.json'), 'utf8'))) {
      const d = path.join(proj.path, '.claude', 'workflows')
      if (!fs.existsSync(d)) continue
      const n = fs.readdirSync(d).filter((x) => !x.startsWith('.')).length
      if (n) { total += n; places.push(`${proj.name}=${n}`) }
    }
  } catch (e) {
    return { status: 'unknown', detail: `registry unreadable: ${e.message.slice(0, 60)}` }
  }
  return { status: total ? 'used' : 'zero', count: total, detail: places.join(' ') }
}

function runProbe(p) {
  const tag = (r) => ({ ...r, firstParty: p.firstParty === true })
  return tag(runProbeInner(p))
}

function runProbeInner(p) {
  switch (p.type) {
    case 'log': return { ...logProbe(p), label: p.label }
    case 'dir-count': return { ...dirCount(p), label: p.label }
    case 'json-count': return { ...jsonCount(p), label: p.label }
    case 'transcript': return { ...transcriptProbe(p), label: p.label }
    case 'grep-count': return { ...grepCount(p), label: p.label }
    case 'subagent-dirs': return { ...subagentDirs(p), label: p.label }
    case 'artifact': return { ...artifact(p), label: p.label }
    case 'lines': return { ...lineCount(p), label: p.label }
    case 'workflow-dirs': return { ...workflowDirs(), label: p.label }
    case 'task': {
      const info = taskInfo(p.name)
      const out = { label: p.label, status: info.error ? 'unknown' : 'used', ...info }
      if (p.log) {
        const abs = path.join(REPO, p.log)
        const lastLine = fs.existsSync(abs)
          ? (fs.readFileSync(abs, 'utf8').trim().split('\n').at(-1) || '')
          : ''
        out.logLastLine = lastLine.slice(0, 120) || 'log missing'
        // A scheduled job that ran but wrote nothing is the "failure rendered
        // as an absence" case in its purest form: the log simply stops, and
        // reading it alone says "fine, just quiet". Only the task's own
        // last-run time contradicts it. Compute the divergence rather than
        // hoping a reader spots two timestamps in different formats/zones.
        const logStamp = Date.parse((lastLine.match(/^\S+/) || [''])[0])
        const runStamp = Date.parse(info.lastRun)
        if (Number.isFinite(logStamp) && Number.isFinite(runStamp)) {
          const gapHours = (runStamp - logStamp) / 36e5
          out.logVsTaskGapHours = gapHours.toFixed(1)
          if (gapHours > 2) {
            out.DIVERGENCE = `task last ran ${gapHours.toFixed(1)}h AFTER the log's last line — that run produced no log output`
          }
        }
        if (info.lastResult && info.lastResult !== '0') {
          out.NONZERO_RESULT = `last result ${info.lastResult} (0x${Number(info.lastResult).toString(16)}) — not success`
        }
      }
      return out
    }
    default: return { label: p.label, status: 'unknown', detail: `no probe implementation for ${p.type}` }
  }
}

// ------------------------------------------------- renderer reachability ---

// A channel handled in the main process but called from nowhere in src/ is a
// capability with no door. Computed once, shared by every dossier.
const rendererText = walkFiles('src').filter((f) => /\.(ts|tsx)$/.test(f))
  .map((f) => fs.readFileSync(f, 'utf8')).join('\n')
const preloadText = fs.existsSync(path.join(REPO, 'electron/preload-core.ts'))
  ? fs.readFileSync(path.join(REPO, 'electron/preload-core.ts'), 'utf8') : ''
const ipcTypes = fs.readFileSync(path.join(REPO, 'shared/ipc-types.ts'), 'utf8')

const channelMap = {}
for (const m of ipcTypes.matchAll(/^\s{2}(\w+):\s*'([\w:-]+)',/gm)) channelMap[m[2]] = m[1]

function channelReach(channel) {
  const apiName = channelMap[channel]
  if (!apiName) return { channel, api: 'unknown', calledInRenderer: 'unknown' }
  // Push-event channels are never called by their IPC_CHANNELS key: preload
  // exposes them as `on<Key>` (`sdkSessionEvent` -> `onSdkSessionEvent`), and
  // `\bsdkSessionEvent\b` does not match `onSdkSessionEvent`. The bare-key
  // version reported `sdk-session:event` as a channel with no renderer caller
  // while sessionClient.ts:74 calls it — a false absence, inside the
  // instrument, about a door that does exist.
  const onForm = `on${apiName[0].toUpperCase()}${apiName.slice(1)}`
  const rx = new RegExp(`\\b(${apiName}|${onForm})\\b`)
  // preload does not NAME its methods: buildInvokeApi() generates one per
  // non-event key of IPC_CHANNELS via Object.fromEntries, and two `extends
  // never` constraints prove at compile time that the channel map and HubApi
  // describe the same surface. Grepping preload for a literal method name
  // therefore matched nothing and reported every channel in the app as absent
  // from preload — 75 false negatives, and two scouts caught it before this
  // did. Read the generation rule instead of searching for text it never emits.
  const isEventChannel = /EVENT_CHANNEL_KEYS = \[[^\]]*'/.test(preloadText)
    ? new RegExp(`EVENT_CHANNEL_KEYS = \\[[^\\]]*'${apiName}'`).test(preloadText)
    : false
  return {
    channel,
    api: apiName,
    calledInRenderer: rx.test(rendererText),
    // Every invoke channel is generated; event channels are exposed as on<Key>.
    inPreload: preloadText ? (isEventChannel ? rx.test(preloadText) : true) : 'unknown',
  }
}

// ----------------------------------------------------------------- render ---

const summary = []

for (const f of FEATURES) {
  const st = statics(f)
  const probes = (f.evidence || []).map(runProbe)
  const reach = (f.channels || []).map(channelReach)

  // Provenance matters more than the count. A probe that reads an artifact some
  // OTHER component wrote (the inbox file an automation fills, the note corpus
  // the curate hook produces) proves that automation ran — it says nothing about
  // whether anyone opened the view whose row it lands in. Grading those as USED
  // put a confident answer in a column nobody had actually found out, which is
  // the exact bug class this repo names. Only a probe marked firstParty:true
  // observes an action the feature itself performs.
  const firstParty = probes.filter((p) => p.firstParty)
  const derivedOnly = probes.length > 0 && firstParty.length === 0

  const tier = probes.length === 0
    ? 'UNKNOWN — not instrumented'
    : derivedOnly
      ? 'UNKNOWN — only indirect evidence (an artifact another component wrote)'
      : firstParty.every((p) => p.status === 'zero') ? 'ZERO — instrumented and never fired'
        : firstParty.some((p) => p.status === 'used') ? 'USED'
          : 'UNKNOWN — probes could not read their input'

  const lines = []
  lines.push(`# ${f.name}`)
  lines.push('')
  lines.push(`- **id**: \`${f.id}\``)
  lines.push(`- **kind**: ${f.kind}`)
  lines.push(`- **evidence of use**: ${tier}`)
  lines.push('')
  lines.push('## What it claims to do')
  lines.push('')
  lines.push(f.claim)
  lines.push('')
  lines.push('## Entry points')
  lines.push('')
  if (reach.length) {
    lines.push('| channel | hubApi method | called from renderer | in preload |')
    lines.push('|---|---|---|---|')
    for (const r of reach) {
      lines.push(`| \`${r.channel}\` | \`${r.api}\` | ${r.calledInRenderer} | ${r.inPreload} |`)
    }
  } else {
    lines.push('_No IPC channel of its own — reached by hook, scheduled task, or CLI._')
  }
  lines.push('')
  lines.push('## Invocation evidence')
  lines.push('')
  if (!probes.length) {
    lines.push('**No probe exists for this feature.** Nothing on disk records whether it has ever')
    lines.push('been used. Grade this `unknown`. Do NOT read the absence of evidence as evidence')
    lines.push('of absence — that inference is the single most expensive error this audit can make.')
  } else {
    for (const p of probes) {
      const bits = Object.entries(p)
        .filter(([k]) => !['label', 'status'].includes(k))
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
      lines.push(`- **${p.label}** — \`${p.status}\`${bits ? ` (${bits})` : ''}`)
    }
  }
  lines.push('')
  lines.push('## Failure surface')
  lines.push('')
  if (st.suspiciousCatches.length) {
    lines.push('`.catch` handlers that substitute an empty/neutral value — check each against the')
    lines.push('repo rule that a failure must never render as an absence. A handler that also calls')
    lines.push('something like `markFailed(...)` is the CORRECT pattern, not a defect: it empties the')
    lines.push('collection and separately records that the fetch failed, so the UI can say so. Only')
    lines.push('flag the ones with no such companion.')
    lines.push('')
    for (const c of st.suspiciousCatches) lines.push(`- \`${c}\``)
  } else {
    lines.push('_No `.catch` returning an empty collection found in this slice._')
  }
  lines.push('')
  lines.push('## Cost')
  lines.push('')
  lines.push(`- source files: ${st.files} (+${st.testFiles} test files)`)
  lines.push(`- lines of code: ${st.loc}`)
  lines.push(`- commits touching it: ${st.commits}`)
  lines.push(`- first touched: ${st.firstTouched} · last touched: ${st.lastTouched}`)
  lines.push(`- source globs: ${f.src.map((s) => `\`${s}\``).join(', ')}`)
  lines.push('')

  fs.writeFileSync(path.join(OUT, `${f.id}.md`), lines.join('\n'), 'utf8')

  summary.push({
    id: f.id, name: f.name, kind: f.kind, tier, loc: st.loc, tests: st.testFiles,
    commits: st.commits, lastTouched: st.lastTouched,
    unreachable: reach.filter((r) => r.calledInRenderer === false).map((r) => r.channel),
    catches: st.suspiciousCatches.length,
  })
}

// Orphan channels: handled somewhere, called from nowhere in the renderer.
const allChannels = Object.entries(channelMap)
const orphans = allChannels
  .map(([channel]) => channelReach(channel))
  .filter((r) => r.calledInRenderer === false)

const idx = []
idx.push('# Feature dossiers — baseline')
idx.push('')
idx.push(`Generated from the repo at \`${sh('git', ['rev-parse', '--short', 'HEAD'])}\`.`)
idx.push('')
idx.push('`UNKNOWN — not instrumented` means nobody can tell whether the feature is used.')
idx.push('It does **not** mean unused, and must never be graded as if it did.')
idx.push('')
idx.push('| feature | kind | evidence of use | LOC | tests | commits | last touched | suspicious catches |')
idx.push('|---|---|---|---|---|---|---|---|')
for (const s of summary) {
  idx.push(`| [${s.name}](${s.id}.md) | ${s.kind} | ${s.tier} | ${s.loc} | ${s.tests} | ${s.commits} | ${s.lastTouched} | ${s.catches} |`)
}
idx.push('')
idx.push('## Channels with no renderer caller')
idx.push('')
if (orphans.length) {
  for (const o of orphans) idx.push(`- \`${o.channel}\` (\`hubApi.${o.api}\`) — in preload: ${o.inPreload}`)
} else {
  idx.push('_None: every declared channel is called from somewhere in `src/`._')
}
idx.push('')
idx.push('## Tally')
idx.push('')
for (const tier of [
  'USED',
  'ZERO — instrumented and never fired',
  'UNKNOWN — only indirect evidence (an artifact another component wrote)',
  'UNKNOWN — not instrumented',
  'UNKNOWN — probes could not read their input',
]) {
  const n = summary.filter((s) => s.tier === tier).length
  idx.push(`- ${tier}: **${n}** of ${summary.length}`)
}
fs.writeFileSync(path.join(OUT, '_index.md'), idx.join('\n'), 'utf8')

console.log(`wrote ${summary.length} dossiers to ${OUT}`)
console.log(idx.slice(idx.indexOf('## Tally')).join('\n'))
console.log(`orphan channels: ${orphans.length}`)
