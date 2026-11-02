# Trajectory timing evidence

Progress facts retain only observed endpoint times, as integer Unix epoch
milliseconds. Each endpoint carries its source, source type, and fixed meaning;
the local `recordedAt` value is stored separately and is not an execution time.
Native events take precedence over retained-message recovery for shared
endpoints. Missing endpoints remain absent in storage and project as explicit
nulls. Tool call state and the native `executed` flag remain separate.

The focused suite exercises input/called/completed tool boundaries, assistant
start/streamed/completed boundaries (including usage-free messages), retry,
shell and verification times, numeric/decoded DateTime equivalence, source
precedence across hook/live/recovery ordering, stale recovery, reopen/replay
idempotence, recording-time rollback, and preservation of legacy row identity
and `at`. It also checks that pre-migration read-only trajectory and Radar
queries remain usable without adding the new column.

Verification commands for this increment:

- `bun test src/progress src/trajectory/read.test.ts src/observability/read.test.ts`
- `bun run verify`

No synthetic duration is calculated; persisted endpoints support later
database-backed interval queries without asserting that endpoints are
interchangeable.
