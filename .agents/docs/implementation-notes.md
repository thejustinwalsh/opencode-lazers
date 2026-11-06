# Implementation notes

Attach only relevant lessons to a task. These are reusable code findings, not a
mandatory task checklist. New lessons should come from observed work.

## Execution identity and market pricing

The execution provider and pricing source are separate. Resolve the native
model's market product through the evidence-backed rules in
`src/models/model-identity.ts`; preserve its execution provider, model and effort.
Label endpoint assumptions separately. Cover the product entry point with
relevant configured routes, including subscription routes; fixtures using only
the pricing provider do not exercise that boundary.

## Worker tools and trajectory time

Expose worker-facing tools to Code Mode (`codemode: true`). Registering progress
reporting as standalone-only made it unavailable inside `execute`.

Store trajectory times as Unix epoch milliseconds. Preserve native start/end
times when available; collection time is not a missing execution endpoint.

## Native child workspace routing

Pinned OpenCode 2.2.5 child creation inherits its parent's location even when
another location is supplied. For isolated execution, move the child, await the
queued native operation and check its actual directory before prompting.
Reuse `src/runner/native.ts` and its location-routing behavior tests.

## Concurrent SQLite first open

Configuring WAL can return `SQLITE_BUSY` immediately during concurrent first
opens despite the normal busy timeout. The existing connection setup in
`src/storage.ts` retries that configuration failure. Reuse it; do not turn this
into automatic replay of task writes after an uncertain commit. See the independent-process tests in
[submission result](spikes/007-retry-safe-submission.md).

## Isolated WebGPU test prerequisite

The runtime fixture mocks `.cache/lfm3-engine.js`, but Bun still needs that ignored
path to resolve. In a fresh worktree, prepare the pinned engine JavaScript with
`bun scripts/prepare-engine.ts` before the full suite; `bun run build:gui` includes
that preflight too. Reuse the child-process fixture isolation for runtime tests.
Keep this pitfall scoped to relevant WebGPU work.

## Native log coverage

OpenCode `Session.log` filters a shared aggregate sequence: ordered events can
have gaps and the sync watermark can exceed the emitted tail. A marker without
events provides no execution lineage. See `src/progress/native.ts` and the
[pinned Session contract](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session.ts).

## Resource ownership and live writers

Ownership rows identify resources, not whether their writers stopped. Preserve
uncertain setup resources across restart or cancellation until termination is
observed. Normal teardown follows observed shutdown. See the real-process and
reopen cases in `src/runner/retained-reverify.test.ts`.
