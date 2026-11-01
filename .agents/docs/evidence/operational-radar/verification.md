# Operational Radar verification

## Checks

- `bun test src/observability src/progress test/observability test/progress` — 46 tests passed across 10 files (422 assertions).
- `bun test` — 421 tests passed across 82 files (3,947 assertions). The pinned GUI engine was prepared with `bun scripts/prepare-engine.ts` after the initial run found its ignored generated cache missing.
- `bun run verify` — formatting, lint, and TypeScript checks passed.

## Behavior exercised

- `src/observability/read.test.ts` asserts exact Project and Session session-ID sets for default and opt-in inventory, keeps unmanaged sessions labeled and foreign-project IDs excluded, follows verified Session ancestry, and marks missing, archived, and moved sessions stale.
- The Radar route/flow fixture distinguishes configured route A, selected route B, and step-observed route C. It checks event/effect/message evidence, timestamps, tool-call/result edges, duplicate and recovery coalescing, reconnect history not replaying as live, and distinct persisted/admitted/consumed/unknown outbox stages. Structural dependency and architecture edges remain non-live with no delivery stage.
- A 10,001-row progress fixture puts a coalesced model step at the first retained row of the newest 5,000-row window. Radar keeps the model request/response pair and following tool call/result in chronological order, with exact event evidence; `progressTruncated` remains true.
- Deferred old-scope responses are rejected by `ObservationSyncState`; status reads make no native-context calls and leave SQLite `data_version` and execution/progress table counts unchanged. A private tool-result canary is absent from the Radar response.
- `src/observability/native.test.ts` checks public metadata mapping, foreign-project filtering, archived inventory, fixed inventory/page limits, repeated-cursor termination, abort propagation, and missing-session/error behavior. `test/observability/registered.test.ts` checks RPC default scope, permissions, and cross-project denial.
- `src/observability/changes.test.ts` checks fingerprint invalidation for progress inserts/updates and continuation/outbox inserts/updates.
