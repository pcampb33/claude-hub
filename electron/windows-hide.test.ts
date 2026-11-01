import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// A console program spawned without windowsHide from a parent with no console
// (the app launched any way but from a terminal) gets a console of its own,
// and Windows Terminal, the default console here, opens it as a visible window
// that takes focus. The user games while sessions run, so every child_process
// call in the main process hides its window. The exceptions open a window the
// user asked for: launch-core.ts (terminals, the editor) and any `start` call.
const VISIBLE_ON_PURPOSE = new Set(['launch-core.ts'])

// The argument text of each spawn/execFile/execFileSync call, found by walking
// balanced parens. The lookbehind skips methods (nodePty.spawn, RE.exec);
// comment lines go first, since they mention spawn() in prose.
function childProcessCalls(source: string): string[] {
  const calls: string[] = []
  source = source.replace(/^\s*\/\/.*$/gm, '')
  for (const m of source.matchAll(/(?<![.\w])(spawn|execFileSync|execFile)\(/g)) {
    let depth = 0
    let i = m.index + m[1].length
    do {
      if (source[i] === '(') depth++
      else if (source[i] === ')') depth--
      i++
    } while (depth > 0 && i < source.length)
    calls.push(source.slice(m.index, i))
  }
  return calls
}

test('every main-process child_process call hides its window', () => {
  const dir = import.meta.dirname
  const unhidden: string[] = []
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts') || VISIBLE_ON_PURPOSE.has(file)) continue
    for (const call of childProcessCalls(fs.readFileSync(path.join(dir, file), 'utf-8'))) {
      if (!call.includes('windowsHide') && !call.includes("'start'")) unhidden.push(`${file}: ${call.split('\n')[0]}`)
    }
  }
  assert.deepEqual(unhidden, [])
})
