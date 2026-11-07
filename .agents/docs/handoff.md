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

Canonical main is `105e7af` at last check; source177 is integrated via `e2d75bb`.
GPU source fix `cbd66d8` is active in Desktop. Revalidate HEAD before integration.
Architect `ses_e568438ebffeaoFbF9nBb942XM`; existing service PID3219. Revalidate both.
Desktop CUA is usable after full quit/reopen; current view is real LZ-137 Trajectory.
Native queued prompt **Steer** can deliver time-sensitive coordination. Verify
receipt/response; the user-only diagnostic can briefly lag persistence. Updated
helper `/private/tmp/lz-latest-driver-input-20261107.ts` includes synthetic inputs.
Avoid dumping full AX trees/tool results: filter controls and truncate long lines.

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

## Active native work and next steps

LZ-177 source7f8bd70 is integrated viae2d75bb. Native task/combined checks
passed (four receipts, exit0, cleanup complete); real registered tools recorded
175/176 fulfilled dispositions16/17, preserving cancelled/zero-attempt executors.
Whole-plan source integration is recorded. Original177 checkout cleanup remains
blocked on its discarded idle observation; do not retry unchanged cleanup or
let that invalidate delivered work. Independent integration checkout was removed
natively force:false. Report: `design/reviews/lz177-native-completion-hold-20261107.md`.

Actual active implementor is LZ-180, task834d8513-b419-45b5-b89e-d81041902b8d,
plan002c3469-5346-4d74-a21f-6991eb52eeec, attempt805fadf8-efa5-4df6-ac48-bd4e1443f02c,
worker `ses_dc161541d1334b14a156704f789ab9f5`, OpenAI gpt-6-luna/max.
Its native runner tree uses the attempt ID. Revalidate active status; Main has
handled a real once-only permission and reconciled permission holds. Preserve it.
It corrects genuine current idle-hook authority across listener replacement.
Original179 was never executed and cancelled;180 preserves behavior with disjoint
progress source/new test paths. Do not redispatch179 or duplicate180.

LZ-178 benign integration rebind: task095a9e75-3731-4834-9d67-f4293c260636,
planc68342dc-d51e-42cb-98ba-287067e51a5f, queued with no attempts. It overlaps
original174 runtime scope; scope contention, not a running implementation.
Read-only diagnostics and timings: `design/reviews/delivery-bottleneck-20261107.md`.

User's latest requirements: auto-fix formatting/lint in every current quality
workflow, capture fixes in the actual verified candidate without formatting-only
model retries; integrate completed prerequisites before dependent dispatch,
independently of cleanup bookkeeping.105e7af updates package verify, agents,
task-fetch/schema guidance and retained procedure recognition;25tests/164assertions
and actual verify pass. Runtime-owned mechanical candidate capture is not yet
implemented by that commit. Main is reusing existing170→171 for quality work and
researching existing148/dependency integration behavior. Native Luna read-only
researchers were explicitly told not to submit tasks. Keep full acceptance and
avoid another broad recovery framework; confirm actual dispatch, not plan labels.

Original174: task49dbfe29-b1af-4710-abfa-9268d61db228, plan
f33eddb3-c3f6-4f45-ac51-3a1f7ae47c23, attempt0375ef98-ff9b-456f-849d-2ed9da547920,
worker `ses_5210fab90d3745959a4d269dbd6ab744`, clean candidate67d4e6d retained.
Root rejects unchanged source: full untracked-file/base64/binary-diff fingerprint
gate. Preserve useful final task transaction fence; remove scan/gate and its
expectations in same worker via legitimate tooling. Review:
`design/reviews/lz174-67d4e6d-source-review-20261107.md`. Never merge unchanged67.

Original172 UI: task32810daa-f8dc-4c50-a2fc-f7000c480ad8,
worker `ses_83bd7a96b951462e9aa31f80043e8940`, retained0da6681. Recovery depends on174.
Needs actual narrow/wide Tera screenshot review and user acceptance; preserve work.
No massive stale handoff prompts, replacement workers or source quarantine as a
shortcut that makes the original worker permanently unable to repair.

After native task outcomes, review/integrate at safe boundaries, complete live
observations, record truthful native acceptance and clean merged worktrees.
Use independent research/review in background while ready integrations advance.

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
