# LZ-175 `c135109`: focused independent rereview

Prior Luna Max reviewer rereviewed exact
`c135109f29c333276cffa33278c77fc86b931b0a` against direct parent
`312dabd2873beb3d8a49e5dbdefab4c0b8b7ced0` and the original stored LZ-175
contract, read-only in `/private/tmp/lz175-binding-repair-20261107`.
Architect confirmed the clean exact HEAD/parent and inspected the two reported
native validation sequences. No tests were rerun by the reviewer or Architect.
Root reports seven race regressions fail on parent and pass corrected; declared
69 tests / 747 assertions / four files and formatting/lint/typecheck/diff/GUI/eval
pass. Root's broader runner checks remain separate supplied evidence.

## Previous findings resolved

- **Stale native owner at reservation:** `src/runner/runtime.ts:2552–2560`
  refreshes and validates `ownerSession` after the final repair-worker observation;
  the final command transaction also checks plan owner/version/revision/epoch.
- **Native owner invalidation during checks:** `runtime.ts:9463–9481` checks the
  native owner after task checks and repair observation, before acceptance. New
  regressions invalidate owner eligibility during admission and async check setup.
- **Late scope conflicts:** `assertRetainedVerificationScopeAvailable` runs again
  inside final reservation (`runtime.ts:3065–3070`), repeating attempt, adoption
  and retained-verification scans. A registered-command regression injects a
  competing attempt during native observation.

## Remaining finding: High — owner lookup can stale the worker observation

Reservation (`runtime.ts:2547–2560`) and acceptance (`runtime.ts:9463–9482`)
observe the repair worker, then await `host.session(owner)`. A new worker input,
foreground activation or route change can arrive during this final owner lookup.
The later reservation/acceptance guards check repair/effect metadata, Git and
durable plan/task state (`3049–3059`, `9530–9556`), not the newly changed native
worker state. Reservation or task acceptance can therefore still proceed with a
stale worker observation. This violates the existing new-input/foreground binding
boundary; the added owner tests do not discriminate this reverse race.

The final native validation must bind fresh worker and owner observations and
fail closed on changes across the asynchronous checks, without merely moving the
unfenced gap from one observation to the other. Add real registered-path deferred
regressions that change the repair worker's input during the final owner lookup
at **both admission and acceptance**. Admission must not reserve verification or
admit check resources; acceptance must not credit the candidate or clear the
original unknown-background/resource holds. Preserve existing owner-invalidation,
plan/epoch, scope, input and immutable-candidate protections.

## Preserved behavior and decision

Candidate checks remain bound to the new commit. The reviewer found no evidence
of old receipts satisfying new checks or background/resource holds being cleared.
Keep these properties; no exhaustive tree-content fingerprint gates or fabricated
idle evidence are authorized.

Root owns the bootstrap correction. Do not merge or activate `c135109` unchanged;
no competing LZ-175 implementation, original LZ-173/LZ-174 worker/source changes,
or production state edits. LZ-165 is already separately landed, live-observed and
natively cleaned. A corrected source review and Root's actual checks/live
qualification still precede normal LZ-175 disposition.
