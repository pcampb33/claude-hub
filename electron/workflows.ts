import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listProjects } from './registry.ts'
import { resolveKnownPath } from './resolve-known-path.ts'
import type {
  PromoteResult,
  WorkflowComposition,
  WorkflowEntry,
  WorkflowPhase,
  WorkflowStep,
} from '../shared/ipc-types'

// Workflow scripts are Claude Code's Workflow DevKit files (`export const
// meta = {...}` + an agent()/pipeline()/parallel() body). They are NOT valid
// standalone modules (top-level `return`, bare export), so import()/node
// --check can't load them. We never execute the body — we statically read
// the `meta` literal and scan the body for its declared structure. Same
// trust level as the skills and hooks the hub already reads off disk: these
// are the user's own local files.

// --- lexer helpers: skip over string / template / brace regions so the
// scanners below don't trip on `agent(` inside a prompt string, a `)` inside
// a template `${...}`, or a `}` inside a nested schema object. ---

// src[i] is a quote char (' " or `). Returns the index just past the close.
function skipString(src: string, i: number): number {
  const quote = src[i]
  i++
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (quote === '`' && c === '$' && src[i + 1] === '{') {
      i = skipBraces(src, i + 1) // template interpolation can contain anything
      continue
    }
    if (c === quote) return i + 1
    i++
  }
  return i
}

// src[i] is '{'. Returns the index just past the matching '}', skipping
// strings so braces inside string literals don't count.
function skipBraces(src: string, i: number): number {
  let depth = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return i
}

// Blank out // and /* */ comments so the body scanners don't treat a comment
// like `// agent() resolves null` as a real call site. String-aware: quotes
// and template literals are copied verbatim (a `//` inside a URL string, or an
// `agent(` inside a prompt, is preserved, not stripped). Offsets are kept
// stable by replacing comment bodies with same-length runs of spaces.
function stripComments(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(src, i)
      out += src.slice(i, end)
      i = end
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      const end = nl < 0 ? src.length : nl
      out += ' '.repeat(end - i)
      i = end
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      const end = close < 0 ? src.length : close + 2
      out += src.slice(i, end).replace(/[^\n]/g, ' ')
      i = end
      continue
    }
    out += c
    i++
  }
  return out
}

// Given the index just after `agent(`, return the text of its options object
// literal (the `{...}` argument), or null if the call has no options object.
// Stops at the agent call's own closing paren so it never reads past the call.
function extractAgentOpts(src: string, afterParen: number): string | null {
  let i = afterParen
  let paren = 1
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === '(') paren++
    else if (c === ')') {
      paren--
      if (paren === 0) return null
    } else if (c === '{' && paren === 1) {
      return src.slice(i, skipBraces(src, i))
    }
    i++
  }
  return null
}

// Given the index just after `agent(`, return the raw text of the first
// argument (the prompt), trimmed. Reads to the first top-level comma or the
// call's closing paren, skipping strings/templates/braces so a comma inside
// the prompt string or a nested object doesn't end it early.
function extractAgentFirstArg(src: string, afterParen: number): string {
  const start = afterParen
  let i = afterParen
  let paren = 1
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === '{') {
      i = skipBraces(src, i)
      continue
    }
    if (c === '(') paren++
    else if (c === ')') {
      paren--
      if (paren === 0) return src.slice(start, i).trim()
    } else if (c === ',' && paren === 1) {
      return src.slice(start, i).trim()
    }
    i++
  }
  return src.slice(start, i).trim()
}

// The displayable prompt for a step: the unwrapped content when the first arg
// is ONE string/template literal (a `${...}` inside stays verbatim), else null
// — a computed prompt like `d.prompt` can't be resolved without running the
// script, so we show nothing rather than a misleading fragment.
function promptFromArg(arg: string): string | null {
  const q = arg[0]
  if (q !== '`' && q !== "'" && q !== '"') return null
  // Whole arg must be a single literal — rules out `"a" + x` concatenations,
  // where skipString stops before the end.
  if (skipString(arg, 0) !== arg.length) return null
  return arg.slice(1, -1)
}

// Pull a string-valued option (label/phase/model/effort/agentType) out of an
// options-object text. Value captured verbatim, so a `label: \`x:${y}\``
// comes back as `x:${y}` — good enough to display the declared label.
function optString(opts: string, key: string): string | null {
  const m = opts.match(new RegExp(`\\b${key}\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`))
  return m ? m[2] : null
}

interface MetaBlock {
  name?: string
  description?: string
  whenToUse?: string
  example?: string
  phases?: { title: string; detail?: string }[]
}

// The arg keys the body reads off `args` (or an alias assigned from it, e.g.
// `const ARGS = typeof args === 'string' ? JSON.parse(args) : args`). Anything
// read off args IS a user-supplied input, so this is the workflow's declared
// arg contract — used to build the How-to-use invocation and the labeled
// launch fields. Body is already comment-stripped, so matches are real code.
function detectArgKeys(body: string): string[] {
  const aliases = new Set(['args'])
  const aliasRe = /\bconst\s+(\w+)\s*=\s*[^\n;]*\bargs\b/g
  for (let m = aliasRe.exec(body); m; m = aliasRe.exec(body)) aliases.add(m[1])

  const keys = new Set<string>()
  for (const alias of aliases) {
    const re = new RegExp(`\\b${alias}\\.(\\w+)`, 'g')
    for (let m = re.exec(body); m; m = re.exec(body)) keys.add(m[1])
  }
  return [...keys]
}

function extractMeta(src: string): MetaBlock | null {
  const decl = src.search(/export\s+const\s+meta\s*=\s*\{/)
  if (decl < 0) return null
  const braceStart = src.indexOf('{', decl)
  const literal = src.slice(braceStart, skipBraces(src, braceStart))
  try {
    // meta is contractually a PURE LITERAL (no vars, calls, spreads), so
    // evaluating just this isolated object expression — not the file — is
    // safe. Any deviation throws here and we fall back to the filename.
    const fn = new Function(`return (${literal})`)
    const obj = fn()
    return obj && typeof obj === 'object' ? (obj as MetaBlock) : null
  } catch {
    return null
  }
}

function parseComposition(body: string, metaPhases: { title: string; detail?: string }[]): WorkflowComposition {
  // phase('X') call sites, in source order — used for phase mapping fallback.
  const phaseCalls: { index: number; title: string }[] = []
  const phaseRe = /\bphase\(\s*(['"`])([\s\S]*?)\1\s*\)/g
  for (let m = phaseRe.exec(body); m; m = phaseRe.exec(body)) {
    phaseCalls.push({ index: m.index, title: m[2] })
  }

  // Every agent() call site.
  const steps: WorkflowStep[] = []
  const agentRe = /\bagent\(/g
  for (let m = agentRe.exec(body); m; m = agentRe.exec(body)) {
    const opts = extractAgentOpts(body, agentRe.lastIndex)
    const prompt = promptFromArg(extractAgentFirstArg(body, agentRe.lastIndex))
    const explicitPhase = opts ? optString(opts, 'phase') : null
    // Nearest phase() call lexically before this agent() — the DevKit's
    // "subsequent agent() calls group under this phase" rule.
    let nearestPhase: string | null = null
    for (const p of phaseCalls) {
      if (p.index < m.index) nearestPhase = p.title
      else break
    }
    steps.push({
      label: opts ? optString(opts, 'label') : null,
      prompt,
      phase: explicitPhase ?? nearestPhase,
      model: opts ? optString(opts, 'model') : null,
      effort: opts ? optString(opts, 'effort') : null,
      agentType: opts ? optString(opts, 'agentType') : null,
      structured: opts ? /\bschema\s*:/.test(opts) : false,
      worktree: opts ? /\bisolation\s*:\s*(['"`])worktree\1/.test(opts) : false,
    })
  }
  // Attach each step to its phase during the build so it can be dropped into
  // the right WorkflowPhase below; index kept separate from the wire type.
  const stepPhases = steps.map((s) => s.phase)

  // Phase list: declared meta phases first (in order), then any phase only
  // referenced from the body (a phase() call or a phase: opt with no meta
  // entry — the DevKit gives those their own group).
  const phaseTitles: string[] = []
  const detailByTitle = new Map<string, string | null>()
  for (const p of metaPhases) {
    phaseTitles.push(p.title)
    detailByTitle.set(p.title, p.detail ?? null)
  }
  for (const title of [...phaseCalls.map((p) => p.title), ...stepPhases]) {
    if (title && !phaseTitles.includes(title)) {
      phaseTitles.push(title)
      detailByTitle.set(title, null)
    }
  }

  const phases: WorkflowPhase[] = phaseTitles.map((title) => ({
    title,
    detail: detailByTitle.get(title) ?? null,
    steps: steps.filter((s) => s.phase === title),
  }))
  const unphasedSteps = steps.filter((s) => s.phase === null)

  const orchestration = {
    usesPipeline: /\bpipeline\(/.test(body),
    usesParallel: /\bparallel\(/.test(body),
    usesLoop: /\b(?:for|while)\s*\(/.test(body),
    callsSubWorkflow: /\bworkflow\(/.test(body),
  }
  const dynamic =
    orchestration.usesLoop || ((orchestration.usesPipeline || orchestration.usesParallel) && /\.map\(/.test(body))

  return { phases, unphasedSteps, orchestration, agentCount: steps.length, dynamic, args: detectArgKeys(body) }
}

// Exposed for the unit test; also the per-file worker for listWorkflows.
export function parseWorkflowFile(content: string): { meta: MetaBlock | null; composition: WorkflowComposition } {
  const src = stripComments(content)
  const meta = extractMeta(src)
  return { meta, composition: parseComposition(src, meta?.phases ?? []) }
}

function scanWorkflowsDir(
  dirPath: string,
  source: WorkflowEntry['source'],
  projectId: string | null,
  projectName: string,
): WorkflowEntry[] {
  if (!fs.existsSync(dirPath)) return []
  const entries: WorkflowEntry[] = []
  for (const fileName of fs.readdirSync(dirPath)) {
    if (!fileName.endsWith('.js')) continue
    const filePath = path.join(dirPath, fileName)
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    let content = ''
    try {
      content = fs.readFileSync(filePath, 'utf-8')
    } catch {
      continue // unreadable file — skip rather than fail the whole scan
    }
    const { meta, composition } = parseWorkflowFile(content)
    entries.push({
      id: filePath,
      name: meta?.name ?? fileName.replace(/\.js$/, ''),
      description: meta?.description ?? null,
      whenToUse: meta?.whenToUse ?? null,
      example: meta?.example ?? null,
      path: filePath,
      source,
      projectId,
      projectName,
      mtime: stat.mtime.toISOString(),
      composition,
      parseError: meta ? null : 'Could not parse the meta block',
    })
  }
  return entries
}

export function listWorkflows(): WorkflowEntry[] {
  const globalDir = path.join(os.homedir(), '.claude', 'workflows')
  const results: WorkflowEntry[] = [...scanWorkflowsDir(globalDir, 'global', null, 'global')]

  for (const project of listProjects()) {
    if (!fs.existsSync(project.path)) continue
    results.push(
      ...scanWorkflowsDir(path.join(project.path, '.claude', 'workflows'), '.claude/workflows', project.id, project.name),
    )
  }

  return results.sort((a, b) => b.mtime.localeCompare(a.mtime))
}

// Build a claude-cli:// deep link that opens an interactive session at `cwd`
// with the workflow invocation pre-filled — NOT auto-run: the user presses
// Enter to start it (deep links deliberately never execute on their own).
// All variable content is URL-encoded into the query string, so paths/args
// never reach a shell command line — the safe counterpart to launch.ts's
// cmd-shim actions. Uses the natural-language form the Workflow docs
// demonstrate ("Run /name ..."), the most reliable way to get it to run when
// sent.
export function buildWorkflowDeepLink(cwd: string, name: string, args: string): string {
  const trimmed = args.trim()
  const prompt = trimmed ? `Run /${name} ${trimmed}` : `Run /${name}`
  return `claude-cli://open?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(prompt)}`
}

// Deep link that opens a session pre-filled with a prompt asking Claude to
// read the script and explain when/how to use it — the "understand this
// workflow" counterpart. Same URL-encoded, never-hits-a-shell construction as
// buildWorkflowDeepLink. The path is embedded in the prompt (encoded), so the
// session reads the real script rather than us trying to summarize it here.
export function buildWorkflowExplainDeepLink(cwd: string, name: string, scriptPath: string): string {
  const prompt = `Read the workflow script at ${scriptPath} and explain when I'd reach for /${name} and how to run it — give a concrete example invocation, what each arg does, and what it produces. Don't run it.`
  return `claude-cli://open?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(prompt)}`
}

// Deep link for authoring/editing a workflow in a session — opens the script
// at `scriptPath` with an instruction (e.g. "adapt it to: <goal>" for a fresh
// scaffold, or "help me modify it" for an existing one). Same URL-encoded,
// never-hits-a-shell construction as the other builders.
export function buildWorkflowAuthorDeepLink(cwd: string, scriptPath: string, instruction: string): string {
  const prompt = `Open the workflow script at ${scriptPath} and ${instruction} Follow the Workflow DevKit shape (export const meta = {...} plus agent()/pipeline()/parallel()/phase()). Don't run it.`
  return `claude-cli://open?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(prompt)}`
}

// Read a workflow script's full text for the expandable source view.
// Validates against listWorkflows() first — the renderer only ever hands back
// a path this module already enumerated, never a raw path.
export function readWorkflowSource(sourcePath: string): string {
  resolveKnownPath(sourcePath, listWorkflows().map((w) => w.path), 'workflow source')
  return fs.readFileSync(sourcePath, 'utf-8')
}

// Copy one workflow .js file into <target>/.claude/workflows/. Same
// conflict-refusing, known-good-path discipline as promote.ts, but a single
// file (not a folder) into a different subdir — hence not promoteCore.
export function promoteWorkflowToProject(sourcePath: string, targetProjectId: string): PromoteResult {
  const target = listProjects().find((p) => p.id === targetProjectId)
  if (!target) {
    return { ok: false, reason: 'target-missing', message: `No registered project with id "${targetProjectId}"` }
  }
  try {
    resolveKnownPath(sourcePath, listWorkflows().map((w) => w.path), 'workflow source')
  } catch (err) {
    return { ok: false, reason: 'source-missing', message: (err as Error).message }
  }
  if (!fs.existsSync(target.path)) {
    return { ok: false, reason: 'target-missing', message: `Target project path not found: ${target.path}` }
  }

  const destDir = path.join(target.path, '.claude', 'workflows')
  const destPath = path.join(destDir, path.basename(sourcePath))
  if (fs.existsSync(destPath)) {
    return { ok: false, reason: 'conflict', message: `"${path.basename(sourcePath)}" already exists in ${destDir}` }
  }
  try {
    fs.mkdirSync(destDir, { recursive: true })
    fs.copyFileSync(sourcePath, destPath)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}
