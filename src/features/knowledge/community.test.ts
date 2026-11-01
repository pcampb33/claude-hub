import test from 'node:test'
import assert from 'node:assert/strict'
import { CLUSTER_PALETTE, CLUSTER_PALETTE_LIGHT, isLightColor, parseColor, tintCluster } from './community.ts'

test('light palette is index-aligned with the dark one', () => {
  assert.equal(CLUSTER_PALETTE_LIGHT.length, CLUSTER_PALETTE.length)
  assert.equal(tintCluster(CLUSTER_PALETTE[3], true), CLUSTER_PALETTE_LIGHT[3])
  assert.equal(tintCluster(CLUSTER_PALETTE[3], false), CLUSTER_PALETTE[3])
  assert.equal(tintCluster('#123456', true), '#123456')
})

test('parseColor and isLightColor read theme tokens', () => {
  assert.deepEqual(parseColor(' #fff '), [255, 255, 255])
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), [1, 2, 3])
  assert.equal(parseColor('var(--x)'), null)
  assert.equal(isLightColor('#ece6fb'), true) // Clay --bg-base
  assert.equal(isLightColor('#2e3440'), false) // Nord --bg-base
  assert.equal(isLightColor(''), false)
})
