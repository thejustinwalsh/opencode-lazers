# Models authority integration and native readback

2026-11-02. Original LZ-67 worker returned `24f87e0`; its native plan reached
accepted v13. Root reviewed the service, contract, native registration and Code
Mode surface, reproducing one cancellation defect before integration.

## Correction and landing

A cancelled Desktop configure request kept its detached native permission wait.
Granting it afterward wrote the route. The registered-handler regression failed
by observing the new mappings table after cancellation. Root `b6237f1` passes the
request signal through native session/permission reads and rechecks cancellation
before accessing the settings service. The corrected regression passes. No model
availability veto, route substitution, budget or new agent-role restriction.

Reviewed source merged as `ea188c2`, preserving `nativeContextPermission(ctx)` and
all existing Main repairs. Postmerge Models plus context: 26 tests, 240 assertions,
zero failures. All 515 files formatted, lint/typecheck/diff checks passed. The
original retained tree is clean and preserved until native landing/cleanup records
are reconciled; no manual task-state or acceptance writes were made.

## Real native observations

Read-only RPCs used the actual main Architect session, Sol High, in the canonical
project, against the unchanged service PID 7793. No model prompt, settings write,
service restart or inference setting change.

- Unix ms 1793641359170: `lazers.models.settings` returned in 10 ms. All three
  personas/layers correctly report unassigned; this observation created no route.
- Unix ms 1793641412556: `lazers.models.catalog` returned in 14 ms: 118 native
  options, 94 carrying native price metadata; advisoryOnly true. Configured
  implementor is exactly OpenAI `gpt-6-luna`, variant `max`.
- Session permission read after settings was empty. Architect still has queued
  scheduler/reviewer messages and is waiting at its existing retained-repair
  question; the read did not answer it or manufacture model input.

These qualify actual registration, authorization and output-schema compatibility
for native settings/catalog reads. Late-cancel write prevention, reopen, project
isolation, exact route/effort preservation, CAS conflict and inheritance are
covered by tests. Native guided mutation/editor interactions, persona routing at
dispatch, durable pricing/observed-efficiency/Pareto data and dated OpenRouter
fallback valuation remain unfinished. Native catalog prices are not claimed to
be the required fallback market index or subscription billing.

## Runtime reconciliation observed separately

At Unix ms 1793641180106 the stopped unwanted LZ-65 replacement had no permissions
or inbox. Its shared plan reached cancelled v581. The original LZ-63 worker also
cleared its index wait and resumed source correction. This is observed progress;
it does not retroactively qualify old detached scans as cancellable by the new
signal repair or establish resource deletion. Both retained trees remain intact.

## Architect integration and cleanup boundary

The Architect independently reviewed accepted `24f87e0` plus Root `b6237f1` and
confirmed both are already on Main through `ea188c2`; no duplicate merge occurred.
Own merged Models checks passed 10 tests/112 assertions plus fmt/lint/check/diff.
Native Code Mode `lazers_get_model_settings` returned all three personas unassigned
in the canonical project without changing routes. Root's broader RPC/context
observations above remain distinct from this additional Code Mode read.

Runtime recorded task landing at v14 and exact accepted combined-artifact
integration at v15, retaining artifact `24f87e051d635c41dfe7063b491d3c81a365d2c2`
rather than substituting the cancellation-corrected descendant. Normal non-forced
cleanup was requested; it reached **cleanup-blocked v16**: owned-worker activity is
not conclusively idle. The removal effect is uncertain, not completed.

Fresh native inventory at Unix ms 1793643713264 showed the original worker
succeeded, absent from foreground, with no permissions, forms or inbox. These
observations do not independently establish the additional background/turn fence.
The native worktree inventory still contains its original clean retained tree.
No forced removal, replay or manufactured background evidence was attempted.
Read-only diagnosis of the exact cleanup predicate is in progress.

The editor's code prerequisite is nevertheless satisfied: authority is reviewed,
landed, checked and integration-recorded. Its unstarted plan was rebased to Root's
`2e1d4e82155c8fda696ee5a9442ffcbaa5702bc3`, and its completed-code prerequisite was
removed from `afterPlans` so unrelated cleanup does not gate productive work.
Normal scope admission and the old resource reservation remain unchanged.
LZ-68 dispatched original attempt `dffe9628-84f2-42cc-8774-109a2c610717`.

Root owns local-inference runtime/lifecycle repairs and is coordinating GUI
activation and actual generation/Radar captures. The editor must not modify those
files or independently reload the driving GUI. Native editor interaction, exact
cross-surface mutation/readback and narrow/wide captures remain required.
