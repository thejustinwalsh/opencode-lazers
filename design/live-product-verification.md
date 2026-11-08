# Live product verification implementation handoff

## Goal and delivery

Make implementers exercise their changes in the running product and make that
evidence part of runtime acceptance. Architect must establish a usable product
verification path before dispatching work that needs it. Implement the features,
durable data, project guidance and reusable skills required, then observe the
working flow live and walk through a couple of implementer verification attempts.

For LAZERS, launch a full OpenCode application instance containing the candidate
plugin and inspect the feature directly, as with any other application. A built-in
scripting environment can improve interaction, setup and inspection, but is not
a prerequisite. Native computer interaction and supported external tools can
supply the necessary observations.

Temporary fixtures are an authorized verification technique: create the scoped
fixture, exercise the real product, retain evidence, remove the fixture and
confirm cleanup. Fixture-driven observations must remain distinguishable from
ordinary production work. Keep useful evidence without shipping disposable setup.

Use the driving thread's native Architect and LAZERS execution workflow. Preserve
the existing roadmap, current attempts and acceptance gates, including proactive
recovery in `design/proactive-worker-recovery.md`. Architect owns decomposition,
dependencies and integration order after inspecting current source. This handoff
does not authorize replacing active work or treating existing native gates as met.

## Current foundation

Read `AGENTS.md`, `README.md`, `.agents/docs/task-authoring.md`, the pinned
`.agents/docs/opencode-api.md`, `.agents/docs/workspace-policy.md`, and the latest
`.agents/docs/handoff.md` and `.agents/docs/roadmap-execution.md`. Reinspect source
and runtime state; these entry points were reviewed on 2026-11-01.

- `src/task.ts`: acceptance currently links command verification, artifact
  references or human decisions. Artifact presence is not semantic proof.
- `src/runner/machine.ts`, `schema.ts`, `runtime.ts`, `store.ts`: current task
  lifecycle includes `verifying`; runtime handles receipts, repair, exact-artifact
  checks, integration and owned-worktree cleanup.
- `src/runner/host.ts`, `native.ts`: thin native adapters and workspace/session
  ownership. Reuse supported platform operations rather than adding a daemon.
- `src/progress/*`, `src/trajectory/*`, `src/observability/*`: durable execution
  facts, bounded evidence inspection and privacy filtering. Reuse these where
  appropriate; do not duplicate full native transcripts in new verification data.
- `src/architect.md`, `src/implementor.md`, `src/personas/ui.md`: current role
  guidance expects behavior evidence but does not provide a complete scheduled
  live-probe workflow or guarantee implementer access to the product.
- `.agents/docs/evidence/027-observation-panels/native-root-review.md` and
  `.agents/docs/evidence/trajectory-privacy/native-review.md`: examples of real
  native interaction, discovered defects, candidate repair and cleanup. Driver
  observations do not establish that implementers can perform those operations.

## Required product behavior

### Establish how the project proves work

Maintain one discoverable project verification runbook, using existing guidance
where it already serves this purpose. It must let an implementer launch the
actual product from its assigned candidate, prepare relevant state, interact with
the feature, inspect behavior, retain evidence and restore the environment.

Record the relevant product surfaces and platform, launch/build/install procedure,
services/configuration and fixtures, tool capabilities, readiness checks, candidate
activation method, test scenarios, evidence locations and cleanup procedure.
Keep credentials in the existing credential mechanism, not copied into guidance
or evidence. Tool configuration and reusable procedures should be executable
where useful, with concise prose for the remaining product-specific knowledge.

Architect selects task-specific scenarios that demonstrate acceptance. A smoke
that only launches the app is insufficient for a changed interaction, persistence
contract or recovery path. Required checks belong in acceptance, not merely
optional guidance. Pure documentation or other changes without an applicable live
surface may carry an explicit Architect-authored not-applicable reason.

Resolve material setup/tool gaps as prerequisite work. Reuse known working project
setup rather than repeating onboarding on every task. Validate capabilities in
the actual worker execution environment: a tool visible to the driving Codex
session is not proof of worker access, permission or successful native operation.

### Supply reusable skills and platform tools

Create or adapt a concise reusable product-verification skill that helps Architect
and implementers establish and use the project runbook. Follow the applicable
skill-authoring workflow. Discover existing native skills before adding duplicates;
install/package new skills so the intended OpenCode actors can actually discover
and load them. A Markdown file present only in this development checkout is not
delivery of a usable skill.

Keep shared verification judgment in a small core and load platform-specific
knowledge progressively. Reuse existing browser/runtime, native mobile and
Desktop tools where sufficient. Required capability and evidence enforcement
belongs in runtime contracts; optional skill suggestions do not become a new
mandatory skill-injection engine. Avoid expanding permanent role prompts into
another generic testing manual.

| Product surface            | Useful execution and inspection capabilities                                                                                                   | Example behavior to prove                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web application            | Candidate-specific app/services, browser interaction, console/network inspection, screenshots and optional runtime scripting                   | Change a setting through the real UI, reload, observe persistence and a relevant error path.                                                     |
| React Native application   | Native build/install/launch, simulator/device interaction, screenshots/logs, relevant permission and lifecycle control                         | Exercise the changed flow in the native app, inspect relevant keyboard/layout states, then background or relaunch when the contract requires it. |
| LAZERS in OpenCode Desktop | Full supported application instance with candidate plugin, native interaction and optional scripting/SDK inspection, real session/runtime data | Trigger the feature through Desktop, observe its real events/results, and compare visible UI with persisted task/session state.                  |

Implement a platform-neutral contract and a working LAZERS verification path in
this increment, with reusable guidance for web and React Native. Do not invent
unobserved web/mobile adapter guarantees or build three new automation stacks.
Identify which existing tools provide each capability, and any remaining gaps.

### Give the worker a usable running product

Support launching a full test instance using the host's supported launch/profile
mechanisms. Prefer separation from the driving Desktop instance so workers can
verify candidate changes without disrupting active user work or inference. Verify
the pinned host's actual isolation and activation capabilities before relying on
them. An existing instance can be reused when ownership, candidate activation and
safe access are established; full-instance launch must remain a usable path.

Record the actual candidate revision/artifact, workspace, application/profile,
backend/services and session/device target. Establish behaviorally that the
intended candidate is running. A successful build, reload acknowledgement,
source-file checksum or static preview is not proof of feature activation.

Coordinate shared devices, windows, profiles, ports and services with owned
reservations. Parallel coding can continue while access to one simulator or
Desktop window serializes. One worker must not change another's active instance,
test data, settings or installed candidate. Recover reservations after restart
without assuming the prior actor or its background processes have stopped.

Load `$portless-dev-servers` before launching or restarting any in-scope project
listening verification server. Use supported launch flows for third-party tools
and respect the skill's scope. Keep normal host tools available; do not require
an embedded scripting environment to make native interaction possible.

### Add a durable final live-probe phase

Expose this execution order in runtime state and inspection:

```text
implementation -> automated checks -> live probe -> accepted
                                          |
                                    repair or blocked
```

This may be represented as durable substates/phases of `verifying` rather than a
new top-level state, provided scheduling, visibility, restart recovery and
acceptance enforce it mechanically. Preserve old task records and snapshots;
define compatibility explicitly instead of silently rewriting historical tasks.

Implementers should perform the relevant product interaction themselves. The
runtime schedules and records the phase, grants appropriate owned access and
collects evidence through supported tools; it need not replace interactive
judgment with a shell command. If returning to an implementer session for probing,
preserve its identity/history where appropriate and distinguish implementation
completion from live-probe work. Avoid racing the existing idle-handoff behavior.

Run the probe against the relevant product after ordinary checks. Preserve each
observed result with its source, inputs and environment. Changes are context for
Architect review, not automatic expiry: Architect decides when changed behavior
needs a reprobe. Metadata drift, formatting and pending cleanup do not invalidate
a pass. Combine probes where integration can change behavior; do not repeat the
full product workflow after every edit.

Treat outcomes distinctly:

- **Passed:** the declared scenario produced the required observable behavior.
- **Failed:** the product behavior was wrong; return the specific failure and
  observations through ordinary repair/recovery handling.
- **Blocked:** launch, installation, device, permission, tool, activation or
  fixture setup prevented evaluation. Notify Architect without misclassifying
  infrastructure failure as a failed implementation or spending a repair attempt.
- **Not applicable:** a declared Architect decision explains why no live probe
  is required for this task. A worker cannot silently skip required evidence.

Keep cancellation, crash/reopen, ambiguous delivery and lost replies recoverable.
Use durable identities and current-version/ownership checks so replay cannot
launch duplicate instances, repeat non-idempotent setup or accept stale evidence.

### Retain meaningful evidence and support temporary fixtures

Persist a structured live-probe definition and run receipt, linked to plan/task,
attempt and relevant actor/session. Define the minimal schema during tasking.
It must identify scenario/assertions, candidate, environment, fixture/setup basis,
tool capabilities, relevant actions, observations, outcome/failure classification,
evidence references, cleanup state, and observed usage/timing when available.
Record producer provenance and distinguish tool observations, worker commentary
and Architect judgments. Schema validity does not certify semantic correctness.

Use the type of evidence the behavior needs: screenshots for rendered states,
interaction traces/results for controls, subsequent reads after reload/relaunch
for persistence, and runtime facts for backend effects. A screenshot alone does
not establish an interaction succeeded. Do not retain hidden reasoning, raw
credential-bearing logs, whole contexts or unrelated user data.

For temporary fixtures, runtime registers owned files/data/resources at creation
and runs teardown automatically. Cleanup is idempotent and reconciled after
interruption or restart. Fixtures may establish
test state, deterministic failure conditions or scoped diagnostic access; the
application under test must still execute the real changed behavior. Identify
mocks/stubs and which boundaries they do not prove.

Retain relevant observations before teardown, then remove the owned disposable
fixture and confirm cleanup. Keep reusable regression tests when valuable, but
do not ship temporary debug UI, instrumented bypasses or throwaway data as product
features. Fixture removal that changes executable behavior requires verification
of the resulting final candidate; pre-removal evidence cannot certify a different
shipped code path. Leave the product usable and unrelated work intact.

A failed probe still triggers cleanup. Cleanup failure remains visible and
retryable; it cannot revoke a product pass, block review/integration of valid
work, trigger implementation repair or require repeating a passed probe. It must
not permit another worker to seize a dirty shared environment. Track cleanup
separately and do not report it complete while owned resources remain.

### Integrate with proactive recovery and measurement

Publish probe events and classifications to existing progress/trajectory views.
Repeated behavior failures can supply struggle evidence. Environment/setup waits
remain separately classified. Reuse the proactive recovery contract for
Architect investigation and steering rather than adding a second supervisor.

Measure setup, waiting, probe, repair and cleanup effort where observable,
including Architect/driver assistance and attributable usage. Explain missing
data. Compare whether implementers can prove their work without the driver
performing every product interaction; do not infer savings from one successful
run or a lower number of tool calls.

## Acceptance and live walkthrough

Include the [recovery handoff and clarification addendum](recovery-handoff-contract.md)
in these walkthroughs where a probe fails or reveals a changed assumption. Reuse
the existing recovery flow and preserve handoff/review records in the DB.

Architect should decompose the implementation and map these feature-level
assertions into task and combined-plan evidence:

1. A project has discoverable, executable verification guidance and the relevant
   new/adapted skills are discoverable by the intended native Architect/worker.
   Required missing capabilities produce actionable prerequisite/blocked status.
2. Runtime persists a live-probe phase and structured receipts, gates acceptance
   on required evidence, and preserves historical task compatibility. Tests cover
   pass/fail/blocked/not-applicable, preserved results across metadata changes, cancellation,
   permission/ownership errors and crash/replay without duplicate side effects.
3. A LAZERS implementer can launch or acquire a full supported OpenCode application
   instance, activate the candidate, exercise its feature and inspect results.
   Record actual interaction/tool availability, target identity and observations;
   an API surface listing or driver-only success is insufficient.
4. Demonstrate scoped temporary fixture creation, live use, retained evidence,
   removal and cleanup confirmation. Include failed-run cleanup and a retryable
   cleanup-failure case in meaningful tests. Final evidence applies to the final
   relevant code after removal.
5. Observe at least two live executions of the implementer verification flow and
   walk through the records. Prefer useful real feature work. Include a successful
   path and a product failure or environment blockage followed by correction and
   reprobe. If no natural failure is available, use an explicitly labelled
   disposable fixture; do not manufacture or misreport a production incident.
6. Distinguish implementation attempts from probe runs: repair/reprobe may retain
   the same worker attempt. Do not spawn a replacement solely to satisfy a count.
   The walkthrough identifies request/acceptance, setup/instance, actions and
   evidence, outcome, assistance, repairs, final status and cleanup for each run.
7. A final native observation confirms the integrated workflow is usable, with
   evidence of the real phase transitions and product behavior. Report any branch
   covered only by fixtures and any still-open native gate explicitly.
8. Run meaningful Bun behavior/runtime durability tests, native formatting,
   linting and strict typechecking, and appropriate combined integration checks.
   Builds/static previews do not substitute for the required live observations.

Deliver the working feature/data/skills, project runbook, retained walkthrough
evidence and concise findings: what implementers could verify themselves, where
the driver intervened, defects found through live use, total observed effort and
remaining tool/platform limitations. Complete review, normal runtime integration
and owned cleanup. Retain broader cross-platform claims as unproven until those
platforms have their own observations.
