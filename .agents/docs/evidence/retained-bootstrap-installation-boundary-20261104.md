# Retained recovery: first-installation boundary

The user authorized the bounded extension recorded at`0b9b178` in
[the existing57→58 amendment](retained-verification-amendment-20261104.md).
Read-only follow-through found **no safe non-overlapping admission seam** in the
installed runtime. Authorization resolves intent, not that installed capability.

## Reachability findings

- `RunnerStore.effectiveWriteScope` (`store.ts:2141–2150`) serves artifact
  authorization as well as reservation checks. Shrinking it to hide72 would change
  authorized scope, not safely release a separate writer reservation.
- `RunnerStore.attempts` (`2451–2459`) serves execution, cancellation and cleanup.
  Hiding72 or projecting a false state would corrupt lifecycle truth.
- Runtime selection (`runtime.ts:2274–2304`) and preparation/prompt admission
  (`2908–2963`) both directly compare scopes of preparing/running/verifying attempts.
  A new hold table without changing these consumers cannot unblock anything.
- Tools delegate to the closed runtime command schema. Host operations happen
  after selection; there is no writer-exclusion/quarantine host primitive.
  `index.ts:89–105,124–132` constructs concrete components without an injectable
  reservation-policy hook. Path-array conflict comparison lacks actor/owner identity.

Store/tools-only preparatory work could be admitted through LAZERS, but would not
be a complete bootstrap. Do not dispatch dead preparation as if it solved the hold,
monkey-patch the runtime, disguise old state or create a second controller.

## Required complete change and present limitation

The authorized control needs source-writing reservation facts separate from
effective artifact authorization, read by both admission gates with fenced
revalidation. It must establish writer exclusion, prevent later source writes,
retain72's verifying state/uncertain check and old mutable-resource quarantine,
and leave88's integration edge intact. Existing58 remains the independent
verification implementation, with distinct operation/candidate/context receipts.

Regressions must prove absent/stale exclusion still blocks; qualified exclusion
permits only safe isolated source work; resource holds/history/effects remain;
restart/replay/races fail closed; authorized scope stays unchanged;88 still waits.

The first complete wiring touches **LZ72-reserved`runtime.ts`**. Current native
commands cannot dispatch that initial edit under unchanged overlap enforcement.
Root/operator must supply a controlled first-installation route before that
boundary can advance. This note does not authorize direct Architect editing,
DB mutation, receipt fabrication, reservation bypass or a source-only acceptance.
No installation or implementation was performed by this research.
