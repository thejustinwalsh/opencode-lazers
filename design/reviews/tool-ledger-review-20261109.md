# Tool ledger repair review — 2026-11-09

Reviewed `2004a76`, its callers and focused regression coverage. Independent run:
`116 pass`, `0 fail`, `1209 expect() calls` across the six named progress,
runner-store/roles and recovery-producer suites. No source, production database,
worker, native window or process identity was changed by this review.

## Corrections before further activation

1. **Ownership cache across stream discontinuity.**
   `src/progress/tool-observation.ts:14–31` retains successful and rejected session
   ownership reads indefinitely. `session.moved` invalidates an entry, but the
   failed/ended listener paths in `src/progress/native.ts:1107–1129` do not clear
   the cache. A move missed during disconnection can therefore admit observations
   into the old project/location or reject them in the new location. Clear or
   revalidate ownership across discontinuity; test a move whose event was missed.

2. **Promotion while a callback is active.**
   `src/progress/recorder.ts:1359–1368` promotes an unresolved local callback row
   to a native-call primary key. The wrapper still retains its original
   `ToolInvocation`. If a native before observation promotes the row before
   `endToolInvocation`, that terminal write can recreate the old local row. Resolve
   terminal writes through the preserved local UUID, including this interleaving;
   the existing promotion-after-completion test does not exercise it.

3. **Observed pre-final ledger schema lacks an additive migration.**
   A read-only `PRAGMA table_info(native_tool_calls)` on the existing project DB
   showed neither `context_call_id` nor `local_invocation_id`. The committed
   `RunnerStore` CREATE TABLE and recorder queries/inserts use both. CREATE TABLE
   IF NOT EXISTS alone cannot upgrade that already-created ledger. Add an
   ordinary, non-destructive schema migration with honest legacy defaults and
   verify reopening a fixture with the observed old schema. Do not manually alter
   production rows or invent historical local/native identities. Telemetry write
   errors must still not change the original tool outcome.

These are corrections to the existing contributor's repair, not separate product
tasks or a request to expand unsupported third-party Code Mode coverage.

## Bounded actual native observations

A read-only latest-500-row observation independently confirmed actual successful
hook/native records for Architect and general sessions with null attempt links,
and an assigned implementor with its original attempt link. Distinct
`lz-query-tasks` and `lz-verify-task` local invocations retain real outer execute
links. Native-call and local-invocation counts must not be summed as one unit.

The newest observed row was Unix `1794188938263`; the later read-only observation
was at `1794189500672`. Those historical successes do not establish operation of
the final committed writer against the observed old schema. No role-attributed
live failed row was established. Third-party inner calls, fetch and failures
caught before entering an owned callback remain explicitly unsupported.

After the existing contributor's corrections, inspect effective loaded locations
and a small set of fresh real rows. Do not blanket-reload all workers, manufacture
idle or failed-call evidence, or repeat the full audit solely for activation.

## Follow-up: corrections reviewed on 373e296

`373e296` addresses all three findings: stream discontinuity clears and fences
ownership lookups; callback terminal writes resolve through preserved local UUIDs;
and ordinary startup adds the two missing nullable columns without inventing
historical values. Review included the changed callers and focused regressions.

Independent focused execution passed **7 tests, 37 assertions**, covering both
active-callback terminal outcomes, invalidated ownership reads, failed/ended
streams with missed moves, old-schema close/reopen and retained Desktop logs.
The complete 122-test result remains the contributor's recorded broader check;
this follow-up did not repeat every unchanged test.

At Unix `1794190114987`, read-only live inspection found both missing columns
present and fresh actual Architect, general and assigned-worker records. A real
parallel `lz-get-task` call produced three separate local-invocation rows linked
to the same outer execute, rather than collapsing them. The worker's actual
`lz-report-progress` callback also retained its real outer execute link. Thus the
corrected schema/writer is effective in observed locations; no extra reload was
needed. This does not establish every historical location or a live failed-row
observation. Existing native outcomes and unsupported inner-call boundaries
remain unchanged.
