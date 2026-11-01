# Vault Linker — weighted, LLM-computed edges for the Knowledge graph

**2026-10-31: the daily 04:30 job is unregistered** (recall never reads the
edges; see the `link-vault.mjs` entry in `docs/automation.md` for why and how
to restore). The per-note paths below still run.

**Status:** Phase 1 built + verified in the real app (2026-07-09) — sidecar
storage, whole-corpus backfill, merged weighted rendering. **Phase 2 SHIPPED
2026-07-17** — incremental per-note linking (`electron/vault-linker-run.ts`):
fired non-blocking from inbox approve/quick capture, `vault:recomputeLinks`
IPC + Knowledge Relink button, `link-vault.mjs --incremental` as the daily
04:30 scheduled catch-all, mtime state + backfill adoption. First sweep
caught up 110 notes the vault had grown since Phase 1 (edges 41 → 333).
**Decided 2026-07-09.** **Materialized Related blocks added 2026-07-18** —
every linker run now also renders the sidecar edges into each note body as a
marker-delimited `## Related` `[[wikilinks]]` section (`vault-related-core.ts`,
backfill via `scripts/materialize-links.mjs`) so Obsidian/humans see the graph
in the files. All hub body-parsers strip the block, so materialized links never
count as authored edges or backlinks, never reach a link prompt (no self-feed),
and never pollute drain excerpts; the linker's mtime state is advanced for
in-sync notes it rewrites, so block upkeep never re-queues LLM calls.

## Goal

Turn the Knowledge-vault graph from mostly-disconnected cards into a weighted web
by **computing** the edges with an LLM. Each edge carries a `weight` (0–1,
connection strength) and a `kind` (`causal` / `generalization` / `see-also`). The
living-web graph renders weight as edge thickness/opacity.

## Why LLM, not embeddings (the decision — don't relitigate)

Embedding cosine-similarity measures **topical/vocabulary overlap**, which surfaces
the *obvious* same-topic edges you already see via project-color clustering, and
**misses the valuable cross-domain edges** — e.g. `speed-floor → CTD` (the
velocity-hook built to beat the synthetic-input speed floor *caused* the crash;
near-zero vocab overlap between "input injection" and "crash debugging"). An LLM
understands causation/generalization, so it catches those. It also:

- reuses the existing `claude -p` machinery — **no new ML dependency** (embeddings
  would need an API key or local Ollama, which underperformed per the vault's own
  "Local LLM digestion benchmark" note);
- fits the **automate-or-nothing / hands-off** principle (runs at curate time on
  new notes) rather than a hand-maintained link set that decays.

Weights should be *computed*, never hand-authored (subjective, decay). If the vault
ever grows past a few hundred notes, revisit embeddings as a *scale* play for the
obvious-similarity base layer, with the LLM still supplying the cross-domain edges.

## Current state (2026-07-09)

- Vault just consolidated **69 → 42 notes** (dup clusters merged; 27 originals in
  `C:\projects\claude-hub-vault\_archive\`).
- Graph is sparse: skyrim-agent 21, claude-hub 16, bladesbanter 2. Edges today come
  only from the handful of hand-authored `[[wikilinks]]` (the architecture core;
  `Local LLM digestion benchmark ↔ agent evaluation harness`).

## Codebase facts (so you don't re-derive them)

- `shared/ipc-types.ts`: `VaultGraphData = { notes: VaultNote[]; edges: { source: string; target: string }[] }`.
  `VaultNote` = `{ id, title, excerpt, outgoingLinks, backlinks, mtime, project }`
  (`id` = filename without `.md`, which is also the `[[link]]` title).
- `electron/vault-graph.ts` `getVaultGraph()`: scans **top-level** `*.md` only
  (`readdirSync`, excludes `index.md` + `_inbox.md`); edges = resolved `[[wikilinks]]`
  from note bodies (dangling links dropped); `project` from `project:` frontmatter or
  `deriveProject(body)`. Also exports `readVaultNote(id)`.
- Renderer: `src/features/knowledge/LivingWebGraph.tsx` (Canvas force-sim),
  `community.ts` (cluster detection), `useVaultGraph.ts` (data hook), `index.tsx`.
- Vault path: `C:\projects\claude-hub-vault`.
- **Reuse the curate `claude -p` machinery:** `scripts/curate-session.mjs`
  `callClaude(model, prompt)` = `execFileSync('claude', ['-p','--model',model,'--output-format','json'], { shell: true, input: prompt })`, unwrapped via
  `extractResultFromJsonOutput` + `stripCodeFence` in `electron/curate-core.ts`.

## Design

### Storage — sidecar `_links.jsonl` (recommended; confirm before building)

`C:\projects\claude-hub-vault\_links.jsonl`, one JSON object per line:
`{ "from": "<note id>", "to": "<note id>", "weight": 0.0-1.0, "kind": "causal|generalization|see-also" }`.
Keeps notes as clean, Obsidian-compatible markdown; fully recomputable without
touching note bodies; the graph just merges it. Add `_links.jsonl` to
`vault-graph.ts`'s excluded set. *Alternative rejected:* weighted frontmatter in
each note — non-standard, Obsidian can't read it.

### Compute — whole-corpus backfill, per-note incremental later

- **Backfill:** ONE `claude -p --model sonnet` call containing all 42 notes' full
  content (~21K tokens) → returns the whole edge set. Global consistency, catches
  cross-domain links, ~1 call.
- **Incremental (Phase 2):** per new/changed note, one call against the vault index
  (titles + excerpts) → that note's edges; merge into the sidecar.

### Edge model

- Widen `VaultGraphData.edges` to `{ source, target, weight, kind }`.
- Hand-authored `[[wikilinks]]` → `weight: 1.0`, `kind: 'authored'` (authored = the
  strongest signal, always kept).
- Merge computed edges from `_links.jsonl`. Dedup a pair to a single edge (prefer
  authored; else max weight).
- Renderer: weight → edge opacity/thickness. `kind` → edge color (defer to later).

## Phase 1 — the visible slice (build this first)

1. `electron/vault-linker-core.ts` (+ `vault-linker-core.test.ts`):
   - `buildLinkPrompt(notes: { id, content }[])` → whole-corpus prompt: propose
     weighted edges between these notes; **only real connections** (a note may have
     zero — do not force density); `weight` 0–1; `kind` causal/generalization/see-also;
     output `{"edges":[{"from","to","weight","kind"}]}` only.
   - `parseLinkOutput(raw, validIds)` → `{ from, to, weight, kind }[]`: JSON-parse
     (reuse a `stripCodeFence`), validate `from`/`to` ∈ `validIds`, clamp weight to
     [0,1], whitelist `kind`, drop self-loops, dedup. Malformed edges dropped, not
     thrown (same discipline as `evaluateReviewOutput`).
2. `scripts/link-vault.mjs`: read all top-level notes → `buildLinkPrompt` →
   `callClaude('sonnet', ...)` → `parseLinkOutput` → write `_links.jsonl`. Electron-free
   imports need explicit `.ts` extensions; derive `APP_ROOT` from the script location;
   log to `scripts/link-vault.log`.
3. `electron/vault-graph.ts` + `shared/ipc-types.ts`: read + merge `_links.jsonl`;
   widen the edge type; exclude `_links.jsonl` from the note scan.
4. `src/features/knowledge/LivingWebGraph.tsx`: map edge weight → opacity/thickness.
5. Run `node scripts/link-vault.mjs`; screenshot via `scripts/screenshot-app.mjs` to
   confirm the weighted graph renders. **Verify gate:** `npm run lint && npm run typecheck && npm test` all exit 0.

## Phase 2 — hands-off (after Phase 1 is verified in the real app)

- Incremental linker on the vault-write path (the approve step in
  `electron/vault-inbox.ts` / `vault-write-core.ts`, or a post-curate step): compute
  the new note's edges vs the index, append to `_links.jsonl`.
- Hub "Recompute links" button + IPC `vault:recomputeLinks`.
- mtime-keyed incremental cache so a recompute only re-links changed notes (pattern:
  `electron/floor-core.ts` verify-ledger / the skill-usage index).

## Open decisions

- Storage = sidecar (recommended; user was leaning yes — confirm).
- Rendering weight threshold (hide edges below X) — decide after seeing the backfill.
- Directed vs undirected rendering (store directed for `kind`; likely render undirected).

## Conventions

Electron-free logic in `*-core.ts` with colocated `*.test.ts`; add IPC types to
`shared/ipc-types.ts` first; feature-slice UI; scripts stay thin over tested core;
`claude`/cmd-shim calls need `shell: true` (no untrusted data in argv). Not done
until `npm run lint && npm run typecheck && npm test` all pass.
