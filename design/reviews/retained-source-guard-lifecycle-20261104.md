# Retained source fence: lifecycle recovery boundary

## Lifecycle candidate e699793: runtime review complete

The original runtime reviewer clears the bounded runtime boundary of exact clean
`e699793a3c04ff733c81ac7b5b0d3a456ac5b3f2`, finding no P1/P2 blocker. Initial
admission activates the guard; pending/sealed recovery restores it after scheduler
lease acquisition, revalidating request/assignment and installed enforcement after
awaits. Healthy sealed rows skip recurring native probes. Sealed restoration does
not replay archival; failed observations retain old holds. The original three
boundary repairs remain present. Architect independently read the frozen admission
and recovery paths at `runtime.ts:530–575,2222–2346`.

Deep native RPC/current-generation token review is still running. Root's merged
seven-suite result is pending; no tests were duplicated. This partial source
clearance is not native qualification, resource settlement, or authorization to
activate while original LZ129 runs. Root retains installation ownership.

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
