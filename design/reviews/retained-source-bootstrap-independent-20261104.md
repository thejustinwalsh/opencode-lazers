# Independent bootstrap review — cb6d447

**Not source-clear. Do not activate.** Reviewed exact clean
`cb6d447b9830184da6425439fe75fc7ea014048f` in Root's isolated bootstrap tree.
Two read-only reviewers examined native fencing and durable admission/replay;
Architect checked the cited frozen Git source independently. Tests passed
independently: **187 / 2,889 assertions**, formatter, lint, typecheck and diff check,
with candidate unchanged/clean. Those legitimate results do not cover the three
production-boundary blockers below.

## 1. P1: authoritative native clear controls are omitted

`runtime.ts:461–479` requires `pendingInput === false`, permissions0 and forms0
for quarantine admission/progression. The actual native adapter at
`native.ts:543–545` omits all three when clear. An ordinary idle native worker
therefore fails admission; runtime fixtures supplying explicit false/zeros conceal
the mismatch (`runtime.test.ts:503–506`).

Return authoritative clear values from the adapter only when observations support
them. Keep failed/unavailable/unstable reads unknown, not coerced to clear. Add a
native-backed regression through actual adapter-shaped session observation into
quarantine admission, including unavailable observations remaining blocked.

## 2. P1: retained worker archival uses Architect-only validation

The runtime archives the retained implementor via `host.updateSession` at
`runtime.ts:2271–2273`. Actual `native.ts:703–705` invokes
`assertArchitectTarget`, which rejects non-Architect targets (`193–195`). After
fixing clear controls, every tick still fails before native update and never seals.
Runtime mocks permit this incorrectly; existing native archive tests use Architect
targets rather than the retained implementor.

Provide exact assignment-bound worker archival authority using the recorded
project/session/task/attempt/workspace binding. Preserve Architect archival guards;
do not simply remove validation. Test the real native adapter path, foreign or
mismatched worker rejection and lost reply/readback/reopen behavior. Necessary
focused native/host adapter edits belong to this repair, not a new recovery engine.

## 3. P1: same physical checkout falls through for disjoint scopes

`source-quarantine.ts:87–89` returns false when the destination aliases the retained
checkout. `runtime.ts:3153–3183` then performs ordinary scope conflict logic, so a
disjoint scope can pass despite physical aliasing. In the existing real-workspace
test around `runtime.test.ts:617–644`, change the successor from shared.txt to b.txt
while its host returns the retained checkout or symlink: the new unquarantined
session can be prompted in the held checkout.

Physical alias/unavailable identity must be a **hard preparation denial** independent
of logical scope overlap—not merely failure to grant exclusion. Cover same checkout,
symlink and unavailable identity with disjoint scopes, retaining the positive truly
independent route. Keep recurring selection free of new synchronous filesystem scans;
actual preparation is the appropriate physical-identity boundary.

## Preserved assessment and boundaries

The session-bound native before-tool fence runs before assignment lookup, denies
unknown/source-capable tools, covers pending/sealed and agent switches/stopped
assignments, and uses scoped process-shared registration. Pinned V2 before-hooks
cover direct and nested Code Mode calls. This does **not** revoke already-started
operations or contain the old detached child. Do not turn that limitation into
either an invented proof or an unrelated universal OS-sandbox requirement.

Root retains implementation ownership. Return a new clean exact candidate with
the three regressions; no activation, canonical DB change, quarantine command,
acceptance override, effect replay or resource release occurred in this review.
Preserve LZ72 source/tests/uncertain check and LZ88's explicit integration edge.
