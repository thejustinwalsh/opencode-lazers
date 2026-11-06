# Current dogfood handoff

Updated 2026-11-06 after integrated Models activation and live screenshot review.
Goal remains active: drive OpenCode Desktop until the full roadmap is implemented,
verified, integrated and cleaned, then propose observation-based improvements.
Runtime/API readback is authoritative. Revalidate live handles before acting.

## Working rules

- Model prompts through Desktop CUA. Read-only SDK/SQLite diagnostics are allowed;
  no production SQL mutations. Root reviews/integrates and fixes actual blockers.
- Architect: OpenAI gpt-6.1-sol/high. Implementors/research: OpenAI gpt-6-luna/max.
  Native Tera gpt-6.1-terra/high reviews actual screenshots. No mockup-to-components.
- Preserve original workers, attempts, history and useful work. Native runtime owns
  dispatch, task state and cleanup. Use OpenCode worktree APIs.
- Evidence means tests and actual product behavior, never source hashes. Keep
  schema validation, Architect lz-verify-task self-review and advisory System One.
  No invented budgets or model/provider restrictions.
- All six inference flags stay ON; unload Never. Do not disable or wipe inference.
- Coordinate source/build activation at an implementation quiet boundary. Do not
  stop healthy workers to manufacture one. Docs updates are not a source release.
- Read README and opencode-api.md before integration changes. Load Portless skill
  before listening project servers; native OpenCode uses its supported lifecycle.
- Priority: Models, then Tasks/Trajectory, then Radar; preserve the full roadmap.
  Architect decomposes requests into small coherent tasks and owns orchestration.

## Current integrated source and verification

Canonical main includes d1b0c5f: current runtime/GPU fixes plus Models producer
f8c5e2e (LZ-157), correction1c1070b (LZ-166), UI03331c85 (LZ-158), and Root
pricing review correction5e739d8. Root fixed absent-rate false-zero subtotals,
positive-to-zero division underflow, and the infeasible tier regression fixture.
Native e522 reviewed pricing; e502 reviewed delivered UI and found no material
source defects, with81focusedtests passing. A late-first-page reconnect test gap
is low priority; generation guards appeared sound, not independently reproved.

Combined source d301bc83 passed220tests/3296assertions, formatting, lint,
typecheck386files, diff check and GUI build. Log:
/private/tmp/lz-models-full-combined-verification.log.
Canonical build also passed: /private/tmp/lz-models-canonical-build.log.
49d9223 records actual live observations; later handoff/report changes are docs.

Authoritative review/observation report:
design/reviews/models-price-review-followthrough-20261106.md.
Root's native-created /private/tmp/lz-models-combined-review was fully merged,
clean, then removed through native worktree.remove(force:false); physical absence
confirmed. Branch feat/models-combined-review-20261106 retains the candidate.
Do not reuse that deleted checkout. Native worker trees remain preserved.

## Current native Models work

Main Architect: ses_e568438ebffeaoFbF9nBb942XM, Sol High.
Current visual reviewer: ses_e52a5ae04ffeObat8Bt6imz4ci, general agent,
OpenAI gpt-6.1-terra/high, canonical repository location. Main resumed this
EXISTING session with THREE INLINE PNG image parts and current source/index:

- /private/tmp/lz-models-live-narrow-first.png
- /private/tmp/lz-models-live-wide-first.png
- design/models-panel/models-approved.png

Tera completed successfully; saved final plan:
design/reviews/tera-models-live-visual-review-20261106.md.
Desktop input recovered after native View Reload (briefly blank with a transport
error/server-thrashing warning) then supported App Restart. No inference flags
were changed and service71027 survived. Earlier AX-only draft values were not
proof of submission. The recovered composer had an enabled Send; Root clicked it.
Native user message msg_1b18e954500146adrbLH3kp6tg confirms the continuation reached
Main exactly once, and session.active confirmed Sol High running. Main began
reading the actual Tera final, checking existing tasks and refreshing the index.
No user foreground/composer action remains necessary. Observe concrete task
creation/dispatch before claiming implementation has resumed. Root cause of the
CUA noWindowsAvailable/input delay is not established; do not attribute it to GPU.
DESIGN.md and the approved image govern. Preserve the full goal; other read-only
review is possible while input is unavailable.

VISUAL ACCEPTANCE FAILED in actual Desktop: Accepted header wraps across lines;
rows become paragraphs; raw provider-ID chart labels truncate; multiple verbose
pricing cards bury the primary estimate. Visible controls/provenance overwhelm
compact hierarchy. Keep honest partial/range/unknown semantics with concise
labels and progressive disclosure. Chart above rows narrow, beside rows wide;
selected estimate below a resizable horizontal split. Need new actual captures
and Tera review after corrections, plus assignments and theme/font walkthroughs.

The integrated panel DOES render real chart points and live OpenRouter references.
Selecting openai/gpt-6-luna/max shows112acceptedtasks, row/inspector matching
known-subtotal range0.353992451071–0.674016373125USD/acceptedtask, remainder unknown.
Manual Refresh advanced retrieval10:24:13→10:27:46 local November6 while retaining
Luna selection, without displayed snapshot disagreement. Disclosure reports exact
OpenRouter record openai/gpt-6-luna, snapshot56d2686a-b792-4c9e-a145-e86b9d34e7e2,
generation159; all positive token categories have rate coverage. Partial retry/
attribution history remains real:149/151matchedsessions,2unknownroutes. This is
not complete-cost or all-provider proof. Use current published market prices,
not subscription charges; absent prices are not zero.

Models plan eade12ae-74f3-48af-874b-f5950f4a41c3 lastRUNNINGv28:
156accepted on ORIGINALff55/b011,157acceptedf8,158accepted03331c85.
158 task64ed8c82-7bdd-4b2b-bbaa-c612464c5671;
attempt14be7721-297d-4a70-bbdc-8652c807f943;
worker ses_af5f7ceb2def456db6c25a8c09096a30 delivered, inactive.
Native SCOPE_AMENDEDv25 at1793976008645 added contract/producer/test paths to
execution scope without rewriting task or replacing the worker. Global chart
metadata now beats paged/inspection data; explicit null remains unknown.
166 task04c97fb4-0755-4c57-97e4-694b98dc2ae8;
planda27ee40-9c1f-464e-8ff8-ee89bb2ee4b7 lastBLOCKEDv9 on combined-consumer
human gate; acceptedattempt29ff8540-26c0-4209-98d4-bcf8bd7a4d0f at1c1070b.
Native plan acceptance/integration/cleanup still needs truthful final disposition.

Both original UI worker/reviewer had provider.auth ENOTFOUND auth.openai.com.
DNS recovered; Main natively resumed the SAME sessions/attempt, not replacements.
158's actual trajectory records331calls,829789uncached input,42702208cache-read,
63314output,109745reasoning. Displayed categories are not an asserted billable sum.
152:05start→panelcheck-end includes interruption, not active coding time. Do not
infer attempt end. Root/reviewer/driver overhead is additional and unallocated.

## Desktop activation and remaining performance/GPU work

All native model sessions were idle before main integration/activation. Settings
input/content was delayed; Root captured short read-only process samples before
using native App menu→Restart. Desktop78646→69562, renderer78667→69585;
service71027survived. Then native Extensions→Plugins→Reload; LAZERS enabled.
Samples /private/tmp/lz-models-activation-{renderer,service}.sample.txt do not
establish the cause. Earlier during review service84%CPU/renderer35%CPU; this
is not an idle performance qualification. No inference flags were disabled.

Tasks shared publisher20d9736 is integrated and observed1event/version instead
of14copies. Observability still has repeated full identities across locations
(322events/3sec in a prior sample). Existing129 repair needs canonical coordinator
publication with per-member scoped queues and proper reconnect/gap semantics.
Do not refix the already shared Tasks publisher or claim all CPU issues resolved.
See design/reviews/renderer-event-amplification-20261106.md.

159 normal full-plugin reload is INTEGRATED/CLEANED at3ea8b5d: native exported
main logs correlate provider retirement, successor ready and local output19in/4out.
That bounded pass is not every lifetime race or proof of physical GPU EP.
Current Desktop indicator shows LFM3 error after activation; do not claim inference
healthy or disable it.165 covers renderer navigation/generation recovery, separate
from159 and110. Previous CmdR failed with stale generation after unknown ownership;
ModelLease.lost handling inherited owner and page-local generation are source leads,
not a proved cause. Revalidate and use existing queued lane.

## Retained verification, ownership and preserved backlog

156 original taskefd19c25-909e-4b06-aa4b-b6411785b4f7, attempt
ff55fda4-7c0d-4a43-b295-cdc29deefd1d, worker507e57d..., artifactb01121b is
ACTUALLY accepted through retained operation34d2518c-4a7a-41ad-bb69-59943b6fd87d,
with one original implementation prompt. Models176pass, quality/build exit0;
24check resource rows removed. Operation worktree cleanup remains independent.
No replay proof/model turn. Gen1/2 failed setup history remains preserved.
Root fixes: e36a42c private native-startup dependencies,63d5001 standalone Bun in
compiled host,62b0170 private test cache; final31tests/375assertions. Native worker
00c20ad fixes sealed-quarantine admission but alone does not include Root fixes.
See retained156-native-observation-20261106.json and native-worktree-dependencies
review. Tests and real checks are evidence, not hashes.

138 task0d18d8c6-959f-4b0f-9f37-bb79c5aee0c4, plan
e48290a6-a871-42a2-94f1-c88f700c0d11 stillBLOCKEDv78 on native-no-proof-turn human
gate. Current owner5c1563b654ed441990b217eb2006ef2f paged historical notices rather
than current review. Its parented Architect UI is read-only. Main must deliver a
concrete native assignment using actual gen3proof; no manual SQL or history wipe.

163 ownership/continuation correction must support authorized reassignment AND
renewal: native launch parent is history, not current plan authority. Preserve
exact recorded worker/attempt/project/workspace/route/input and owner epoch fences;
do not invent archived-predecessor ancestry ceremony.162 overstrict draft cancelled.
164 is compact retained-operation/check/cleanup inspection, not new scheduling.

Tasks148/149 follow prerequisites;149 advice3 covers refresh temporarily clearing
worker activity to Unknown. Preserve exact scoped stale observation, never invent
current activity.147 legitimate accepted work remains cleanup-blocked separately.
131timestamps,139historicaltrajectories,155current-market trajectory valuation,
154same-worker steering remain. Current157/158timeline duplicates identical check
receipts; Main recorded this under existing155 follow-through.151/152 connected
pricing/visual gates are not all closed by the narrow Refresh observation above.
153 integrated/cleaned. Advice320character cap is removed;4tests/59assertions pass.

Full scope stays open: Tasks ordering/grouping, live Radar agent/model/tool/file/
message/health monitor, model/persona metrics and selection, proactive recovery,
structured verified handoffs and useful skills, two actual implementer live-probe
correction/reprobe walkthroughs, scheduler renewal/performance, audio, packaging,
installation/upgrades and cross-machine dogfood. Preserve queued work and retained
artifacts; use README, roadmap-execution.md and design/roadmap.md for full contracts.
