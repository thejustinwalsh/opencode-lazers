# Architect lifecycle implementation evidence

Task: LZ-28 (`239f45a9-3247-4cba-b339-19c8267d0800`). This records automated
implementation evidence only; it is not native Desktop dogfood or acceptance of
the live-session behavior.

## Retained-candidate finding and repair

Review of retained candidate `e127d1a5836b65ca6d89dd19974f94249e9df1ed` found
that queued synthetic input (`resume:false`) can bypass the prompt hook and arrive
after the last inbox check, leaving input on an archived predecessor. OpenCode
2.2.5 exposes no atomic public admission/archive barrier. The native adapter now
declares all-input admission safety unsupported, so automatic renewal does not
start on this host. Recovery of a persisted renewal checks queued entries and
rolls ownership back without archival when the barrier is unavailable; an inbox
snapshot is not represented as an atomic guarantee.

The Architect now explicitly records current conversation-only decisions and
unresolved questions. The structured checkpoint is persisted by project/session,
versioned, snapshotted into renewal state and the durable handoff, and included in
the successor wake without transcript replay or inferred summary. The tool is
restricted to the current Architect owner; the new database column migrates
existing stores safely.

## Automated lifecycle coverage

`src/runner/runtime.test.ts` covers the default 30-minute threshold, a configured
override, reuse before the threshold, and busy-session reuse. It asserts one
successor with the predecessor parent link, preserved model/variant, a labelled
small handoff, exact wake-text byte count with token/cache usage left unknown, and
worker sessions continuing unchanged. It also covers a shared successor for all
plans owned by one Architect and concurrent schedulers.

Deterministic races cover prompt input before transfer and queued synthetic input
after successor creation, after durable transfer, and during native archival.
Assertions check stable input IDs, inbox preservation, suppressed handoffs,
current ownership, and predecessor restoration. A process-reopen/two-scheduler
case preserves queued synthetic input, rolls back the handoff, and leaves the
predecessor unarchived; a test also proves that the native adapter does not claim
an admission barrier. Existing cases cover an outcome before transfer, an outcome
admitted during archival, successor input, visible archive failure and retrying
the same successor. Reopen recovery resumes a durable transfer without recreating
the successor or changing workers. Exact continuity decisions/questions are
asserted in the wake and across reopen. `src/runner/store.test.ts` covers legacy
database migrations for continuity and the old unique continuation-session
constraint.

## Verification run

These checks were run on the retained pre-repair candidate only; they are not
verification of the current repair:

- `bun test` — 387 passed, 0 failed across 75 files.
- `bun run verify` — formatting, lint, and typecheck passed.
- `git diff --check` — passed.

The GUI suite requires the ignored pinned engine artifact; it was prepared with
`bun scripts/prepare-engine.ts` before the full test run.

## Current repair verification

- `bun test` — 393 passed, 0 failed across 75 files.
- `bun run verify` — formatting, lint, and typecheck passed.
- Focused scheduler/reopen and legacy migration tests passed.
- `git diff --check` — passed before commit.

## Still required: exact-artifact native dogfood

No live Desktop observations are claimed. Since the pinned native adapter fails
closed, native idle renewal cannot currently be dogfooded on OpenCode 2.2.5; Root
must verify the exact artifact and resolve host support before treating renewal as
available. Other lifecycle behaviors still require Root's exact-artifact checks
for busy reuse, current-owner routing, input arriving during renewal/archive, and
unchanged worker sessions. Wake bytes are measured from the exact handoff text. Wake-attributed
tokens and public cache read/write categories remain unknown until a native public
observation provides them; cumulative session totals are not wake-attributed, and
no cache hit or savings claim is made.
