# LZ-173 canonical source integration

Canonical `main` now points to `1981d7aeb6f853d08091bf221661e9af84200547`.
Architect fast-forwarded the checked native integration branch, preserving
original `ddefc44` and `0b289721647eddafa8e5d9bba4f5ce2daf945811` ancestry via
merge `19d62a636dce45bae7c90259ba55414dbf19613e`. Native readback immediately
before landing showed only the Architect active, with no active implementers.
Existing modified/untracked review documents were preserved.

## Checks and integration repairs

Initial integrated strict checks and GUI/evaluation passed, but the Models and
Trajectory suite failed 24/286 tests. Its real failed log is preserved at
`/private/var/folders/tr/3_qw264x55z9g8391dqb7tb40000gn/T/opencode/lz173-integrated-checks-20261107.log`.

Root repaired only `src/webgpu/main.ts` and
`test/models-observation-ledger/fixtures/ledger.ts`, committing `1981d7a`:

- Defer the same PID/time-origin identity expression until main-only `setupMain`,
  avoiding eager browser `node:process` getter access without changing lease meaning.
- Derive the actual current attempts table DDL and remove the fixture's session
  uniqueness constraint instead of recreating stale 16-column DDL.

Both existing Luna read-only research lanes reviewed their respective fixes.
No new material regression was identified. The ledger review notes that separate
indexes/triggers are not preserved by this fixture rebuild; that limitation
predates this delta and is not a production-schema change. Reviewers reran no tests.

Root observed **329 pass / 0 fail / 3,290 assertions / 39 files / 27.66 seconds**
across integrated Models, Trajectory and all eight WebGPU files, plus strict
checks and GUI/evaluation. Root logs:
`/private/tmp/lz173-integration-repair-tests-20261107.log` and
`/private/tmp/lz173-integration-repair-build-20261107.log`.

Architect then actually ran the **canonical** `bun run build:gui`: build and
renderer-global-free evaluation passed. Log:
`/private/var/folders/tr/3_qw264x55z9g8391dqb7tb40000gn/T/opencode/lz173-canonical-gui-build-20261107.log`.

## Native source record and pending product observation

The existing `integrated` control recorded **task-level source integration** of
accepted original `0b28972` on `main`, head `1981d7a`, returning plan version 88.
No whole-plan acceptance, worker replacement, original idle proof or original
resource cleanup was claimed. Root can now drive the actual connected original
LZ-137 current-market estimate/UI probe at the quiet source/build boundary.

The separate `root-connected137-market-estimate` human requirement stays open.
All six actual retained generation-2 task/combined receipts remain passing and
all 72 isolated check-resource rows were removed; see
`lz173-generation2-native-task-verification-20261107.md`.

**Bookkeeping hold:** after task-level integration advanced plan version 87→88,
native readback records generation-2 operation
`e5c0d438-21c0-4b21-9039-ec9d246264f6` held on
`Retained verification owner, plan version or execution authority changed`.
Do not silently bypass that hold, discard receipts, create a replacement worker
or claim plan completion. It does not prevent Root observing the landed product;
native evidence follow-through must use supported controls after that observation.

LZ-175/176 reviewed-fulfillment calls were refused by the separate disposition
eligibility gap; neither disposition was recorded. That repair is not a pricing
dependency. Original LZ-174's scan-heavy candidate remains rejected unchanged.
