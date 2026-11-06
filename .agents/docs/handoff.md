# Current dogfood handoff

Updated 2026-11-06 after canonical activation at7e80cac (documentationc85f782).
Goal remains active: drive OpenCode Desktop until the full roadmap is implemented,
verified, integrated and cleaned, then propose observation-based improvements.
Runtime/API readback is authoritative. This replaces contradictory historical
status sections; archive: handoff-before-20261106-native-activation.md.

## Working rules

- Model prompts through Desktop CUA; read-only SDK/SQLite diagnostics allowed.
  No production SQL mutations. Root reviews/integrates and fixes actual blockers.
- Architect OpenAI gpt-6.1-sol/high; implementors/research OpenAI gpt-6-luna/max.
  Existing native Tera High reviews screenshots. No mockup-to-components skill.
- Preserve original worker/attempt/history/useful work; native runtime owns dispatch,
  task state and cleanup. Use OpenCode worktree APIs, not custom worktree commands.
- Evidence is tests and actual product probes, never source hashing. Keep schema
  checks, lz-verify-task Architect self-review and advisory System One. No budgets.
- All six inference flags ON; unload Never. Do not disable inference to pass tests.
- Avoid source/build activation during actual implementation. Coordinate a natural
  quiet boundary. Never stop healthy workers merely to manufacture one.
- Read README and opencode-api.md before integration changes. Load Portless skill
  before listening project servers; third-party Desktop follows native lifecycle.
- Priority Models → Tasks/Trajectory → Radar; preserve the full remaining roadmap.
  Tasks are small coherent increments, not epics. Architect decomposes and schedules.

## Integrated and observed

Canonical7e80cac preserves native2610e9f (retained verification) and3ea8b5d
(GPU normal reload) ancestry, plus catalog accessb01121b, native replay08166cf,
and shared Tasks publisher20d9736. Combined reviewed tree was a9235c8 at
/private/tmp/lz-native-log-contract-review. Clean backend-only review tree
/private/tmp/lz-backend-release-review was129c750. Root removed both finished review trees through native worktree.remove(force:false);
physical absence confirmed. Backend review commit retained by branch
feat/backend-release-review-record; integrated full candidate is in main ancestry.
Active worker worktrees remain untouched.

All native sessions were confirmed inactive before activation. Root quit/reopened
Desktop; service PID71027 survived. Canonical GUI build/bundle evaluation passed.
Then normal Extensions → Plugins → Reload and settings local inference returned
“local GPU ready.”,19input/4outputtokens. Flags ON/Never unchanged. This proves
normal reload/output, not every cross-window/cancellation/lost-response race.

Postactivation3sec sample:21Tasks events/21versions, one each instead of14copies.
Renderer78667 measured2.0%CPU, service71027 15.5%. Observability still520events/3sec;
not all performance issues resolved. See renderer-event-amplification-20261106.md
under design/reviews. Historical587%renderer recovered after window reload; do not
claim that recovery alone proves a code fix.

Exact retained required command passed562tests/7497assertions/30files in155.78s,
without timeout override; boundary116/855 and WebGPU22/122 passed. Quality/build
pass. Logs under /private/tmp/lz-clean-backend-* and lz-final-backend-gpu-*.
Real native retained qualification remains unproven; tests do not substitute.

147 UI corrections are integrated (e05e82c,14e8928,50cc2f2 ancestry). Native failed
lifecycle renders Failed; objective/Done when precede collapsed diagnostics;
links158→157→156 work. Latest accepted product work retains cleanup-blocked status:
cleanup uncertainty does not revoke product acceptance.153 is integrated/cleaned;
large Models history reads work. No real Models comparison graph accepted yet.

## Current native work

Main Architect ses_e568438ebffeaoFbF9nBb942XM is active on the full roadmap.
Root resumed through Desktop after activation. Latest actual blocker:
registered verify-retained on156 refused “A conflicting active implementation
attempt prevents retained verification”; no operation/check/acceptance was created.
Historical122 attempt38df5475-caa8-4469-8c68-1b330f981c80 overlaps Models source but
has sealed source quarantine. Runtime guard scans raw attempt states; existing
sourceReservationExcluded has a narrow isolation-aware exclusion. Investigate and
reuse existing policy; do not clear historical state or invent idle success.

Luna e522 confirmed the exact admission defect. Current138 owner resumed SAME
worker ses_9e11e5a8fae643a79c50b2346bfb48a9 through native controls. It now has a
narrow two-file patch reusing sourceReservationExcluded for isolated verification,
plus registered positive/negative regression. First full affected suite561/7486
passed153.24s with timeout30000/parallel1; quality passed. Worker then added actual
destination workspace to the exclusion (same-physical protection) and is rerunning
tests. Current patch is NOT yet committed or activated. Root reviewed initial diff,
will review final delta; no duplicate model review needed without a new finding.

Original129 repair hit parentID===currentOwner despite valid ownership transfer.
Root corrected research scope: supported reassignment as well as renewal must work;
immutable native launch parent is not current plan authority. Preserve exact
worker/attempt/project/route/input/current-owner epoch bindings; do not invent a
predecessor-archival/ancestry ceremony that invalidates the58approved transfers.
Main is planning a proportional correction in existing57 or linked remaining work.

Root used native Help→ExportLogs; current main extract is
/private/tmp/lz-native-export-current-main.log. Actual provider/generation1→2,
handoff retirement and successor-ready/probe records correlate to the witnessed
reload. See design/reviews/native-plugin-reload-observation-20261106.md. e502 is
reused to assess these logs+mechanical source predicates for159; gate still open.
Reuse existing research sessions; do not duplicate.

138 task0d18d8c6-959f-4b0f-9f37-bb79c5aee0c4;
plane48290a6-a871-42a2-94f1-c88f700c0d11. Latest attempt091ee91c-c6e3-43d3-b7f9-858028336150,
worker ses_9e11e5a8fae643a79c50b2346bfb48a9 delivered2610e9f, model inactive.
Original87c14979 remains failed, preserved. Owner last ses_e937c3ce298747bc8898cda4c2c56b06;
revalidate current owner/version before controls. f6/2610 fixed accepted node leaving
running attempt; only running/verifying rows advance, historical failed stays failed.

159 taskb3781cfa-4c99-4274-ae58-f762cf7aa301;
planb171f745-0676-48e5-b517-cb5a8aad56d6, worker ses_f1562a517796402694b1fc3a7c26d148
inactive/succeeded3ea8b5d, attempt accepted; native gate disposition pending.
128 is superseded/cancelled, not fulfilled. Old impossible same-provider gate is
not granted. Peer retracted broker-idle fixture false positive; no extra proof turn.

## Models and subsequent work

Plan eade12ae-74f3-48af-874b-f5950f4a41c3:156→157→158, priority100.
156 taskefd19c25-909e-4b06-aa4b-b6411785b4f7, original attempt
ff55fda4-7c0d-4a43-b295-cdc29deefd1d, worker ses_507e57d6901a4928bfddd1e46d8f846b,
committedb01121b, recorded running/artifactNULL under old idle mismatch.
Use registered verify-retained with zero new implementation/model turns, then
reconcile (not run) existing plan to release successors after real eligibility.
157 task74f716cd-cf3e-436e-b112-57de5403b20c adds cohort/reference estimates.
158 task64ed8c82-7bdd-4b2b-bbaa-c612464c5671 adds approved chart/rows/inspector.
Approved references design/models-panel/models-approved.png and
design/task-panel/tasks-focus-v2.png. Actual missing rates/tier uncertainty remain
honest; current-market reference estimates may be labelled partial/ranges.
Prices use live configured OpenRouter/native catalog, not subscription charges.
Shared/project persona mapping resolves at dispatch; retain actual historical route.

Tasks148/149 plan7d463854-6ef1-4206-beb8-5a9b8d4e6692 follows prerequisites.
149 advice3 includes refresh clearing prior activity into Unknown: preserve exact
scoped stale observation during refresh, never invent current activity.
131 timestamps overlap138;139 historical trajectories,155 market valuation,
154 same-worker steering remain.151/152 connected-live-pricing gate is unresolved;
actual Refresh “decision reads disagree” is not proof of working price presentation.

## Full scope still open

Keep roadmap/design contracts for proactive recovery, structured reviewed handoffs,
live verification (two real implementer correction/reprobe walkthroughs), scheduler
renewal, task ordering/grouping, live Radar agents/models/tools/files/flow/health,
audio, model metrics and persona selection, packaging/install/upgrade/cross-machine.
Research/review/integration usage overhead is still unallocated;0subscriptioncharge
is not market cost. Full release completion is unproven. See roadmap-execution.md,
retained-recovery-followthrough-20261106.md and design/roadmap.md for linked work.
Advice320-character cap is removed (b0548ba); latest retest4pass/59assertions.
