# Current dogfood handoff

Updated 2026-11-07. Goal remains active: drive OpenCode Desktop until the full
roadmap is implemented, verified, integrated and cleaned, then propose observed
improvements. Runtime/API readback is authoritative; revalidate live handles.

## Working rules

- Model prompts through Desktop CUA. Read-only SDK/SQLite diagnostics allowed;
  no production SQL mutations. Root reviews/integrates and fixes actual blockers.
- Architect: OpenAI gpt-6.1-sol/high. Implementors/research: OpenAI gpt-6-luna/max.
  Native Tera gpt-6.1-terra/high reviews actual screenshots. No mockup-to-components.
- Preserve original workers, attempts, history and useful work. Native runtime
  owns task state, dispatch and cleanup. Use OpenCode worktree APIs.
- Evidence means tests and actual product behavior, never source hashes. Keep
  schema validation, Architect lz-verify-task self-review and advisory System One.
  No invented budgets or model/provider restrictions.
- Six inference flags ON; unload Never. Do not disable or wipe inference.
- Activate runtime source at an implementation quiet boundary; do not stop healthy
  workers to manufacture one. Docs commits do not require runtime activation.
- Read README and opencode-api.md before integration changes. Load Portless skill
  before listening project servers; native OpenCode uses its supported lifecycle.
- Priority: Models, then Tasks/Trajectory, then Radar; preserve the full roadmap.
  Architect decomposes requests into small coherent tasks and owns orchestration.

## Native coordination and next action

Main Architect: `ses_e568438ebffeaoFbF9nBb942XM`, OpenAI Sol High.
Service PID3219 at latest readback. Desktop input recovered after full quit/reopen.
Main is actively coordinating again through native Desktop; the original Luna Max
LZ-174 worker returned corrected67d4e6d, now inactive/succeeded; review and
retained verification/integration remain. Its exact native checks passed395
targeted tests and582runner tests, strict checks and GUI build. LZ-173 returned
corrected candidate0b28972 with no material source findings; its retained candidate
binding remains blocked, and LZ-175 is queued behind174 to repair that native path.
Current measurements/status: `design/reviews/live-progress-performance-20261107.md`.
Root sent the full-roadmap continuation through Desktop, including checking actual
eligibility for independent work and preserving Models → Tasks/Trajectory → Radar.

Revalidate native queues, inputs, ownership, artifacts and live handles before
acting. No production SQL mutations, replacement workers, speculative effect
replay or extra discretionary approval gate.

## Integrated performance source

Canonical main now includes merge `0e64881` and report commit `ecbdb01`, preserving
accepted original-worker LZ-129 artifact `9f61a6633dd3d64a3bc51672c4e5d63e1234adcb`.
Report: `design/reviews/lz129-canonical-integration-20261107.md`.
Four conflicts were resolved individually, retaining canonical association-cache,
active-attempt tests, valuation provider and trajectory live cache alongside the
new Radar reader. The process-shared source identity follows reviewed9f61a6;
reader-specific history cursor signing remains separate.

The combined source passed526tests/7046assertions/27files in108.74seconds with
`--max-concurrency=1` and default timeouts, including runtime, store, observability,
Radar and Trajectory consumers. Formatter843files, lint404, typecheck392, diff
checks and isolated GUI build pass. Canonical GUI build also passes. Logs:
`/private/tmp/lz129-canonical-{combined-tests,gui-build,activation-build}-20261107.log`.

Root's native-created `/private/tmp/lz129-canonical-integration-20261107` was clean
and merged, then removed with native worktree.remove(force:false); existence:false.
Branch `feat/lz129-canonical-integration-20261107` retains the candidate. Do not
reuse the deleted checkout. The OLD conflicted6ee trial at
`/Users/tjw/.local/share/opencode/worktree/b5da4c/lz129-combined-review-20261106`
and all worker worktrees remain preserved.

LZ-129 task `91c6c95d-9965-421f-9b35-49da50f84979`, plan
`243f8093-7c3c-44e3-bda5-e06870e4f680` is natively accepted/version117; native
integration/cleanup is NOT yet recorded. Original attempt58d8d699 and worker
`ses_aeff3e9ac5d24c6c944d35e31b050963` remain. Source has now been activated through full Desktop restart. A current 3-second
subscription observed27events/27distinctidentities, each once at one location.
Navigation/refresh/scopes and full CPU acceptance remain open; the active-work
12-second CPU window still measured service42%, renderer15%, GPUhelper38%.
No all-performance/freeze-resolution claim. Historical association materialization
remains a known scaling limit. See the 6ee and9f61a6 source reviews for fixes.

Prior integrated source includes163efa5f11,1682bbf8a3,1551ca1e1b,169e743a6e and
Root partial qualifierfab6bfe. Their prior733/357/11test runs do not substitute for
current acceptance. LZ-163 is integrated/version34 with native non-forced cleanup;
this does not close129 or the UI/pricing plans.

## Current held UI, pricing and recovery work

- LZ-172 task `32810daa-f8dc-4c50-a2fc-f7000c480ad8`, plan
  `09cb85ba-dc17-40ed-adff-c0e7e50ad135`, original attempt14b02650 and worker
  `ses_83bd7a96b951462e9aa31f80043e8940`: node cancelled/plan blocked/version67
  after interrupted retained continuation lost its control fence. Preserve
  artifact0da6681, worktree, patch, usage and input history. Source review
  `models172-0da6681-source-review-20261106.md` requires collision-safe visible
  route labels and a truthful interval legend. Also correct the configured-price
  source labels noted in173review. Actual visual acceptance remains open.
- LZ-173 task `50630f61-d966-43b5-b349-9f39e85ea014`, plan
  `ba5744d0-2657-4f93-b006-44ca0b176108`, attempt4d783df7, worker
  `ses_145885557d454551815079ab36bd9c24`: corrected candidate0b28972 returned;
  independent Luna review found no material findings. Prior accepted candidate
  ddefc44 remains in runtime history; the new candidate is not integrated or
  runtime-accepted. Current repair idle lineage is unknown. LZ-175 owns the narrow
  immutable candidate-binding correction after174, without inventing native idle
  or replacing this worker. Reviews: `lz173-0b28972-source-review-20261107.md` and
  `lz173-repair-idle-lineage-and-candidate-binding-20261107.md`. Actual connected
  LZ-137 acceptance remains open; sourced estimates/ranges are valid, recovery
  gaps qualify assumptions rather than vetoing prices. No false zero, unavailable
  copy, internal review prose or subscription charges.
- LZ-174 task `49dbfe29-b1af-4710-abfa-9268d61db228`, plan
  `f33eddb3-c3f6-4f45-ac51-3a1f7ae47c23`, attempt0375ef98, worker
  `ses_5210fab90d3745959a4d269dbd6ab744`: node and plan running at latest readback,
  in the same original session/attempt. Candidate6622ebf passed
  isolated checks but independent review found a task-disposition admission race
  and missing runtime-command fence regressions. The same worker returned67d4e6d
  correcting both;395targeted and582runner tests plus quality/build pass. It is
  inactive/succeeded, with native background lineage still separately unknown.
  Review67d4e6d before integration; do not integrate obsolete6622ebf alone. See `lz174-6622ebf-source-review-20261107.md`. Its feature must
  preserve retained-repair authority across authorized interrupted continuation
  and recover the exact runtime-created unprompted172fence failure. Full contract:
  `models172-post-restart-retained-fence-20261106.md`.

User-approved Models layout: full-width global chart at every width; no persistent
model table or right inspector. Point tooltips, selected one/two-line cost summary,
details below horizontal split, secondary assumptions collapsed, native theme/fonts.
Tera actual narrow/wide review and images remain under
`design/reviews/*models*fab6bfe*20261106*`; latest DESIGN overrides old table mockup.
Assignments, resizing, keyboard, refresh and theme/font walkthroughs remain.

Actual LZ-137 `0f6bb558-101b-4d57-a9d9-80428df78fce` still shows the old misleading
partial$0subtotal before corrected pricing activation. 19 retained unique calls
support approximately$0.016 at cached OpenRouter base rates. Investigation and
Root product review are durable under `design/reviews/lz155-*20261106.md`.
Both reached Main via Desktop receipt `msg_1b2775fe80011WkNsIBR16Mvqc`; Main
attached estimate advice and created173. No further Root approval is required.
The latest source review findings, not passing earlier tests, govern correction.

## Architecture, performance and preserved roadmap

Full Sol review/ranking/C4/inventory/probes:
`design/reviews/architecture-{review,system-ranking,c4,inventory,flow-probes}-20261106.*`.
Full review AND ranking reached Main in one native prompt
`msg_1b1f36d7c001BWtQq7s4WFUiFs` (40,386 chars; exact inclusion checked).
Four P1, no P0: reuse129 publisher and163 authority; new170 asynchronous ordinary
checks →171 mechanical failure routing. Reconciliation:
`design/reviews/architecture-roadmap-reconciliation-20261106.md`.
Plan `45adcb0c-0a86-4cb7-b59e-eb9218d8338d` was natively run-admitted, priority85,
OpenAI Luna Max; real prerequisites Models145, Trajectory155 and163 remain.
No additional discretionary approval or draft-only gate. 170/171 do not acquire
all retained-verification lifecycle work or require a new baseline test ritual.

Tasks publisher20d9736 is integrated and observed one event/version; do not refix.
Observability duplication remains: latest short sample435 events/319 complete
identities includes five copies across five locations. Not all events are duplicates
and this does not quantify CPU cost. Locked snapshot Desktop0%, renderer0%,
service1.9% is not interactive acceptance. Details:
`design/reviews/renderer-event-amplification-20261106.md`.
Earlier renderer freeze sample was unsymbolized V8, no causal JS diagnosis.
Export `/Users/tjw/Downloads/opencode-debug-20261106T165751.zip`.

Root8975516 fixes cache ownership persisting beyond the Desktop process. All six
switches and cached models remain. Actual native chat and d1 requests passed;
chat passed again after full quit/reopen with d1 resident. Lifecycle tests11pass,
strict checks/build pass. See `inference-lease-lifecycle-20261104.md`. LZ-165's
remaining generation/navigation branches and general freeze acceptance remain open;
do not infer those from restart recovery. Native Architect was notified.

Real retained156 operation34d2518c… accepted original ff55/b011 with one original
implementation prompt, 176 Models tests and quality/build exit0, 24 check resources
removed; Root installed host fixes e36a42c/63d5001 are explicit acceptance binding.
See `retained156-native-observation-20261106.json` and native-worktree-dependencies
review. LZ-138 task source accepted/integrated, whole plan still depends on129's
combined checks/review. Preserve failed histories and uncertain resources.

Whole roadmap remains: Tasks148/149 ordering/grouping;131 timestamps;139 historical
trajectories;160/161 Radar/Trajectory; true Radar live agent/model/tool/file/message/
health monitor; proactive recovery, structured verified handoffs/skills and two
actual implementer failure/correction/reprobe walkthroughs; coordinator134 renewal,
164 retained inspection,165 GPU; audio; model/persona metrics and assignment;
packaging/install/upgrades/cross-machine dogfood. Models166 and original156–158
plan acceptance/cleanup still need truthful final disposition. Legitimate147
accepted work is cleanup-blocked separately. Duplicate check rows need exact
receipt reconciliation, not name/duration deduplication. Advice character cap is
removed. Use README, roadmap-execution.md and design/roadmap.md for full contracts.

## Latest native UI follow-through

Rootff73ff3 fixes Tasks clearing known activity during each replacement read.
The failing-before/passing-after regression and all22panel-state tests pass;
strict checks/GUI build pass. Loaded Desktop project list now shows actual
inactive/succeeded original workers, rather than reset-to-Unknown. Sustained
active-work observation remains. Record: `tasks-activity-refresh-20261107.md`.

A native Reload Webview at chat-ready reproduced existing165:
“A stale renderer generation cannot claim the model cache”. Root queued the
exact case and released its WebGPU scope; only panel state/tests were reserved
for the completedff73ff3fix. Full quit/reopen restored chat-ready and actual
local chat passed again. This does not close165same-window navigation recovery.

Architect's two native Luna Max research sessions are eligibility
`ses_e49678d33ffeaqfWYXeSHkrgaT` (last confirmed running) and residual CPU
`ses_e496824efffeeN5zdOWSnUi55c` (completed). Report
`residual-cpu-attribution-20261107.md` measured active service63.9%,renderer21.6%,
GPUhelper37.8% in a separate window. SQLite preparation/schema frames are a
subsystem lead; no JS/DB attribution or overall performance acceptance. Main's
queued Root notices include ff73ff3's scope and165's exact live reproduction.
