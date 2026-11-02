# Handoff reviewer — integration hold and narrow correction request

LZ-69 accepted artifact `75d3d67a53c38320a04cda94d0945fefb0b2c8a3` is already
source-merged as `00fbde6c02c863daa619463588052498a9ff16af`. The original retained
attempt is `20ac4537-f62a-46e6-bb52-fc9b9f22ff27`; its tree is clean at that exact
artifact. Do not duplicate the merge, task or worker. Runtime integration and
cleanup have **not** been requested because independent review found two blockers.

Own merged checks passed 28 tests/303 assertions plus fmt/lint/check/diff. These
checks do not cover the interleavings below. Reviewer
`ses_e627a81dbffe6k9adTYtUzDisG` performed source-only inspection, not native
inference or state mutation.

## 1. Return the exact reserved round after a late-result conflict

`src/recovery/handoff/review.ts:642–657` returns `recorded.rounds.at(-1)` when a late
inference loses an immutable-outcome race. That can return a newer draft/evidence
round's result to the original caller, including a pass with a different
fingerprint.

Discriminating regression: pause inference for the original reservation; recover
its expired lease and persist its interrupted outcome; finish a newer draft or
evidence round; then release the old inference. The old caller must receive only
the exact original reservation's validated outcome or an honest conflict, never
the newer round's result. Retrieve and validate that reserved round explicitly.
Preserve immutable outcomes, relevant source/contract/check bindings and late
authority revalidation.

## 2. Share the total round budget across authorized reviewer identities

`src/recovery/handoff/store.ts:450–457,543–550` partitions chain lookup by exact
reviewer identity. The source worker and current Architect can each reserve three
rounds for the same handoff/contract/checks under separate IDs. Same-actor ID reset
tests do not catch this.

Discriminating regression: use one persisted request/contract/check collection,
two authorized actors and distinct review IDs; alternate actors across reopen and
independent connections. Only three total semantic reservations may be consumed
for that chain. A fourth must not invoke transport. Keep per-operation reviewer
identity/audit records and authorization before private context, reservation or
inference; sharing the budget must not grant cross-actor permissions.

## Boundary and return

Request a coordinated narrow Root correction after the immediate Radar work;
there is no current runtime operation to resume an accepted attempt for repair.
Do not invent a retry task or replacement worker. Limit changes to the existing
handoff reviewer/store and focused regressions. Preserve existing task review,
H1/H2 history and all Root GPU/Radar work. No registration, finalization,
notification, native permission, inference or H3 walkthrough claim belongs here.

Return focused commits and discriminating red/green evidence for independent
review before runtime integration. Keep the accepted artifact, reviewed source
descendant and cleanup outcomes distinct; no forced deletion or product replay.
