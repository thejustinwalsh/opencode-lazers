# Current dogfood handoff

Updated 2026-11-06. Goal remains active: drive OpenCode Desktop until the full
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

## Native coordination

Main Architect: `ses_e568438ebffeaoFbF9nBb942XM`, OpenAI Sol High.
Service PID71027. Canonical project `b5da4cadd97e51f2f6c88ff71daa1006f6a5b7df`.
CUA explicitly reports macOS locked; an unlock request is pending. Do not replace
Desktop prompts with API prompts. Native workers continue while Desktop is locked.

Original LZ-129 performance repair is active on OpenAI Luna Max:

- Task `91c6c95d-9965-421f-9b35-49da50f84979`; plan `243f8093-7c3c-44e3-bda5-e06870e4f680`.
- Original attempt `58d8d699-6a12-44c3-a5af-954b2b5564bc`, worker
  `ses_aeff3e9ac5d24c6c944d35e31b050963`, same native worktree and original parent.
- Supported retained repair admitted operation `a320bff0-3654-4261-9382-22ba5dfe4e80`.
  Admission evidence: `design/reviews/ownership163-original129-admission-20261106.md`.
- Native scope review `ses_e4dbc30daffe4HkwWzpwGLGsry` completed. Architect recorded
  seven additive source/test paths using amend-scope, then answered exact native
  form `frm_1b2432e71002UkKAohL9ZC1a4X`; receipt
  `msg_1b24afbcb001iXYKeHsXtFqHJc` reports answered:true and remaining:[], followed
  by reconcile. Worker resumed in the same attempt; no new prompt/restart/SQL fix.
- Repair covers bounded queries, first inventory, UTF-16 and canonical observability
  publication with independent scoped reader queues. Preserve newer canonical
  association-cache/activeProjectAttempts/privacy/consumer fixes absent from the
  old worker baseline. Durable journal replay is not newly promised.

## Integrated source and actual acceptance

Canonical runtime/GUI source is `fab6bfe`; later commits currently record docs and
observations. It includes original LZ-163 efa5f11, LZ-168 2bbf8a3, LZ-155 1ca1e1b,
LZ-169 e743a6e by ancestry-preserving merges, plus Root partial-price qualifier.
Root built canonical GUI and activated using native Plugins → lazers Reload at an
observed all-model-idle boundary. Actual Models and new trajectory market fields
loaded. This is not whole-feature visual/pricing acceptance.

Combined checks: pre169 733 tests/10,360 assertions; final affected consumers
357 tests/4,779 assertions; Root qualifier 11 tests/770 assertions. Formatting,
lint, typecheck, diff checks and GUI build passed. Logs:
`/private/tmp/lz-models-runtime-{combined-tests,final-consumers,review-correction-build,canonical-build}.log`.
Root's clean merged native review worktree `/private/tmp/lz-models-runtime-review`
was removed using native remove(force:false); physical absence confirmed. Branch
`feat/models-runtime-integration-20261106` retains source. Do not reuse deleted
Root review directories or remove retained worker trees.

LZ-163 plan `61e9cffc-7883-43d9-81e0-803e0fd591b1` is integrated/version34.
Native receipt `msg_1b2412843001Nq9kjauiNV0sOH` confirms both completed163 worktrees
removed natively, cache retirement evicted, and WORKTREES_RECONCILED against efa.
Original129 worktree remains. This closes163, not129's source/CPU acceptance.

## Models and Trajectory follow-up

Models plan `145cde90-22ae-4521-b58a-cd0147f1eb55` contains delivered168→169.
Task169 `3b5ed421-d8b4-42bb-b238-7ea15c70286e`, original worker
`ses_eab54443be664e52902ecdfe7b0aea47`, delivered e743a6e after same-worker naming
correction. Root correction fab6bfe is additive; do not credit it to e743 alone.
LZ-167 was superseded before execution, zero attempts.

Actual captures: `design/reviews/models-live-fab6bfe-{narrow,wide}-20261106.png`.
Tera review: `design/reviews/tera-models-fab6bfe-visual-review-20261106.md`.
**Not visually accepted:** narrow ticks overlap, selected Luna mark is unclear,
accounting labels and bulky controls dominate. Latest user/DESIGN direction:
full-width chart at every width, no persistent table/right panel; compact tooltip
and one/two-line selected cost; details below horizontal split; secondary detail
collapsed. No internal review labels; omit truly unavailable cost. Assignments,
interaction, resizing, theme/fonts and refresh still need actual walkthroughs.

LZ-155 task `c23ffca3-fe8d-4102-afe6-3ee6ebf12f0c`, plan
`b2d491ae-b125-485e-8637-796ae194447e`, delivered 1ca1e1b. Connected-cost gate OPEN.
Actual LZ-137 (`0f6bb558-101b-4d57-a9d9-80428df78fce`) has nonzero usage but shows
partial `$0 subtotal`, with no selected cached quote. Capture:
`design/reviews/trajectory-live-lz137-unpriced-zero-20261106.png`.
Read-only Luna investigator `ses_e4dc4687cffeFseohr89By1Hbk` remains active,
checking retained per-step usage. Findings in
`design/reviews/lz155-connected137-market-investigation-20261106.md` establish
matching OpenRouter tiered rates exist, but strict applicability selects none;
zero unused cache-write contribution becomes misleading displayed subtotal.
Root product review `design/reviews/lz155-market-estimate-product-review-20261106.md`
requires useful published current-market estimates/ranges, not UI-only hiding or
exact-billing prerequisites. Existing market-range.ts is a source starting point.
**Root still needs to relay that product review through Desktop when unlocked.**
Do not invent rates, infer per-call tier from cumulative usage, or use subscription
charges. Use configured OpenRouter→OpenCode source order and shared valuation
owner; source-backed estimate assumptions belong in secondary detail.

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

LFM3 indicator currently Error. LZ-159 observed normal reload/local inference and
is integrated/cleaned; LZ-165 covers remaining generation/navigation recovery.
Keep inference settings unchanged; do not claim GPU health or freeze recovery.

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
