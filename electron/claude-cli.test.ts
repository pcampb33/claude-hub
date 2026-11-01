import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertSafeArgs } from './claude-cli.ts'

// The spawn is shell:true, so this guard is all that stands between a future
// caller passing renderer text and cmd.exe interpreting it.
test('assertSafeArgs allows subcommands and plugin ids, refuses shell syntax', () => {
  assertSafeArgs(['plugin', 'details', 'frontend-design@claude-plugins-official'])
  assertSafeArgs(['mcp', 'list'])
  assertSafeArgs(['plugin', 'list', '--json'])
  for (const bad of ['a b', 'x&calc', 'x|y', '"q"', 'a^b', '%PATH%', 'a>b', '']) {
    assert.throws(() => assertSafeArgs(['plugin', 'disable', bad]), /Refusing/, bad)
  }
})
