import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_ID, shortcutDetails } from './app-identity.ts'

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the Start Menu shortcut launches this repo through files that exist, under the app ID', () => {
  const d = shortcutDetails(repo)
  assert.equal(d.appUserModelId, APP_ID)
  assert.ok(fs.existsSync(d.target), d.target)
  assert.ok(fs.existsSync(d.icon), d.icon)
  const script = /"(.+)"$/.exec(d.args)?.[1]
  assert.ok(script && fs.existsSync(script), d.args)
})
