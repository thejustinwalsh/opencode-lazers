# LAZERS delivery audit and next phases

Observed 2026-11-01, 04:41 UTC. Audited source: 53a6e69. Runtime and source can advance after this checkpoint.

**Historical audit.** Counts, active work, defects and proposed ordering below
describe November 1, not the current runtime. Use the
[current handoff](handoff.md) and [roadmap delivery front](../../design/roadmap.md)
for present status. Preserve this audit as dated evidence, not current agent
instructions or a reason to recreate already-delivered work.

## Assessment

The execution platform works and has landed real product changes. We have not yet demonstrated the original mission of consistently affordable, minimally supervised feature delivery in a large existing application. The next work should close reliability and measurement gaps, then use the plugin on real application features. More orchestration machinery is not the goal.

This audit compares the [original brief](sources/original-design-brief.md), current source, all 30 task references, durable execution state, retained native evidence and fresh checks. It includes a reproduced read-side redaction defect. It does not certify every line or infer native behavior from mocked tests.

## Current delivery

- 15 integrated plans; 22 accepted task nodes; one running node/attempt: LZ-28 Architect lifecycle renewal. Two cancelled plans and six failed attempts remain in history.
- LZ-13 progress is integrated v16. A real lifecycle worker called lazers_report_progress successfully; exact call/message identity coalesced into one durable commentary fact. Automatic events are separately recorded. [Native proof](evidence/018-durable-progress/native.md).
- LZ-28 is actively editing its original isolated checkout with Luna Max; it is not merged or accepted. Root still needs to observe the returned artifact's renewal/input/archive behavior.
- LZ-14 renderer responsiveness remains failed. Instrumentation and debugger capture exist; the earlier freeze's root cause is unresolved. Preserve the enabled inference stack.
- LZ-11's cancelled route/persona work was replaced by accepted LZ-15. LZ-2 through LZ-6 have explicit superseded/rejected dispositions. These are historical records, not five more features to build.
- Fresh verification on this source: 376 tests, 0 failures, 3,449 assertions across 75 files; formatter, lint and strict types pass. [Command receipts](evidence/036-production-audit/checks.json) and logs retain the actual one-shot results.
- The prior package-content check included all exports and the built GUI. The package is still private, version 0.0.0. There is no fresh-machine installation or publication proof.

| Area                  | Implemented and observed                                                                                                                | Missing or underdeveloped                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task creation         | Strict schema, idempotent submission, project references, readable instructions, source/guidance fields, Architect self-review          | General task revisions are absent; specifications and plan nodes are fixed to revision 1. Broad interview/decomposition quality is not established by the original single-prompt trial.            |
| Execution             | XState task transitions, durable effects/leases/outbox, dependency/priority ordering, serial children and isolated parallel workers     | Unattended completion still needs proof across review, integration and ownership renewal. The recent avoidable question stopped continuation until Root answered.                                  |
| Integration           | Real artifact review/merge, combined verification, native non-forced cleanup with history retained                                      | Human PR review was deliberately delegated to Root. A configurable normal PR/human-review workflow is future delivery work.                                                                        |
| Context               | Repomix refresh, filtered snapshot reads, native isolated-worker reuse without recollection                                             | No measured token/time saving against ordinary discovery; no proven large-repository operating envelope. No generalized learning/memory retrieval service.                                         |
| Models                | Exact native routes, read-only catalog, three concise independent personas; Luna and Go/Qwen use observed                               | Model choice is plan-wide, not per node. No persisted guided route preferences or evidence-backed comparison/ranking.                                                                              |
| Research              | Architect can use normal code/web tools                                                                                                 | No registered runtime-managed investigator/researcher roles or research dispatch tool. The only lazers_research references are worker denials. Earlier README language overstated this capability. |
| Panels                | Live Tasks, grouping/dependencies, references, Radar Flow/Timeline, Trajectory, themed icons; real narrow/theme/navigation observations | Active trajectory reads/pagination need work. Scheduling controls largely remain Architect tools; compact task names/references and broader reconnect/font coverage need polish.                   |
| Trajectory            | Real attempts, failed work, checks, usage categories, activity; durable progress annotations/facts                                      | Read-side redaction defect below; complete execution intervals, whole-feature accounting and stable growing-history pagination are incomplete.                                                     |
| Local inference/audio | Existing WebGPU chat/decisions, schema/self-review, STT/TTS, final-prose replay/auto mode and diagnostics                               | Freeze root cause and hardware/soak coverage remain open. Local review's quality gain is unmeasured.                                                                                               |
| Distribution          | One package with server/GUI/RPC exports; native sessions/worktrees; no custom daemon                                                    | Fresh install, upgrade/recovery, release metadata/notices and host dependency compatibility work remain.                                                                                           |

## Findings that should change priority

### 1. Trajectory read-side redaction needs a focused fix

The new progress recorder omits arbitrary structured tool content, but the older trajectory projector still recursively copies tool inputs and parses tool-result JSON with safeText/safeValue.

Using the existing isolated temporary SQLite fixture, the real inspectTrajectory report retained three synthetic canaries: nested reasoning in tool input, nested reasoning in tool-result JSON, and a full input field nested in that result. The live application database was neither read nor modified by this reproduction.

Sources: [privacy projector](../../src/trajectory/privacy.ts), [native tool projection](../../src/trajectory/read.ts), [progress's narrower projection](../../src/progress/privacy.ts). [Reproducer](evidence/036-production-audit/trajectory-redaction-repro.ts) and [result](evidence/036-production-audit/trajectory-redaction.json).

This establishes a read-boundary defect, not an observed disclosure of real private data. Close it before expanding exports/sharing. Preserve useful visible code/prose, checks and ordinary safe argument summaries.

### 2. Responsiveness is not resolved by working GPU inference

LZ-14 is failed and the previous freeze remains unexplained. GPU execution can coexist with CPU/WASM/tokenization/allocation work. Existing diagnostics should identify the blocking stage before choosing an execution boundary or changing the engine. Do not silently disable inference or claim a worker migration already works.

The new audit did not reproduce another freeze. Separate Computer Use timeouts are not proof of an application freeze.

### 3. The live trajectory read path does unnecessary repeated work

[Panel state](../../src/trajectory-panel/panel-state.ts) refreshes every four seconds while connected and rereads the selected task report. [Trajectory inspection](../../src/trajectory/read.ts) retrieves retained native session context for attempts before returning a bounded page. [Observation reads](../../src/observability/read.ts) reject a read if the observed source changes during it.

The [native progress proof](evidence/018-durable-progress/native.md) records pagination going stale while the lifecycle worker continued. This is an actual usability problem and a source-supported performance risk, not a measured explanation of the renderer freeze. Prefer durable fact sequences and stable bounded history pages; refresh current status independently. Do not weaken project/permission isolation.

### 4. We cannot yet measure the product's total value

Current effort totals deduplicate worker sessions and preserve unsuccessful work. They omit a whole-feature allocation of Architect, specialist, review/integration effort and interventions. API-equivalent cost is explicitly null in [trajectory reads](../../src/trajectory/read.ts); [catalog](../../src/runner/catalog.ts) supplies advisory prices without persisting a billing/price record for each execution.

For scale, LZ-13 recorded 389 worker tool calls and about 82.3 minutes from first reservation to task acceptance, before later Root/Architect review repairs. This single complex change is not a model comparison, but it is not evidence of low overhead either. Include that review work when measuring the result.

### 5. Lightweight tasking needs to remain lightweight

The current agent/persona definitions are concise. Do not add more generic prompt prose. Put useful reuse/pitfall/source findings in the task's optional guidance.

The audit enumerates overlaps among all non-retired task pairs, including old completed tasks. Only exact-content findings currently hold admission; ordinary scope overlap is not a universal admission veto. Keep exact retry/idempotency protection and real active write-conflict scheduling. Improve relevant candidate selection and stop asking models to narrate a relationship to every old task.

General behavior/acceptance changes currently need a new linked task: [TaskSpec](../../src/task.ts) and [plan nodes](../../src/runner/schema.ts) only accept revision 1. Scope amendments and schedule revisions are implemented, but are not a general specification revision feature. Add that deliberately rather than mutating historical contracts.

### 6. Distribution is feasible, release readiness is unfinished

The current production dependency audit still reports two moderate advisories: [glob cancellation](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) and [minimatch amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249). bun why traces the installed versions through pinned OpenCode 2.2.5 dependencies. This is not proof either path is exploitable through LAZERS. A local override would not patch the installed Desktop host; verify an upstream-compatible upgrade before broad release.

There is no root LICENSE file, and the package allowlist is src/dist; required upstream notices must actually travel with the release. The reviewed model/license attribution requirement already exists in the WebGPU documentation. A dry-run pack is not a clean install, upgrade, rollback or hardware test.

## Ordered task candidates

These are proposed work packets, not newly submitted task IDs. Architect should inspect the then-current code, reuse existing tasks where appropriate and submit concise specifications with current source findings. Do not rerun the closed UI/progress increments.

| Phase / order                  | Task-sized outcome                                       | Done when / useful evidence                                                                                                                                                                                                 | Starting points                                                                         |
| ------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1A, continue now               | Finish existing LZ-28 lifecycle renewal                  | Real busy reuse, selected-route idle renewal, durable handoff, current-owner outcome delivery, input preservation and visible safe archival work; artifact integrated and owned worktree cleaned.                           | Existing LZ-28, runner runtime/store/native, lifecycle spike                            |
| 1B, next                       | Align trajectory privacy across durable and native views | The retained canary reproduction no longer exports private nested content; safe visible activity and checks still render.                                                                                                   | trajectory privacy/read, progress privacy, retained reproducer                          |
| 1C, next                       | Diagnose and resolve renderer freezes                    | A captured/reproduced blocking stage leads to a supported fix; actual Desktop stays responsive during the affected loading/inference/audio path with settings preserved.                                                    | Existing failed LZ-14, webgpu runtime/decision-runtime, inference trace, renderer-debug |
| 1D                             | Make live trajectory incremental and stable              | Reading/expanding history works while new worker events arrive; repeated status refresh does not repeatedly materialize unchanged full context. Measure read cost before/after on real retained work.                       | trajectory-panel state, observation reads, trajectory reads, progress/store sequences   |
| 2A                             | Account for the full feature                             | One feature report includes Architect and worker attempts, failures/repairs, review work, verification time and observed interventions, with unknowns distinguished from zero.                                              | progress recorder, trajectory read/projection, runner associations                      |
| 2B, after 2A attribution       | Produce honest API-equivalent estimates                  | Price/model/provider/date and token-category semantics are retained; alternatives use fresh catalog prices; actual subscription accounting stays separate. No duplicate reasoning/output billing.                           | native catalog, trajectory effort, provider metadata                                    |
| 2C                             | Polish task control and naming                           | Quiet panel supports compact human references/names and a focused priority/waiting/action view; existing Start and dependency grouping remain correct. Add only needed native actions, not a new dashboard.                 | Tasks and Trajectory panels, command/RPC schemas, approved designs                      |
| 3A                             | Guided worker configuration                              | Architect helps choose and retain native routes/effort for the three personas; user choices pass through unchanged. Decide whether per-node overrides are needed; separate plans already permit mixed routes.               | worker catalog, personas, native configuration, PlanInput                               |
| 3B                             | Version changes in intent                                | A changed requirement produces a new immutable revision/link and updates only affected unstarted work; old attempts/evidence remain attributable.                                                                           | task/storage, runner schema/store/runtime, task instructions                            |
| 3C, when research justifies it | Add runtime-managed research specialists                 | Internal code investigator/researcher assignments have an explicit native route, bounded question and concise sourced result; no worker recursive delegation. Demonstrate useful saved effort on real task planning.        | native agent/session API, runner host, context publication                              |
| 4A                             | Use it on a large existing app                           | Several real features run request-to-integration: one localized change, one UI change and one dependency/recovery case. Grade task clarity, interventions and total accepted-result cost; tune only from observed failures. | The user's target repository; existing three personas and task schema                   |
| 4B                             | Prove clean package installation                         | A clean profile installs the packed plugin, loads server/panels/agents and completes a real task without the development checkout or caches.                                                                                | package exports, GUI build, native loader                                               |
| 4C                             | Make stored work maintainable across releases            | Upgrade/reopen and a supported backup/restore path preserve tasks, attempts and user choices; retention/export handles growing telemetry without silently erasing useful history.                                           | storage, runner/progress stores, schema migration tests                                 |
| 4D                             | Prepare the first release                                | Compatible host/dependency fixes are verified; version, chosen license/upstream notices, optional-model behavior and upgrade instructions ship in the actual package.                                                       | package metadata, host pins, model notices, clean-install evidence                      |

The earliest independent work can be parallelized after checking current write scopes. Privacy and live-trajectory work share read/projection files and should integrate in that order. Lifecycle and full-accounting work touch core runtime/store, so avoid competing edits until the current lifecycle artifact lands. UI-only naming work and release metadata preparation are possible separate lanes. Real large-app work should start as soon as the reliability fixes permit it; it need not wait for research specialists, general memory or sophisticated routing.

## Keep, defer, and verify

Keep the one-plugin/native-SDK architecture, pure XState task transitions plus durable effect handling, exact route choice, ordinary implementor tools, three short personas, concise task guidance, schemas and lazers_verify_task. Do not replace the scheduler or add a daemon.

Defer autonomous model rankings, more personas, mandatory memory/retrospectives, broad prompt expansion and a new visual dashboard. Compound only a finding that improves a later real task; retire advice that does not earn its cost. Do not add source fingerprint evidence gates.

## Current external checks

- [OpenCode plugin packaging](https://opencode.ai/v2/docs/build/plugins/) and [Desktop GUI](https://opencode.ai/v2/docs/build/plugins/gui/) confirm the one-package server/GUI model. Desktop GUI remains experimental; preserve our pinned compatibility boundary.
- [OpenRouter model metadata](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) supports a price-aware advisory catalog. Catalog prices alone do not measure accepted-task cost.
- [XState persistence](https://stately.ai/docs/persistence) describes state restoration; our external effects still require their existing durable identities and recovery. The current site shows v6 alpha: this is not a recommendation to migrate from pinned XState 5.33.3.
- The two dependency advisory links above were checked against the fresh registry audit, not copied as current facts from an old report.
