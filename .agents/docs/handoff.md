# Current dogfood handoff

Updated 2026-11-07. Goal stays active: drive OpenCode Desktop until the entire
roadmap is implemented, verified, integrated and cleaned, then propose observed
improvements. This file is a locator; native runtime/API state is authoritative.
Older details remain in Git history and linked reports.

## Working rules

- Model prompts through Desktop CUA; read-only SDK/SQLite diagnostics are allowed.
  No production SQL repair. Root fixes concrete blockers and reviews/integrates;
  ordinary implementation uses native Architect and LAZERS.
- Architect OpenAI `gpt-6.1-sol/high`; implementors/research OpenAI `gpt-6-luna/max`.
  Use native Tera High for actual screenshot review, not mockup-to-components.
- Preserve original workers, useful work, attempts and failure history. Native
  runtime owns task state and cleanup. Use OpenCode worktree APIs.
- Evidence is tests and actual product behavior, not source-content hashes.
  Keep schema validation, Architect `lz-verify-task` self-review and advisory
  System One. No invented budgets/provider bans or fabricated idle records.
- Six inference flags ON, idle unload Never; preserve downloaded models.
- Coordinate server source activation at a real implementation-quiet boundary.
  Do not stop healthy workers to manufacture one. GUI-only reload is separate.
- Read README and `.agents/docs/opencode-api.md` before integration changes.
  Original brief is cached at `.agents/docs/sources/original-design-brief.md`;
  subsequent user decisions override it. Project listeners require Portless;
  native OpenCode follows its own supported lifecycle.

## Current source and native coordinator

Canonical source180 landed through `d2f4a79`, corrected174 through `3e47b2e`.
Formatter-tool fix `28066f4` and the tasking tune are ancestors. Revalidate HEAD.
Architect `ses_e568438ebffeaoFbF9nBb942XM`, service PID3219; revalidate both.
Desktop CUA is usable after native webview reload. AX indices move while streaming;
read fresh controls. Native `typeText` worked when paste silently missed. Verify
actual composer value and submission receipt. Avoid unnecessary app restarts.
Read-only helpers in /private/tmp include lz-native-all-presence.ts,
lz-current-public-tools.ts, lz-latest-text-only.ts and
lz-live-plan-summary-20261107.ts. Do not dump full transcripts or hidden reasoning.

## Tasking correction and next delivery

User correction is task sizing, not a state-machine replacement. Preserve research,
interview/clear intent, then planning. Features are default tasks; split for useful
independence, parallelism or capability limits. Group context/interfaces and related
fixes/tests with one implementor. Reconcile requirement meaning, not concatenated
historical constraints. Source0cf0ee1 is verified loaded through public agent.get;
research/interview/self-review and unrestricted normal tools remain. Research:
`design/reviews/llm-work-decomposition-research-20261107.md`; audit:
`design/reviews/architect-tasking-tune-20261107.md`.

Native Architect consolidated only zero-attempt pairs170/171→181,148/149→182,
160/161→183, preserving external dependencies/priority and original histories.
The three successors have zero implementor attempts at last check; don't equate
plan running with dispatch.182 now follows147only,88 follows72only after actual
source/interface audit; no fake138acceptance or release of72unknown check.
Report: `design/reviews/tasks-prerequisite-audit-20261107.md`, commit783730f.
Duplicate live trajectory receipts were reproduced and folded into queued131
producer/projection/render scope and advice, not a new microtask. Optional current
producer-contract lesson is in implementation-notes.md. Do not cancel/resubmit
consolidated features just for prose polish.

LZ180 original candidate `2ad21e7c4bce696c6f0e5d2966a409d1b1221a0f` is merged.
Plan002c3469-5346-4d74-a21f-6991eb52eeec source integration is recorded;
cleanup-blockedv21 at Unix1794082548065 preserves the original unknown-idle tree;
original node/attempt accepted, worker genuinely idle after success. Generation2
operationd723d59e-0285-4926-9a51-f958b80fe309 accepted after task+combined lifecycle
and quality receipts all exit0, unchanged and cleaned. Do not retry unchanged
cleanup or invalidate delivered source; preserve historical unknown-idle resources.
Do not reimplement/remerge/rerun checks absent changes or concern. Generation1
2c86b98f... was cancelled after scoped formatter binding blocked before checks.
Root28066f4 fixed that exact parser gap (16tests/strict pass). Existing reconcile,
not worker resume/run, promoted accepted nodes from blockedv17 to runningv18 for
same-generation deferred combined checks. Report:
`design/reviews/lz180-retained-integration-20261107.md`.

LZ174 corrected original candidate `5e1d9ed6756bcc3ff73911c7325b7770498e564d`
landed through3e47b2e after independent native Luna review. Source-content scanning
was removed; native/control/task checks remain. Existing generation2
`a5aadd33-556a-4785-acad-0b62129b2709` passed task and combined continuation,
runner and auto-fix quality checks. At Unix1794084309704 the whole plan was
acceptedv26 after Architect recorded actual original172 substantive recovery.
Native integration is recorded; cleanup-blockedv28 preserves unknown-idle
original resources. Do not retry unchanged cleanup or invalidate the landed source. Report: `design/reviews/lz174-67d4e6d-source-review-20261107.md`.

LZ172 original attempt14b02650/session83bd7a96 delivered clean0d210a8 after
advice6 (59tests/1507assertions, quality/GUI pass). Real connected Desktop preview
FAILED blank at16:34:07.547: knownUsageSourcePresentation missed current producer
openrouter-models/native-catalog values because the worker's old contract had
only openrouter-endpoints. Report: `design/reviews/lz172-connected-preview-failure-20261107.md`.
Both canonical ignored GUI assets were restored from
`/private/tmp/lz172-gui-preview-vzt9ofm_`; renderer-only reload restored the prior
chart. No source integration or visual pass. Original worker is actually running
again with advice7 and narrow authorized market-range contract/test scope v87.
Direct blocked-plan retained-repair succeeded at1794087513056, operation
1e7655fb-a0e5-4068-b7aa-303fa5b4ecef, then prompt completion/dispatch on same
session/attempt/workspace/route. This observes deb9a09's direct admission path,
not UI correctness. No new task or wholesale backend copy. Need corrected
rendered current-producer tests, connected preview and native Terra visual review.

Root ffa8f6f fixes idempotent worker-mailbox detach after expiry; stale detach
cannot disconnect an active replacement, and queued undelivered jobs survive.
Original-code regression fails;11tests/89assertions + strict auto-fix pass.
Actual ownership-error loop stopped after source edit and native local probe
returned localGPUready19input/4output. No forced backend reload occurred; automatic
approval rejected global location.reload while a review was still streaming.
Do not bypass it. Actual source activation identity was not proved by status
alone; residual renderer/GPU-helper CPU remains15%/34% despite recovery.
Reports/profiles: `design/reviews/inference-detach-recovery-20261107.md`.

## Verified and landed this pass

- Cache close recovery: native window close now releases its ownership reservation
  after drain; document reload keeps same-window handover. Actual two-window test:
  remaining window recovered automatically after owner close, served chat and d1.
  Model files/settings preserved; service3219 and native177 worker continued.
  Report: `design/reviews/webgpu-closed-window-recovery-20261107.md`.

- LZ-165 original worker `b108d38`+`1833b65` landed through `27c7184`; native
  Architect recorded integration and verified non-forced cleanup, no pending
  effects. Actual Desktop chat/d1 and repeated webview reloads worked. Cached
  models/settings preserved. Review: `design/reviews/lz165-b108d38-source-review-20261107.md`.
- LZ-175 repaired clean same-worker descendant qualification: `312dabd`, `c135109`,
  `7727cc4` integrated `cbf20ee`. Four independent-review findings resolved.
  Actual original173 generation2 qualified and accepted corrected0b despite old
  recordedddef/current idle unknown. Report: `design/reviews/lz175-bootstrap-implementation-20261107.md`.
- LZ-176 supported existing mixed build/test/quality procedures: reviewed `e1a6f8d`
  plus test-only `831d468`, integrated `4560a55`. 87tests/871assertions, strict/GUI
  pass. Native generation2 actually executed the unchanged authored chain.
  Report: `design/reviews/retained-procedure-composition-20261107.md`.
- Both Root175/176 review checkouts were removed through native force:false;
  do not reuse removed paths. Old dirty/unmerged checkouts must be inventoried
  and preserved, never broadly deleted.

## LZ-173: source landed and actual product observed; control still held

Original task `50630f61-d966-43b5-b349-9f39e85ea014`, plan
`ba5744d0-2657-4f93-b006-44ca0b176108`, attempt
`4d783df7-eb05-463c-b4db-df48a5c308c5`, worker
`ses_145885557d454551815079ab36bd9c24`. Original reviewed commitsddefc44→0b28972
are preserved; attempt now mechanically accepted exact0b.

Native retained op `e5c0d438-21c0-4b21-9039-ec9d246264f6`, generation2, passed all
SIX task/combined pricing/trajectory/quality checks; all72check resources removed.
Actual timestamps/receipts: `design/reviews/lz173-generation2-native-checks-20261107.json`.
Old156held authority was retired with existing native cancel control, preserving
its unresolved comparison/history. Old173generation1 was retired similarly.

Architect made native integration worktree
`/Users/tjw/.local/share/opencode/worktree/b5da4c/lz173-canonical-integration-20261107`,
merged checked0b as19d62a6. Broad tests found24failures: stale ledger fixture
schema and Root897 eager Node process getter. Root repaired ONLY main.ts and
ledger fixture in1981d7a, released all reservations. 329tests/3290assertions39files
and strict/GUI pass; both focused reviews returned. Architect fast-forwarded main,
built canonical GUI and recorded TASK-level integration (plan87→88).
Worktree cleanup belongs to Architect; it is clean/merged, not an original worker.
Report: `design/reviews/lz173-integration-repairs-20261107.md`.

Root fully quit/reopened Desktop, searched real LZ-137 in Project/All Tasks,
opened its Trajectory and published-rate details. Actual consumer shows
**$0.01598662 estimate**, OpenRouter generation168/average/current,19retainedcalls,
published base/tier rates. Actual product behavior passed; no fixture inserted.
Report/screenshot: `design/reviews/lz137-connected-market-observation-20261107.md`.
Root delivered this evidence to the same Architect via Desktop.

Recording own source integration advanced plan87→88 and put retainedg2 in held
`Retained verification owner, plan version or execution authority changed`.
Keep six passed receipts and genuine product observation. Do NOT create another
verification generation/rerun solely for metadata or invent quiescence. Architect
is tasking legitimate benign-integration reconciliation with existing heldg2
recovery; genuine owner/spec/input/candidate changes must still fence. Task/plan
human evidence follow-through remains pending; no whole-plan completion claimed.

## Other retained runtime work

177source is integrated;175/176 were actually fulfilled through native controls
while cancelled executor history/zero attempts remained. Original177 checkout
cleanup remains blocked on historical missing idle. Do not retry unchanged
cleanup or invalidate delivered code. Its separate integration checkout was
removed natively. Report: `design/reviews/lz177-native-completion-hold-20261107.md`.

178 benign integration rebind is genuinely running: task095a9e75-3731-4834-9d67-f4293c260636,
planc68342dc-d51e-42cb-98ba-287067e51a5f, attempt14fca257-f6e7-44ad-baa8-109167e49c50,
worker ses_f3b9ac74651745adb91015eb6f5a416a (OpenAI LunaMax). Candidate
`c41648b524011574a927af3ab2a0825de8552e5d` is now clean, task/attempt accepted,
plan runningv12 for combined verification. Worker reports369 behavior tests,
quality/GUI build passed; named retained-integration.test.ts does not exist in
either checkout, so only four of five listed test files actually ran. No empty
file/new task is needed to conceal that authoring error; review real coverage.
Native SolHigh review ses_e48056a19ffe5lVI1Hv3e8wjgz is active, focused on
proportionality, duplicated proof paths and CAS versus semantic bindings. Source
review, integration, actual original173g2 reconciliation and cleanup remain.179 was never executed and cancelled in favor of180;
do not redispatch it. Source reservation diagnostics and timings are in
`design/reviews/delivery-bottleneck-20261107.md`.

## Full remaining scope and observation backlog

Priority remains Models, then Tasks/Trajectory, then Radar; preserve full roadmap.
Use `design/roadmap.md`, `.agents/docs/roadmap-execution.md`, original brief and
actual runtime tasks. Includes148/149 ordering/grouping;131timestamps/history;
160/161 managed overhead metrics (these are NOT Radar UI tasks); real Radar live
agent/model/tools/files/messages/health monitor; proactive recovery/handoff tools,
project verification guidance/skills and two actual failure/correction/reprobe
walkthroughs; coordinator renewal/cache lifetimes; audio; pricing/persona metrics
and assignments; packaging/install/upgrade/cross-machine dogfood.

Architecture review/ranking/C4: `design/reviews/architecture-review-20261106.md`,
`architecture-system-ranking-20261106.md`, `architecture-c4-20261106.html`.
Actual read-only snapshot `design/reviews/runtime-roadmap-snapshot-20261107.json`
recorded176tasks,123accepted nodes,51tasks in integrated plans and35in cleanup-blocked
plans; recorded states are NOT independent verification.177was created afterward.
Residual CPU/performance remains open; do not claim battery/freeze acceptance.

Observed UI improvements to fold into appropriate existing work: Tasks row IDs
replaced during live updates; headline price excessive precision/repeated label;
expanded basis exposes internal enum slug. Original approved Models mockup and
Radar monitor direction remain the reference; do not invent diagnostic-heavy UI.

## Latest connected Models preview — 2026-11-07

Root loaded ce72ed5 via ignored GUI bundles and native renderer-only Reload.
Actual connected project data renders; prior sourceLink crash did not recur.
Model selector changes Luna reference range and clicking Qwen mark selects Qwen.
Screenshots/report committed f5a78c7:
`design/reviews/lz172-ce72-connected-preview-20261107.md`.

Native Terra High session ses_e47f3391affevrhW239V5Jfv2r viewed actual narrow/wide
images and approved reference: BOTH widths still fail visual acceptance (clipped
axis/legend, selected label disappearance, oversized controls, diagnostic copy).
Main attached advice revision8 for ONE same-worker presentation repair; source
integration and acceptance remain withheld. Native review report:
`design/reviews/lz172-ce72-native-visual-review-20261107.md`.

Current ignored dist GUI assets remain ce72ed5 PREVIEW, source unmerged; rollback
`/private/tmp/lz172-ce72-gui-preview-jqi01e_4`. Do not forget preview on handoff.
Main Architect and original LZ-182 LunaMax worker verified live at1794089276397.
LZ-178 same-worker review correction waits for182 overlapping runtime reservation.
No backend-wide reload or active worker interruption was performed.

## Inference ancestry correction activated and observed

Root reproduced post-reload settings error Previous renderer ownership is unknown
in actual registered main/runtime fixture. storeGrant prunes ancestors but local
previousGenerationID stayed stale. Canonical2d545e6 traverses generation().previous;
regression failed before,21targetedtests/116assertions and bun run verify passed.
Canonical GUI build passed and host bundle update loaded it WITHOUT additional
renderer/service restart. This ENDED ce72 ignored-GUI preview: dist is canonical
again, though original rollback backup remains. Native settings Ready; local
prompt returned local GPU ready. Then native Unload from GPU→Unloaded→Reload
model→Ready→Run locally succeeded again(19input/4output). Sixswitches ON and
idle Never unchanged. Report design/reviews/inference-pruned-ancestor-recovery-20261107.md.
Main informed to preserve2d545e6 at later Models integration/preview.

Original172 same-workerrepair genuinely resumed at1794089363340;182stillactive.
Both native LunaMax sessions confirmed running1794089658825. Source acceptance
for Models still withheld pending repaired screenshot+interaction walkthrough.
