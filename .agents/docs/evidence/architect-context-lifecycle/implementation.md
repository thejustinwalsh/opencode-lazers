# Architect lifecycle implementation evidence

Task: LZ-28 (`239f45a9-3247-4cba-b339-19c8267d0800`). This records automated
implementation evidence only; it is not native Desktop dogfood or acceptance of
the live-session behavior.

## Automated lifecycle coverage

`src/runner/runtime.test.ts` covers the default 30-minute threshold, a configured
override, reuse before the threshold, and busy-session reuse. It asserts one
successor with the predecessor parent link, preserved model/variant, a labelled
small handoff, exact wake-text byte count with token/cache usage left unknown, and
worker sessions continuing unchanged. It also covers a shared successor for all
plans owned by one Architect and concurrent schedulers.

Deterministic prompt/outcome races cover input before transfer, during native
creation, during archival, and on the reserved successor; they also cover an
outcome before transfer and an outcome admitted during archival. Assertions check
stable IDs, suppressed/retargeted notices, current ownership, and predecessor
restoration. Archive failure is visible and retries the same successor. Reopen
recovery resumes a durable transfer without recreating the successor or changing
workers. Recovery without input-observation support rolls back and does not
archive. `src/runner/store.test.ts` covers migration away from the old unique
continuation-session constraint.

## Verification run

After the final source changes:

- `bun test` — 387 passed, 0 failed across 75 files.
- `bun run verify` — formatting, lint, and typecheck passed.
- `git diff --check` — passed.

The GUI suite requires the ignored pinned engine artifact; it was prepared with
`bun scripts/prepare-engine.ts` before the full test run.

## Still required: exact-artifact native dogfood

No live Desktop observations are claimed. Root must test the exact committed
artifact for busy reuse, idle renewal, visible/inactive predecessor, routing to
the current owner, input arriving during renewal/archive, and unchanged worker
sessions. Wake bytes are measured from the exact handoff text. Wake-attributed
tokens and public cache read/write categories remain unknown until a native public
observation provides them; cumulative session totals are not wake-attributed, and
no cache hit or savings claim is made.
