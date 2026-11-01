#!/usr/bin/env node
// On-demand report for the vault recall experiment (bounded, started
// 2026-08-09): did the notes the recall hook offered actually get READ?
// Reads scripts/vault-recall.log (the offer denominator) and scans each
// delivered session's transcript for Reads of the offered notes. The same
// numbers back the Knowledge view's scorecard block (vault:recall-scorecard).
//
//   node scripts/recall-scorecard.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.APP_ROOT = path.join(__dirname, '..')

const { computeRecallScorecard } = await import('../electron/recall-scorecard.ts')

const sc = await computeRecallScorecard()

if (sc.attempts === 0) {
  console.log('No recall attempts logged yet (scripts/vault-recall.log is empty or missing).')
  process.exit(0)
}

const days = sc.since ? Math.max(1, Math.ceil((Date.now() - Date.parse(sc.since)) / 86_400_000)) : 0
console.log(`Vault recall scorecard — since ${sc.since.slice(0, 10)} (${days} day${days === 1 ? '' : 's'})`)
console.log(
  `  attempts ${sc.attempts} · no-match ${sc.noMatch} · offers ${sc.offers.length} ` +
    `(${sc.delivered} delivered) · read ${sc.readSessions} · spend $${sc.spendUsd.toFixed(2)} · errors ${sc.errors}`,
)
if (sc.incompleteScans > 0) {
  console.log(
    `  note: ${sc.incompleteScans} read-0 session${sc.incompleteScans === 1 ? '' : 's'} had unparseable ` +
      `transcript lines — those reads are unknown, not absent.`,
  )
}

if (sc.offers.length > 0) {
  console.log('\nOffers (newest first):')
  for (const o of sc.offers) {
    const status = !o.delivered
      ? 'matched, never delivered'
      : !o.transcriptFound
        ? 'delivered, no transcript on disk'
        : o.readTitles.length > 0
          ? 'delivered → READ'
          : `delivered${o.markerSeen ? '' : ' (marker missing!)'} → not read`
    console.log(`  ${o.at.slice(0, 10)}  ${o.sessionId.slice(0, 8).padEnd(8)}  ${o.project || '?'} — ${status}`)
    for (const t of o.titles) {
      console.log(`      ${o.readTitles.includes(t) ? '✓' : '·'} ${t}`)
    }
  }
}
