# LZ-188 scoped audit — Models decisions, routes and market valuation

Task 81bfc58a-9375-4ad0-b2c2-d107f7ba92ad. Scope: `src/models/**`,
`src/runner/catalog.ts`, `src/runner/catalog.test.ts`, `test/models-panel/**`,
`test/models-chart/**`, `design/audits/**`. No LZ-183 managed-overhead work,
no pricing/visual acceptance change, no feature/layer addition.

## Audit record (durable, not checkout JSON)

- Baseline run `90d35b05-57c7-41fa-a3ad-4ded530a8d36` (phase baseline).
- Follow-up run `cc6dea81-ce98-4449-8dfd-e6dbffad1dab` (phase follow-up,
  baseline linked). Report bytes live outside the worktree in the LAZERS audit
  store; retrieve with `lz-get-audit`. No `design/audits/*.json` copies were
  made per current guidance.
- Filtered inspection used `lz-get-audit({runID: baseline, path:
"src/models/server.ts"})` and `path: "src/models"` plus caller grep for
  `nativeWorkerOptions`, `createModelsTaskValuationProvider` /
  `createTaskValuationReader` / `currentPriceIndexFreshness`, and
  `resolveDispatchRoute`. The scoped groups dispositioned below include
  `duplication/clone_groups/29`, `/51`, `/87` and `clone_families/23`.
  Raw Fallow totals are cited only for before/after scope; grouped
  dispositions below are the durable audit evidence.

## What changed (net simplification, behavior preserved)

1. `src/models/server.ts`: added `createPriceSourceSettingsStore`,
   `priceIndexFromSources`, and `authorizeDecisionRead` helpers.
   - The two `new ModelPriceSourceSettingsStore` constructions (task-valuation
     provider and RPC server) now share one Effect storage adapter factory
     with the same key derivation.
   - The two `nativeCatalogAccess` + `ModelPriceSourceSettingsSchema.parse` +
     `buildCurrentPriceIndex` blocks now share one helper returning
     `{settings, opencode, index}`; callers keep their own
     `freshness`/`sources` shaping. Readonly sources are copied to a mutable
     array only at the adapter boundary.
   - The four `ModelsDecision` handlers (`overview`, `rows`,
     `configurations`, `inspect`) now share one scope-check + `authorize`
     (`lz-read-model-decision`) + abort helper. Parsed schemas, decision-reader
     methods, output schemas, error text, and abort ordering are unchanged.
2. `src/models/dispatch-resolution.ts`: collapsed `decisionFromMapping`
   three-branch switch into one source lookup (`task-mapping` /
   `project-mapping` / `shared-mapping`) with a single
   `DispatchRouteDecisionSchema.parse`. Provenance, route, persona, and
   precedence in `resolveDispatchRoute` are unchanged.

No public export, RPC ID, schema, persisted-data, mapping precedence,
price-source ordering, refresh/freshness, cumulative-versus-additive
accounting, or catalog advisory contract change. `catalog.ts` remains the
native catalog adapter; cross-system callers in `src/trajectory/accounting.ts`
and `src/models/task-valuation.ts` are untouched.

## Result

- Dead code: total issues 276 → 276. Scoped `unused_export` / `unused_type`
  signals are public RPC/presentation contracts and were retained, not
  deleted (e.g. `decision-contract` schemas, `MODEL_PRICE_SOURCES` vocabulary).
- Duplication: clone groups 196 → 193, families 98 → 97, instances 433 → 425,
  duplicated lines 4173 → 4071, duplicated tokens 17130 → 16794,
  duplication 3.35% → 3.27%, files with clones 98 → 97, total lines
  124466 → 124435. Resolved in-scope families: server.ts decision-auth
  quadruple, price-settings pair, price-index pair.
- Health/complexity: `observation-ledger-read.ts` (`readCapture` cognitive
  119, `outputFromCapture` 70), `decision-read.ts` (`buildSnapshotData` 100),
  `task-valuation.ts` (`observedUsageEstimate` 40), and `server.ts`
  `registerModelsServer` size remain above thresholds. No function splits
  were made; splitting them would relocate ledger/decision/valuation
  branching without reducing total complexity and would risk retained
  recovery-gap and cumulative-accounting semantics. Left intact by design.
- Architecture/featureFlags: 0 issues, 0 flags in both runs.

## Finding dispositions

- Durable grouped dispositions linked to the follow-up run (append-only, via
  `lz-record-audit-finding`):
  - `.../duplication/clone_groups/29` → `fixed`.
  - `.../duplication/clone_groups/51` → `fixed`.
  - `.../duplication/clone_groups/87` → `fixed`.
  - `.../duplication/clone_families/23` → `fixed`.
  - `.../deadCode/unused_exports/10` → `retained` (decision-contract public
    schemas).
  - `.../deadCode/unused_exports/35` → `retained` (`MODEL_PRICE_SOURCES`
    vocabulary).
- Remaining scoped `unused_export` / `unused_type` / health signals were not
  dispositioned here and remain retained as public contracts or intentional
  complexity. No analyzer finding was suppressed and no code was moved
  elsewhere to manufacture improvement.

## Checks

- `bun run verify` (fmt, lint --fix, fmt, check): pass, no type errors, no
  lint problems.
- `bun test src/models src/runner/catalog.test.ts
src/trajectory/accounting.test.ts`: 235 pass, 0 fail across 23 files.
- `bun test test/models-panel test/models-chart`: 17 pass, 0 fail across 3
  files (after `bun run build:gui` to provide `dist/radar-layout-worker.cjs`
  for the panel vite config).
- `bun run build:gui`: pass, GUI bundle evaluates without a renderer process
  global.
- Dynamic/native entry points confirmed live and retained:
  `nativeWorkerOptions` callers in `src/models/server.ts` (catalog RPC),
  `src/runner/tools.ts`, `src/runner/catalog.test.ts`;
  `createModelsTaskValuationProvider` in `src/index.ts`;
  `createTaskValuationReader` in `src/trajectory/read.test.ts`;
  `resolveDispatchRoute` in `src/runner/runtime.ts`.
