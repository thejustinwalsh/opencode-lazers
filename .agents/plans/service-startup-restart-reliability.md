# Service startup and interrupted-worker reliability

## Priority and evidence

The Nov17 service restart incident takes priority over new panel, filter and
qualification dispatch. Their plans are temporarily paused, not cancelled;
active workers and useful commits remain retained. No worktree deletion, private
OpenCode database modification, blind service restart or isolated Desktop launch
is a repair strategy.

Driver evidence: `.cache/driver/service-restart-loop-20261117.md`. Independent
exit investigation: `.cache/driver/service-exit-evidence-20261117.md`. Missing
service starts, high RSS/CPU and plugin-loading spans are observations; the exit
mechanism and sender remain unproven. The inspected Jetsam victim was stickersd,
not OpenCode. A bounded read-only natural-exit observation is running; its actual
status and any missing attribution must be retained rather than guessed.

Source baseline4a84a08: every location constructs repositories, context/store/
runtime services and registrations before joining the project scheduler.
Progress registration starts reconstruction over retained attempts, including
terminal history. Location-scoped native inventories/fences may activate more
locations. Scheduler sharing already exists; many loading-plugin log lines can
be unchanged source re-resolution rather than fresh setup. Models pricing,
budget HTTP, Repomix and inference weights are not eagerly loaded by setup.

## Bounded demand-driven plugin startup

**Driver intervention ownership:** Justin assigned the external driver direct
development ownership of per-location startup and main-thread blocking Git,
filesystem and SQLite hot paths, including `src/index.ts`. Do not dispatch a
LAZERS worker into those areas. The earlier two-task authoring review was
interrupted before submission; no startup worker was submitted or dispatched.
Driver will supply changed files/commits for Architect composition. The outcome
and verification below remain required, not delegated duplicate work.

The driver repair owns entrypoint registration, project-service ownership and
background activation. Preserve cheap location-scoped tools/RPCs, authorization,
worker delegation restrictions, exact-generation source guards and options.
Heavy construction/reconstruction and native location fan-out should depend on
active durable obligations or explicit authorized requests, not retained checkouts
or terminal history. Cache and bound the minimal obligation lookup per project.
Historical repair remains available without eagerly hydrating all native context
on every startup; preserve current selection/read freshness contracts.

Share ownership across actual pinned loader generations with explicit compatible
identity and scope lifetime. Do not capture the first location's entire ctx in an
immortal singleton or close shared resources when just one participant retires.
Requests must use the correct current location configuration and permission.

Verification loads the real entrypoint through independent pinned source loaders
with1and45location contexts, many retained terminal attempts and no active work.
Compare operation counts for heavy constructors, native context/location access,
reconstruction, settings maintenance and registrations. Add one active obligation
and explicit reads, then prove exactly one drain, required location acquisition,
correct result/authorization and safe leader retirement/reload/closure. Measure
module preparation and setup separately; elapsed time and RSS are diagnostics,
not guessed thresholds. Include failure/retry and all-resources-released cases.

## Automatic same-attempt restart continuation

One systems feature owns automatic admission and the existing continuation path.
The user authorizes automatic continuation of genuinely interrupted admitted
implementation workers after service restart; not cancellation revival, replay
of tools, provider-error retries, retained-check reruns or cleanup certification.
Architect retains this lane and LZ-222 verification uncertainty. Automatic
continuation work must not alter the driver's startup or synchronous hot-path
changes. Coordinate same-file changes with delivered file lists; Architect owns
rebasing/composition, not moving-base worker rebase loops.

Reuse the journaled same-attempt/session/workspace/route/input lineage path,
XState transitions and exact owner/control-epoch fences. A matching interrupted
input plus current native eligibility must establish that continuation is safe;
if a missing public native observation is necessary, include its producer and
consumer work through linked coordination rather than pretending it exists or
silently dropping the user-visible outcome. Avoid needless requirements beyond
the safety of the existing explicit continuation policy.

Unknown historical experimental.idle is not evidence of zero background, but is
also not by itself a permanent prohibition on a newly authorized continuation.
Keep historical unknown truthful and separate continuation admission from
verification, acceptance and cleanup. Live execution, queued input, approvals,
owned processes/descendants or unresolved execution/effects must not be replayed
or declared settled. Native recovery may establish exact interruption settlement;
absence of a process or stale streaming-tool UI alone cannot do so.

Persist an idempotent recovery decision before one new continuation input and
reconcile delivery after another restart. Preserve dirty files and existing
paths. Repeated observations/restarts, two reconcilers and lost responses cannot
deliver duplicate continuation; cancellation/reassignment wins during awaits.
Expose a concrete actionable reason only when a genuine unresolved blocker
remains, and automatically reassess when new native evidence clears it.

Registered runtime/native tests cover an incident-shaped service replacement,
unfinished tool display, inbox-delivered boundary, repeated restart, delivery
ambiguity, active/surviving work and cancellation. Demonstrate same-attempt
continuation without an Architect issuing resume for each eligible interruption.

## Composition, overlaps and acceptance

Startup bounding and automatic continuation are independently useful outcomes;
keep their implementation and tests coherent, not split by internal steps.
Startup work can proceed without rewriting native settlement. Coordinate the
continuation writer with LZ-99's existing explicit-resume source and LZ-222's
native-settlement adapter. Preserve their useful commits; Architect owns rebasing
and composition. LZ-212 covers a different public work-lifetime lease/idle-eviction
contract and remains on its roadmap; it is not proof of service exit or a reason
to invent an unavailable SDK capability here.

Use bun run verify and relevant production-entrypoint/runtime regressions, then
combined checks on the composed candidate. Diagnosis must preserve a measured
exit mechanism and supported attribution, or the precise remaining evidence
gap; instrumentation that has not observed an exit is not an established cause.
Final incident closure needs bounded startup counts and a regular-instance
observation of eligible worker recovery, with loaded candidate identity and no
fictitious idle/resource receipts. A quiet, coordinated activation is separate
from building or accepting the repair. Resume paused feature dispatch only after
the reliability outcome is reviewed and its integration conditions are met.
