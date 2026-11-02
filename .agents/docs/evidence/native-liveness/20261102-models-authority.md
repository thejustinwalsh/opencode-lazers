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
