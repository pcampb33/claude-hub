import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { activeDayKeysFor, bucketMtimesByDay, scanChunkForDays } from './activity-core.ts'

const DAY_MS = 24 * 60 * 60 * 1000

// Noon on now's local day — a safe mid-day anchor to offset whole days from
// without tripping midnight boundaries.
function noonToday(nowMs: number): number {
  const d = new Date(nowMs)
  d.setHours(0, 0, 0, 0)
  return d.getTime() + 12 * 60 * 60 * 1000
}

test('bucketMtimesByDay: 14-day window, today lands in the last bucket (index 13)', () => {
  const now = Date.now()
  const days = bucketMtimesByDay([noonToday(now)], now)
  assert.equal(days.length, 14)
  assert.equal(days[13], 1)
  assert.equal(
    days.reduce((a, b) => a + b, 0),
    1,
  )
})

test('bucketMtimesByDay: 13 days ago lands in the first bucket (index 0)', () => {
  const now = Date.now()
  const days = bucketMtimesByDay([noonToday(now) - 13 * DAY_MS], now)
  assert.equal(days[0], 1)
  assert.equal(days[13], 0)
})

test('bucketMtimesByDay: files at or beyond the window edge are dropped', () => {
  const now = Date.now()
  const base = noonToday(now)
  const days = bucketMtimesByDay([base - 14 * DAY_MS, base - 30 * DAY_MS], now)
  assert.equal(
    days.reduce((a, b) => a + b, 0),
    0,
  )
})

test('bucketMtimesByDay: future mtimes (clock skew) are dropped, never overflow', () => {
  const now = Date.now()
  const days = bucketMtimesByDay([noonToday(now) + 2 * DAY_MS], now)
  assert.equal(
    days.reduce((a, b) => a + b, 0),
    0,
  )
})

test('bucketMtimesByDay: multiple files on the same day accumulate in one bucket', () => {
  const now = Date.now()
  const base = noonToday(now)
  const days = bucketMtimesByDay([base, base - 3_600_000, base - 2 * 3_600_000], now)
  assert.equal(days[13], 3)
})

test('bucketMtimesByDay: no mtimes yields all zeros', () => {
  assert.deepEqual(bucketMtimesByDay([], Date.now()), new Array(14).fill(0))
})

// Expected day key: local midnight of the timestamp, same arithmetic the
// scanner uses.
function keyOf(iso: string): number {
  const d = new Date(Date.parse(iso))
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function line(iso: string): string {
  return JSON.stringify({ type: 'user', timestamp: iso, uuid: 'u' }) + '\n'
}

test('scanChunkForDays: distinct local days dedup; same-day lines collapse', () => {
  const chunk = Buffer.from(
    line('2026-08-05T12:00:00.000Z') + line('2026-08-05T13:30:00.000Z') + line('2026-08-03T12:00:00.000Z'),
  )
  const { dayKeys, consumed } = scanChunkForDays(chunk)
  assert.deepEqual(
    [...dayKeys].sort(),
    [keyOf('2026-08-03T12:00:00.000Z'), keyOf('2026-08-05T12:00:00.000Z')].sort(),
  )
  assert.equal(consumed, chunk.length)
})

test('scanChunkForDays: only the top-level timestamp counts, not nested or absent ones', () => {
  const chunk = Buffer.from(
    '{"type":"mode","mode":"normal"}\n' +
      '{"type":"file-history-snapshot","snapshot":{"timestamp":"2026-08-01T12:00:00.000Z"}}\n' +
      line('2026-08-05T12:00:00.000Z'),
  )
  const { dayKeys } = scanChunkForDays(chunk)
  assert.deepEqual([...dayKeys], [keyOf('2026-08-05T12:00:00.000Z')])
})

test('scanChunkForDays: consumed stops at the last newline; a complete unterminated tail still counts', () => {
  const terminated = line('2026-08-05T12:00:00.000Z')
  const tail = line('2026-08-03T12:00:00.000Z').trimEnd() // valid JSON, no trailing \n
  const { dayKeys, consumed } = scanChunkForDays(Buffer.from(terminated + tail))
  assert.equal(consumed, Buffer.byteLength(terminated))
  assert.equal(dayKeys.size, 2) // re-scanning the tail later is idempotent, so count it now
})

test('scanChunkForDays: garbage and truncated lines are skipped; empty chunk is empty', () => {
  const { dayKeys } = scanChunkForDays(Buffer.from('not json\n{"type":"user","timestamp":"2026-08-05T12:0'))
  assert.equal(dayKeys.size, 0)
  assert.deepEqual(scanChunkForDays(Buffer.alloc(0)), { dayKeys: new Set(), consumed: 0 })
})

test('activeDayKeysFor: caches by size+mtime, unions appended days, never re-reads consumed bytes', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-activity-')), 's.jsonl')
  const first = line('2026-08-05T12:00:00.000Z')
  fs.writeFileSync(file, first)
  const days1 = await activeDayKeysFor(file, fs.statSync(file))
  assert.deepEqual([...days1], [keyOf('2026-08-05T12:00:00.000Z')])

  // Unchanged stat → cache hit (same Set instance, no read).
  const again = await activeDayKeysFor(file, fs.statSync(file))
  assert.equal(again, days1)

  // Rewrite the consumed prefix in place (same length, different day) and
  // append a new day. Only the appended bytes may be read: the prefix's new
  // day must NOT appear, the appended day must.
  const rewritten = line('2026-08-01T12:00:00.000Z')
  assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(first))
  const fd = fs.openSync(file, 'r+')
  fs.writeSync(fd, rewritten, 0, 'utf8')
  fs.closeSync(fd)
  fs.appendFileSync(file, line('2026-08-07T12:00:00.000Z'))
  const days2 = await activeDayKeysFor(file, fs.statSync(file))
  assert.deepEqual(
    [...days2].sort(),
    [keyOf('2026-08-05T12:00:00.000Z'), keyOf('2026-08-07T12:00:00.000Z')].sort(),
  )

  // Truncation resets the offset: a shrunk file is re-read from the start.
  fs.writeFileSync(file, line('2026-08-02T12:00:00.000Z'))
  const days3 = await activeDayKeysFor(file, fs.statSync(file))
  assert.deepEqual([...days3], [keyOf('2026-08-02T12:00:00.000Z')])
})
