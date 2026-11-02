# Remaining idle producer failure

2026-11-02 17:10 UTC. Service PID 7793 remains unchanged.

LZ-63 returned clean commit `56c2a94` (197 runner tests passing; dedicated
adoption suite 14 passing) and finished native execution at Unix ms 1793638760159. Its plan is still blocked at v20: the success event did not match
an experimental.idle observation. `70179aa` qualified cancellation recovery, not
this subsequent completion. Do not replay the completed implementation or invent
an empty background report.

The old diagnostic retained only the terminal mismatch. Input-read failure,
missing execution cursor, disposal and stream loss could be overwritten before
runtime inspected the result. No exact historical cause is established.

`1a5b2a8` adds automatic `native-observation` facts to the existing SQLite
trajectory store: listener identity/location, idle entry, input result/failure,
report sequence, terminal sequence, stream loss and disposal. Unix millisecond
timestamps and existing assignment identity bind the records. Errors use existing
credential redaction; diagnostics cannot change observation/acceptance authority.
A regression exercises an actual registered idle callback with a failing retained
input reader, then success, and checks ordered durable diagnostics, timestamps,
redaction and missing idle lineage. Final focused checks: 61 tests, 293 assertions;
formatter, lint, typecheck and diff checks pass.

Native readback already shows listener/location disposal records across loaded
locations. The next actual worker completion is needed to identify its preceding
producer path. No reproduction model task was launched for this.

Public session.log reads after 0 and after 3150 returned only log.synced at 3223.
Pinned core bus defaults event-payload persistence to false, so the API does not
establish historical hook behavior in this installation. Existing LAZERS progress
facts retain terminal/tool/step history; they did not retain the missing producer
path. Source: https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/bus.ts

## LZ-63 source review findings before integration

Candidate `56c2a94` is not cleared by this review.

1. **Native adoption cannot pass its activity guard.** `prepareAdoption()` calls
   `host.session(latest.session_id)` without detailed messages, then requires
   `pendingInput === false`, permission/form counts exactly zero, and current-turn
   background lineage. The actual native adapter omits absent flags/counts and
   omits `turn` on metadata reads. A normal idle native worker is therefore
   rejected, unlike the explicit mock values in the tests. Normalize optional
   absence consistently and obtain the detailed observation the guard needs;
   cover the real adapter contract. Preserve uncertainty/busy/input protections.
2. **Independent workers prevent adoption globally.** The same function rejects
   when any project attempt is preparing/running/verifying, before checking scope.
   Unrelated Models/Radar/resource work therefore prevents this operation.
   Reuse the existing relevant reservation/conflict predicate rather than
   stopping unrelated plans; test actual conflicting and independent work.
3. **Whole-Main scope comparison needs qualification.** It compares every change
   since the old artifact against this task scope. The intended use is a reviewed
   descendant already containing other legitimate merged work. Verify the
   existing reviewed-baseline accounting is preserved instead of rejecting
   unrelated integrated changes or requiring a broad artificial scope amendment.
4. **All-environment freshness hashing is too broad.** `verificationEnvironmentIdentity()`
   hashes every process environment value; runtime holds adoption when it changes.
   Unrelated credentials/settings can invalidate passed checks. Use the roadmap's
   relevant runtime-owned revision/generation policy. Git candidate identity and
   canonical operation idempotency remain valid and are separate.

Findings 1/2/4 follow directly from the returned source and native adapter contract;
no native adoption acceptance or false-invalidation experiment has been performed.
The scope case needs an actual reviewed-descendant regression. Correct the same
retained source; do not rerun the original stranded implementation workers.
