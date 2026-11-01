import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LineDecoder, MAX_LINE_CHARS, encode } from './desktop-protocol.ts'

test('encode writes one JSON object per line', () => {
  assert.equal(encode({ t: 'data', id: 'a', seq: 1, d: 'x\ny' }), '{"t":"data","id":"a","seq":1,"d":"x\\ny"}\n')
})

test('decoder reassembles messages split anywhere, including mid-line', () => {
  const wire = encode({ t: 'data', id: 'a', seq: 1, d: 'héllo ❯' }) + encode({ t: 'exit', id: 'a', code: 0 })
  for (let cut = 0; cut <= wire.length; cut++) {
    const decoder = new LineDecoder()
    const messages = [...decoder.push(wire.slice(0, cut)), ...decoder.push(wire.slice(cut))]
    assert.deepEqual(messages, [
      { t: 'data', id: 'a', seq: 1, d: 'héllo ❯' },
      { t: 'exit', id: 'a', code: 0 },
    ])
  }
})

test('decoder holds a partial line until its newline arrives and skips blank lines', () => {
  const decoder = new LineDecoder()
  assert.deepEqual(decoder.push('\n{"t":"we'), [])
  assert.deepEqual(decoder.push('lcome","pid":7}'), [])
  assert.deepEqual(decoder.push('\n\n'), [{ t: 'welcome', pid: 7 }])
})

test('decoder throws on a malformed line so the caller can drop the peer', () => {
  assert.throws(() => new LineDecoder().push('not json\n'))
})

test('decoder refuses an unterminated line past the cap', () => {
  const decoder = new LineDecoder()
  assert.throws(() => decoder.push('x'.repeat(MAX_LINE_CHARS + 1)), /too long/)
})
