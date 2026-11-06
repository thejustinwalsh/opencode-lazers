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
