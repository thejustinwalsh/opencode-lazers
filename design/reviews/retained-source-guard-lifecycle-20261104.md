# Retained source fence: lifecycle recovery boundary

## Current follow-up 5d485d13 — early-generation P1 repaired

Original native reviewer clears exact
`5d485d13d4e2a6dc7cdc57627a1cf372e66cc3b0`, retaining prior bounded runtime
clearance. Reservation is first plugin effect before options/database/ProjectIndex,
binding attaches only with actual hook installation, and installed capability
invalidates before hook teardown. Failed replacements cannot bless/resurrect a
borrowed predecessor; current generation, database and project checks fail closed.
Architect independently read the frozen paths. The full-plugin regression covers
borrowed A and early-failed B, with the demonstrated old-order red result retained.

[Combined bounded source assessment](retained-source-bootstrap-independent-20261104.md)
records the195/3102 passing completed receipts without a rerun. Real V2 routed
activation semantics remain confirmed. This clears the source P1, not old-child
containment, resource uncertainty, LZ88's prerequisite or live-native qualification.
Root retains installation ownership; no activation while workers are active.

## Final e699793 assessment: NOT source-clear, one generation P1

Both original reviewers completed. The runtime boundary below is clear, but native
review found a concrete full-plugin setup hole at exact
`e699793a3c04ff733c81ac7b5b0d3a456ac5b3f2`:

- `beginSourceGuard` reserves a generation only inside `registerWorker`
  (`roles.ts:19–22`). The plugin reaches it at `index.ts:105`, after repository/
  ProjectIndex creation and many fallible registrations (`40–104`).
- Pinned V2 permits a running step to retain predecessor A's borrowed graph while
  replacement B becomes routed. If B fails during ProjectIndex construction before
  reaching registerWorker, B never reserves a generation. A remains registry-current
  and installed (`source-quarantine.ts:70–80`).
- Healthy sealed recovery skips probing (`runtime.ts:2235–2240`) and exclusion can
  still succeed (`source-quarantine.ts:120`), despite replacement routing lacking
  the quarantine hook. Existing tests reserve B explicitly; they miss failure
  **before** reservation. Architect independently read these frozen source paths.

Root's minimal correction: reserve the location generation before preceding
fallible plugin setup, keeping reservation separate from actual hook lifetime and
invalidating capability before hook removal. Add the full-plugin borrowed-A /
early-failed-B regression: sealed exclusion must remain false. No new controller,
certificate, old-child containment claim or resource-release mechanism is required.
Root owns this fix; no edits or activation were performed in its tree.

Native review confirms the real V2 client forwards location, server middleware
demand-loads it and RPC awaits plugin activation. The callback attests its own
registration (`source-fence-rpc.ts:34–43`); native705–727 validates process/project/
location/database/token. Reachable initial/pending/sealed recovery and post-
reservation disposal/supersession protections are improvements, not a cure for
the earlier setup boundary above.

Root's exact merged run completed **194 tests / 3,081 assertions across seven
suites, 68.40s**, zero failures; log
`/private/tmp/lazers-bootstrap-lifecycle-merged-20261104.log` inspected for totals.
Root reports formatter/lint/types/diff pass and unchanged clean candidate. No
duplicate run occurred. These legitimate passes do not cover the new counterexample.

## Lifecycle candidate e699793: runtime review complete

The original runtime reviewer clears the bounded runtime boundary of exact clean
`e699793a3c04ff733c81ac7b5b0d3a456ac5b3f2`, finding no P1/P2 blocker. Initial
admission activates the guard; pending/sealed recovery restores it after scheduler
lease acquisition, revalidating request/assignment and installed enforcement after
awaits. Healthy sealed rows skip recurring native probes. Sealed restoration does
not replay archival; failed observations retain old holds. The original three
boundary repairs remain present. Architect independently read the frozen admission
and recovery paths at `runtime.ts:530–575,2222–2346`.

Deep native review is now complete with the P1 above; this runtime-only clearance
is retained without promotion to overall clearance. It is not native qualification,
resource settlement, or authority to activate while original LZ129 runs. Root
retains installation ownership.

## Earlier lifecycle assessment and proposal

Read-only follow-up to the independent cb6d447 review. Root owns implementation;
no edits to its tree, native calls, activation or resource release were performed.
Corrected clean candidate `79ceb78c063b49381c5a61c56029c3c2b6758295` is now under
the original two reviewers; its three boundary repairs and this lifecycle question
must be assessed together. This note proposes the narrow recovery seam, not a
claim that the candidate implements it.

## Observed lifecycle, not an archive-implies-unload claim

Pinned OpenCode V2 `9bbb8ce18c80f099e0e448775f59d965ead40a21`:

- `packages/core/src/session/session.ts:75–79`: archive publishes Archived; it
  does not itself unload location services.
- `packages/core/src/location-services.ts:54–56`: healthy locations have infinite
  idle retention. Explicit invalidation/replacement remains possible; borrowed
  running graphs can outlive routing replacement (`75–83`).
- Process restart necessarily loses the bootstrap's process-shared guard registry.
- `packages/server/src/handlers/rpc.ts:9–13`: location-routed RPC waits for plugin
  activation. Activation settlement alone does not prove LAZERS loaded successfully.

The cb6 source paths establish the trap: initial command guard check precedes its
worker read (`runtime.ts:456–457,530`); pending recovery does likewise
(`2258–2264`); sealed rows are not recovered (`2219`) but source exclusion requires
the old registration forever (`source-quarantine.ts:79–84`). Uncertain verification
can reconcile without visiting the worker (`runtime.ts:2427–2432,5026–5038`).

Stored-session get/archive are global operations, not proof of worker-location
activation. Full `nativeHost.session()` also performs location-scoped control reads
(`native.ts:123–132,362`), which can demand-load a location, but the guard checks
above can prevent reaching it. Merely loading does not prove hook installation.

## Minimal current-runtime enforcement proposal

Use a narrow location-targeted, read-only native fence capability probe before the
old-registration precondition. Reach it for initial admission, pending recovery
and sealed-row admission recovery through the existing scheduler, not another
controller or an indefinite location lease.

The callback must attest its **own live before-tool registration**, tied to the
current plugin generation, canonical database, project and exact worker location.
A registration somewhere in the root location is insufficient. Durable quarantine
still supplies request/attempt/session identity; the capability is ephemeral, never
a persisted successful-install bit or historical certificate. Revalidate both
bindings after asynchronous work and immediately before sealing/source exclusion.
Disposal, failed activation, missing method, identity mismatch and ambiguity fail
closed without dropping reservations.

A replacement generation cannot bless a known live unguarded predecessor graph.
Retain stopped/stable native-worker observations during recovery; do not infer that
the probe enumerates or contains every borrowed graph or detached old child. Native
before-tool fencing remains session-bound, including pending/sealed, stopped
assignments, agent switches and nested Code Mode calls.

## Discriminating lifecycle regressions

Exercise both pending and sealed states with an empty registry/restart simulation,
location eviction, delayed/failed/missing plugin activation, disposal during probe,
generation replacement, foreign database/project and a known live unguarded
predecessor. Successful exact-location rehydration restores genuinely independent
source admission. It must not replay an already observed archive or change old
checkout/check/shared-resource holds, uncertain effects, receipts, artifact scope,
LZ72 acceptance or LZ88's integrated-LZ72 prerequisite. Failure must retain them.

## Coordination

Independent frozen-79ceb78 checks completed: **189 tests / 2,974 assertions**, zero
failures, formatter/lint/typecheck/diff passing, and candidate unchanged/clean.
This is one check run, not a replay of Root's reported run. The original native
reviewer confirms explicit clear controls and dedicated worker archival repaired,
but retains this lifecycle P1. Exact corrected-candidate references:
`runtime.ts:457,2222,2261–2267,2439–2444,5044–5052` and
`source-quarantine.ts:20–22,79–84`. The reopen test manually reinstalls the guard
(`runtime.test.ts:827`), so it does not cover empty-registry recovery. Architect
independently inspected the frozen pending-selection and guard-precondition paths.
The second original reviewer also confirms all three repairs and the same remaining
lifecycle P1, adding the overlapping admission consequence at `runtime.ts:2515–2542`
and scoped registration disposal at `roles.ts:87–89`. Both reviews are complete.
No new worker or replacement recovery task is assigned. Root/Astra coordination is
required before eventual installation; this candidate remains offline.
