# Retained recovery follow-through

Observed 2026-11-06. This supplements the earlier handoff; it does not establish
completion of the roadmap or of the live walkthroughs.

## Changes and verification

- Advice findings and implementation text have no character ceiling. Current
  `src/tasks/advice.ts` and its persistence/replay/reopen regression were checked:
  4 tests, 59 assertions pass. No new cap was introduced.
- Root isolated review tree: `/private/tmp/lz-native-log-contract-review`.
  Canonical source remains unchanged while implementors are active.
- Native log replay correction `08166cf` accepts increasing filtered event
  sequences and a synced watermark above the emitted tail. Marker-only replay
  still cannot prove an old worker idle. Focused suite: 68 tests, 357 assertions.
- LZ-156 candidate `b01121b` removes the unrelated integration-active prerequisite
  for an authorized nonempty native catalog. Independent Models checks pass;
  current market reference valuation remains separate LZ-157/158 work.
- LZ-138 original worker adopted Root restart/cancellation correction as
  `4cd8527`. Real live-child regression showed deletion of a still-written setup
  directory before the correction. Unknown termination now preserves resources
  as uncertain. Required suite: 559 tests, 7,446 assertions, 156.61 seconds.
  This result predates the additional dependency correction below.
- LZ-128 returned `8f142859b335fd0b742dcbd1dda71c98e925408f`.
  Registered renderer/main tests cover abort ordering, disposal, lost replies,
  replacement generations and window isolation. Root independently reran 11
  lease/main/runtime/decision tests, 57 assertions. Combined review-tree formatter,
  linter and typechecker pass. Inference preferences were not changed.
  Native Luna reviewer `ses_e502151b3ffeBPGscw9thFkXM4` subsequently found no
  blocking source defect and independently passed18tests/95assertions plus quality
  checks on that commit. Its verdict explicitly leaves native handoff unqualified.

## Blocking finding and actual action

The retained verifier tried to construct the entire combined plan artifact before
admitting target verification, then unconditionally required combined checks before
accepting the target. A retained first task cannot qualify when its own successors
are still queued. This affects the intended LZ-156 → LZ-157 → LZ-158 progression.

Root reported the concrete source finding through OpenCode Desktop. Architect
recorded advice revision 15 against LZ-138 and its owning Architect resumed the
same Luna Max worker `ses_28780d1d92544da880d3db3496c8a29d`. Native presence confirmed
that worker active at Unix milliseconds 1793951962271; LZ-128 was inactive after
returning its commit. Delivery alone was not treated as resumption proof.

The correction must permit independently qualified retained task acceptance and
normal dependent scheduling while retaining normal combined plan verification
and integration. A multi-node dependency regression is required. Do not fabricate
old activity certainty, clear unknown resources, or start a model turn merely to
obtain an idle observation for LZ-156.

## Native reload semantics

Root inspected Extensions → Plugins without activating Reload. The pinned native
`extension-plugins.tsx` handler calls both `host.reload(id)` and
`bridge.manager.reload(id)` (lines 135–139). That action alone does not establish
GUI-only replacement with an unchanged main provider. Root relayed the distinction
through Desktop; Architect must identify the renderer-only hot-update/reload path
before claiming the LZ-128 live gate. No switches or inference preferences changed.

[Pinned native handler](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/app/src/runtime/plugin/extension-plugins.tsx#L135-L139).
The combined staged GUI build completed and its bundle evaluated without a renderer
process global. This is build evidence, not live inference evidence.

Follow-through found a blocking source defect, superseding the earlier source-ready
assessment: normal installed-plugin Reload/watch replaces the main provider, while
window-local memory survives. Candidate8f14285 rejects the new provider epoch before
loading, even after the previous renderer positively disposes its model. Root added
the supported provider-replacement case to the registered runtime/main fixture in
the isolated tree. It fails with `The main-process provider changed; previous
ownership remains unproven`; log `/private/tmp/lz128-normal-reload-before.log`.
Architect withdrew production readiness and is reconciling the accepted task's
same-provider-only assumption through native tasking. Do not activate8f14285 alone
or invent a private reload path to satisfy the old live gate. Preserve the useful
same-provider tests, and correct/observe the actual supported lifecycle without
blindly clearing ownership or losing failed-disposal/other-window protection.

## Observed effort and overhead coverage

LZ-128's native busy/idle endpoints are1793948364178 and1793951814096:
57.50 minutes elapsed, including implementation/reasoning/tools/checks, not a
measure of active model computation. Durable cumulative usage at1793951813900
records input384025, output40690, reasoning110220, cacheRead19675136 and
cacheWrite0. Reported subscription cost0 is not current market value. The token
categories are recorded separately; reasoning must not be blindly added to an
output count that may already include it.

The separate reviewer `ses_e502151b3ffeBPGscw9thFkXM4` has no `runner_progress`
rows in the current project database. `src/models/valuation.ts` explicitly leaves
Architect/review/integration overhead unallocated. These observations do not prove
that the native host lacks usage data; they show missing LAZERS capture/attribution.
Root queued this finding through Desktop for Architect to reconcile with existing
recovery/measurement work, without expanding or delaying LZ-157/158. Relevant
managed-session hooks, task/plan attribution and indexed market valuation are
needed before claiming full-task cost. No manual token self-report or spend gate.

## Still unproven

- The dependency correction, its independent review and tests.
- Activation of the staged batch and an actual registered retained qualification
  of LZ-156 without an implementation rerun.
- Live GUI-only WebGPU reload under the same main provider; fixture coverage is
  not a native product observation.
- LZ-147 old-worktree cleanup, held independently from accepted product behavior.
- Connected Models Refresh consistency, reference costs, actual chart and model
  assignment interactions against the approved mockup (LZ-157/158).
- Remaining Tasks, Trajectory, Radar, recovery, live verification, audio and
  packaging work. Nothing here narrows the active roadmap to these repairs.

Temporary logs: `/private/tmp/lz-retained-final-required-tests.log`,
`/private/tmp/lz128-combined-review-tests.log`,
`/private/tmp/lz128-retained-models-combined-build.log`.
