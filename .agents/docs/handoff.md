# LAZERS current handoff

Updated 2026-11-04 after ordered price-source integration. Recheck native state;
source landing, task acceptance, effective activation and cleanup are distinct.
The [previous checkpoint](evidence/handoff-20261103-retained.md) retains historical evidence.

## Immediate order and ownership

1. **Root scheduler repair is integrated:** source `bfdc6e1`, merge `cba6ab2`.
   One process-shared deadline timer coordinates project reconciliation and lease
   heartbeats. Manual Task Start joins the elected runtime; failed lease claims
   no longer strand the running flag. **138 runtime tests / 2,544 assertions**
   and **15 coordinator tests / 50 assertions** pass; quality checks pass.
   Source reservations are released. The clean native worktree
   `/private/tmp/lazers-shared-scheduler` remains for independent review and
   non-forced native cleanup. Reuse `sharedScheduler.snapshot()` in diagnostics.
   **Effective activation and sustained improvement remain unproven.** Desktop
   explicitly locked before Root could send the commit handoff; unlock requested.
   See [measurement and limits](evidence/native-scheduler-performance-20261104.md).
2. **LZ115 → LZ116** run in plan `338bebc5-557a-4135-86dc-de7a4c304975`:
   repair reconstruction ownership/fairness, then add authorized read-only
   aggregate diagnostics. No index edits; coordinate any need with Root.
3. Finish this bounded efficiency lane, then **stop adding worker dispatch ahead
   of a finite quiet activation boundary**. Root can coordinate Desktop observation.
   Preserve active workers and all six inference settings. No unrequested restart,
   WebGPU disable or profiler activation.
4. At that boundary verify loaded source; collect sustained CPU and actual wake,
   tick and native reconstruction counts in matched no-worker and working windows.
   No historical public tick counter was found: timer arithmetic is not a measured
   baseline. Do not invent missing before counts or claim improvement from tests.
5. After effective activation recover **LZ103's same attempt**, preserving failures,
   then record supported integration to release ledger/UI/manifest work.

## Source and native state

- Main `0b058dc` integrates **LZ112 `58f865e`**: ordered price-source settings and
  source-aware v2 decision contract. Independent review reproduced one update and
  one conflict across actual pinned loader generations/separate storage wrappers.
  Own merged Models/chart checks: **97 tests / 1,348 assertions**, quality passed;
  candidate GUI build passed. Task/combined integration recorded at plan v17/v18;
  native non-forced cleanup requested, tree still present at last inventory.
- Main also contains **Root resume fence `484cedf`**, merged `f3971af`: version
  recheck after async owner inspection. **158 tests / 2,835 assertions**, quality
  passed; Root's clean repair worktree was removed through native non-forced API.
  **Live scheduler activation has not been established.** Native `location.reload`
  is server-wide; tool/agent registry reload does not recreate `TaskRuntime`.
- **LZ103** task `969c383d-a616-482e-a4af-7b4c7707f03c`, plan
  `8f369d22-6ca9-494e-9a38-5f4670bedc5c`, last v39 blocked/cancelled. Retain attempt
  `3cd4e4c5-113d-4a46-a824-75cf38c256b5`, session
  `ses_4e70382928c9434d81f7ee1ca4f14dc5`, and its original failed attempt.
  Classification `b16344d` + fixture `73ad2d5` are merged with Root `310439c`;
  merged suite **824 tests / 8,982 assertions** passed. Historical native suite
  exit 1 and exit 137 remain failures. Resume at 1793790431281 was cancelled at
  1793790431286 by the stale-snapshot race. Do not repeat before fix activation,
  reimplement classification, invent a receipt or force acceptance.
- **LZ111 `18cad56`** task accepted, combined plan
  `446f3b7a-987c-41c4-85ae-8328a0322d54` v18 blocked on native-efficiency evidence.
  Own **83 tests / 703 assertions** and quality passed, but review reproduced:
  inconsistent mixed-case cursor ordering can starve history; a retired unresolved
  read retains drain ownership; dirty-during-await test missed unchanged-assignment
  content changes. LZ115 corrects these; LZ116 supplies bounded observation.
- **LZ115** task `471a3825-d4e3-4c0d-899a-e0e33209d615`: transfer recovery while the
  old promise remains unresolved, fence late continuations/finally, fair cursor,
  exactly one dirty follow-up. Logical retirement is not physical cancellation.
  **LZ116** task `75de476a-3007-4263-8178-912e01d6611e`: existing Observability RPC,
  project-authorized aggregate calls/outcomes/participants/queues/generations;
  distinguish logical ownership from retired outstanding requests. Reads must not
  create/register/scan/drive recovery, leak content or claim native idleness.
- **Valuation remains unmerged:** original LZ102 `266dd762`, LZ109 `3cef021`, LZ114
  `eabbc17`. Own LZ114 **14 tests / 109 assertions**, accounting **38 / 447** and
  quality passed; driver agreed on those tested cases. Independent review found
  two remaining P1s: route-less retained-message recovery erases known A, and
  orphan stream/end/failure borrows unrelated current A. Require complete per-call
  evidence resolution, not another blanket event exception. Preserve all accepted
  artifacts/history; no source integration or production-pricing claim yet.
- **LZ110** plan `2aa51f63-fd41-4510-92a6-6bad700d8880`, last v8 cancelling;
  original `addfb6ee` / `ses_34c9ce29a6d548cda5ffa21144ad41aa` retained. Native
  worker failed with a transport timeout, empty current controls/shells, all three
  effects complete, background unknown. Reconciliation requested; no replacement.

## Energy and permission evidence

- User reports sustained high CPU. PID95968 measured 109% then 48–60%; later
  snapshots differed. Own 07:02:32–07:02:48 sample: **51.6, 63.8, 75.1, 88.2%**;
  first `top` sample's 0% is not an interval measurement. This was not a controlled
  idle/working comparison and has no actual tick counts. Other Rust/GPU/renderer
  activity neither identifies LAZERS CPU attribution nor explains earlier reports.
- `/private/tmp/lazers-driver-observations-20261104.jsonl` and
  `/private/tmp/lazers-opencode-energy-20261104.sample.txt` retain driver evidence.
  Unsymbolized Bun/JIT and SQLite stacks do not identify an exact JS function or
  prove ONNX causation. Repeated registration reads/timers are amplification risks,
  not measured improvement before activation.
- Expired `per_1a3b281a9001MXGLEDxRyTZ54n` belongs to LZ110's session above; direct
  native pending inventory is empty. **Never reply/retry that absent request.**
  No LAZERS reply caller or generated-client 404 retry was found. Installed Desktop
  `auto-approve.ts` retries errors and can retain stale local requests between
  reactive sweeps; its data-layer helper instead settles PermissionNotFoundError.
  This is an applicable client mechanism, not proven live PID attribution. Do not
  purge unrelated permissions, modify private state or claim the client loop stopped.
- Worker read requests: inspect exact location/session, approve only authorized
  project reads once; no writes/broader access. Read-only Open worker child lacks
  permission controls: bounded Desktop/recovery follow-up remains open.

## Dependencies, product rules and retained resources

- LZ106 ledger waits for LZ103 integration. LZ108 coupled UI/controller waits for
  LZ103 + LZ107 + LZ112; explicit `openai/gpt-6-luna#max`, persona `ui`.
  LZ113 manifest removal waits only for LZ103's actual fixture-file overlap, not
  vice versa. Preserve two Git observations, real bindings/receipts and containment;
  narrowly ignore legacy `candidate.manifest`. It is not a new product gate.
- Pricing: configured **OpenRouter → OpenCode**, whole-model fallback when a quote
  or needed rate is missing; never blend categories. Preserve source provenance,
  exact provider/model/effort and all tokens. Charges/subscription zero/empty
  `cost:[]` are not market prices. Published applicable zeros require provenance;
  ambiguous quotes/tiers stay unknown. Quote adapters/index/valuation, settings UI,
  decision producer/server and final real-data narrow/wide Desktop/Tera acceptance
  remain open. Keep canonical rows and exact configurations separate, global
  frontier before paging, all failed/retry effort per genuinely accepted task,
  zero-accepted rows without coordinates. Estimates sample accepted logical-task
  histories including their retries; label separately; n=1 is one value.
- LZ100 + LZ107 chart source merged `95904a7`; component acceptance is not the full
  Models product. Failed Go LZ104 stays cancelled; no replay/substitution/paid OR
  inference. Preserve native v1 fonts/theme/split/scroll and reopen protections.
- LZ72 retains immutable `e6a58ea`; uncertain old `verify:runner`, child containment
  and reservations still strand LZ88/LZ99. Research found **no current supported
  independent-candidate source-adoption escape**: adopt-descendant still requires
  conclusive worker idleness and no uncertain effects/reservation conflicts.
  Fresh evidence must have its own owned operation and cannot replace an old
  missing receipt. Inspect exact current tasks before proposing a narrow supported
  recovery; no guard bypass or equation of cleanup with source validity.
- Cleanup holds: LZ105 v15, LZ100 v17, LZ107 v23 and earlier LZ94/95, LZ97, LZ101.
  Clean merged trees/empty foreground controls do not prove background idleness.
  No force, private-state injection, wake/replay or unchanged retries. LZ98 native
  cleanup completed. Integration dependencies need not wait for deletion.

## Full roadmap stays required

Authorities: [roadmap](../../design/roadmap.md), [execution](roadmap-execution.md),
[phase review](phase-review-plan.md), [proactive recovery](../../design/proactive-worker-recovery.md),
[live verification](../../design/live-product-verification.md), [handoffs](../../design/recovery-handoff-contract.md).

Retain R2–R6 struggle/cook/check-in/steer/reassess/handoff; complete worker handoff
verification/submission and continuing-worker consumption; V3–V6/N1 real-instance
two-worker correction/reprobe and measured effort; Models; Tasks/Radar/Trajectory
filtering/live flow and retained LZ80 acceptance; supported repair/reverification
and renewal/archive; progressive skills/agents; one public plugin with clean
install/upgrade, backup/restore and cross-machine checks; final requirement audit
and improvement proposal. No launch announcement or completion claim yet.
