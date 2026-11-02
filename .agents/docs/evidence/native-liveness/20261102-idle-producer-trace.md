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

## LZ-63 source review concern to resolve

The returned `src/runner/artifacts.ts` now hashes every process environment value
as verificationEnvironmentIdentity(), and runtime holds adoption when it changes.
This is a broad freshness gate: unrelated credentials/settings can invalidate
passed checks. Review it against the roadmap's runtime-owned relevant
revision/generation policy and the user's rejection of evidence-fingerprint
ceremony before integration. Git candidate identity and canonical operation
idempotency are separate and remain valid. This concern is source-established;
no native false-invalidation outcome has been demonstrated.
