# Recommendation: Block LZ-143

I reviewed production at **`2e9a8dd6f74bfb231e0363ed87d5b2ad0ef9e155`**. The final candidate is **`71fbf4aa0a60b8f71cdbeb08b025e73e59edfba3`**, clean. The only intervening change is test-only: `src/runner/runtime.test.ts` now omits `reviewInputID` in the legacy fixture instead of passing it as `undefined`. Production files are unchanged.

## Blocking findings

1. **A review can change after admission checks but before the quarantine is persisted.**  
   In `src/runner/runtime.ts:1582-1615`, the worker and review are checked once, then the command awaits `worktrees()` and `ensureSourceGuard()`. The transaction at `1687-1726` rechecks plan version, assignment, and guard, but not the native review identity, foreground, route, or owner session. A changed input/tag/route during either await can therefore still create a pending quarantine and increment the plan version. Later processing may hold it, but the invalid admission has already mutated state.

   **Discriminator:** mutate the review input or tag from a barrier in `worktrees()` or `ensureSourceGuard()` after the worker snapshot. The command should reject with no quarantine row, plan-version change, or archive attempt. The current path can insert the row.

2. **Sealed review pins are not revalidated on guard recovery or when the guard is already installed.**  
   `src/runner/runtime.ts:4452-4457` skips any sealed, unheld quarantine with an installed guard. If the guard is missing, the recovery path reads no messages because `readOptions` is limited to pending running attempts (`4511-4515`); `sourceWorkerWait` checks review identity only when `requireCompletedForeground` is true (`561-576`). Recovery can thus restore the guard and clear the hold without confirming the pinned input/tag/route. `sourceReservationExcluded` then treats the sealed row as eligible (`src/runner/source-quarantine.ts:162-178`).

   **Discriminator:** seal a tagged review quarantine, change the current input or tag (or corrupt `review_input_json`), remove the guard, then reopen and restore the guard. It must remain held and not be excluded. Also test the sealed fast path with the guard still installed.

## Other acceptance observations

- **Native archive fence:** The production adapter in `src/runner/native.ts:918-1031` checks the durable pending row and pin, worker identity and foreground, route, and public archive readback. The connected-adapter tests call this real adapter with mocked native APIs; they are useful source-level evidence, not native deployment qualification.
- **Pin conflicts:** `runtime.ts:1698-1715` updates an existing pending quarantine’s request and review pin on a new command. The new request is journaled, so this is not silent in the history, but there is no test defining whether a distinct fresh command may supersede an existing pin. Add a discriminator or explicitly reject conflicting re-pins.
- **Migration/replay:** The additive nullable column and `NULL` legacy semantics look sound (`src/runner/store.ts:807-811`). The corrected test exercises the missing-column path by dropping the column before reopening (`runtime.test.ts:1147-1167`), though it is not a database created from the full `8acc55c` schema. Same-request fingerprint conflicts are handled by the existing command store.
- **Physical scope/resources:** Shared work is not excluded; known same/symlinked destinations are checked before preparation, and the reviewed tests cover those paths. Resource and uncertain-effect handling is kept separate from the pin. The stale sealed-pin recovery finding still blocks this boundary.
- **Review-input validation:** Reuse does not weaken `observeReviewInput`’s stricter idle gate. Static invalid-input checks are present; the missing admission barrier test is material.

## Precursor and verification evidence

The separate **`bf54cdd`** precursor removes the project-wide audit from selected full-plan detail and updates the tool description; project-wide inspection still includes the audit. That is a distinct, intentional behavior change from LZ-143, not LZ-143 scope drift. I found no additional regression in that change.

I read the candidate’s `.agents/docs/opencode-api.md`. I ran **no tests** and did not read or poll the compatibility log. Root reports a first full run of 568 passing and one fixture failure, a corrected migration test and quality pass, and a compatibility rerun still in progress. Those remain reported results; I do **not** treat the full suite as green. No runtime acceptance, native deployment qualification, or source release is established.
