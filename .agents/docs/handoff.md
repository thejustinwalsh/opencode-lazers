# LAZERS current handoff

2026-11-01, 18:42 UTC checkpoint. Runtime records are authoritative; recheck before
acting. Full goal: all four phases in `design/roadmap.md`, then an observation-based
improvements plan. This is not completion. Read [README contracts](../../README.md),
[pinned API](opencode-api.md), [phase decisions](phase-review-plan.md) and
[execution map](roadmap-execution.md).

## Desktop dogfood and roles

Native Architect `ses_e68a9ed37ffeVqzPWRXN5SB7Uw`, “Build LAZERS roadmap”, uses
`openai/gpt-6.1-sol#high`. Initial uncoached ask:

> Here is the agreed plan: design/roadmap.md. Let's build it.

Root acts as user through Desktop Computer Use, answers material interviews,
observes, reviews/integrates and fixes genuine blockers. Do not spoon-feed task
decomposition. Architect researches/interviews, creates small tasks/dependencies,
requests execution and returns for review/decisions. Scheduler owns dispatch/state.
Implementors use native sessions/worktrees and `openai/gpt-6-luna#max` during tuning.

## Current work

| Ref      | State                                 | Next boundary                                                                       |
| -------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| LZ-28    | Resume queued; same attempt preparing | Scope conflict with active Radar; retained repair and native lifecycle proof remain |
| LZ-31/35 | Integrated and cleaned                | Privacy evidence retained                                                           |
| LZ-32    | Integrated and cleaned                | Historical navigation/filter proof retained                                         |
| LZ-33/34 | 33 running; 34 queued                 | Data worker 213639c4 on Luna Max, then SVG/ELK UI and native/Tera review            |
| LZ-36    | Resume queued; same attempt preparing | Concise brief delivered; waits on real scope conflicts before expiry repair         |
| LZ-37    | Integrated                            | Trace clocks are diagnostics, not a freeze fix                                      |
| LZ-38    | Accepted retained source; on main     | Same-attempt resume worked; graph native compatibility remains open                 |
| LZ-39    | Verifying; native observation hold    | Reviewed 351a04f prepared on main b77d981; ordinary Desktop proof remains           |
| LZ-40    | Integrated                            | Directory evidence support, no acceptance waiver                                    |
| LZ-41    | Integrated v11; cleaned               | Effective backend activation confirmed by real retained LZ-38 resume                |
| LZ-42    | Integrated v11; cleaned               | Failed-to-resume transition exercised by the original LZ-38 worker                  |
| LZ-43    | Running on Luna Max                   | Healthy-time profiler controls, then actual correlated Desktop capture              |

- **LZ-28** plan `8253ff59-57a5-45fd-8847-acd971438af8`, same attempt
  `941526b0-62de-4578-b82e-f2a458c95358`, session
  `ses_0837d798635a4b10a58e1fdc9175854f`. Root answered the native scheduling question:
  pause briefly for LZ-41, then resume this same worker/session/workspace/history.
  Resume is recorded at v37; the attempt is preparing behind active scope conflicts,
  not executing model work yet. Its dirty partial repair remains preserved.
  Candidate `7e02ce0` is unsafe; independent native review reproduced cancellation
  stalled by recovery, invisible mutable results, concurrent admission stranding
  identity, cross-project recovery and stale checkpoint coverage. Repair is in the
  retained tree, not accepted. Preserve `2536084` receipt lookup repair. See
  [review](evidence/architect-context-lifecycle/retained-source-review.md) and
  [protocol](evidence/architect-context-lifecycle/reconciliation-plan.md).
- **LZ-36** task `68a72431-87af-4bce-8e7b-77f430aeb100`, plan
  `1fab1396-5f6b-45cc-a148-5eff48182ed9`, same second attempt
  `29659c51-4151-4c61-8951-4482b6089b7e`, session
  `ses_d82453d7170e4facb78c60fcc89cdbc1`. Candidate `c1e2977` fixed selected live
  payloads. Mounted combined source `214adcb` additionally fixes actual native
  `basis: null` report decoding; LZ-38 and old LZ-9 now render. Loaded history
  persisted, but expired Load more shows `[object Object]`, then healthy status
  erases the error; Retry does not recapture. Actual native RPC probe returns only
  RpcInternalError “RPC call failed”. Architect acknowledged retained repair using
  the existing typed native RPC error surface. No mounted acceptance. See
  [observations](evidence/stable-live-trajectory/native-observations.md) and
  [remaining checklist](evidence/stable-live-trajectory/native-checklist.md).
  The concise expiry brief is now installed with exact native keyed readback;
  previous instruction, identity/route and busy/idle timestamps were preserved.
  See [delivery receipt](evidence/stable-live-trajectory/expiry-instruction-delivery.md).
  Instruction delivery itself did not prove consumption. Explicit resume is now
  recorded at v18; the same attempt remains preparing behind scope conflicts.
- **LZ-38→39** plan `e2cfb569-7c01-4b6c-9bdc-a0e4ae10b89a`, v19, is held only
  for `native-recovery:human`. LZ-38 continued in original second attempt
  `2f9e5b2e-8fc8-488b-a778-5f9610b5fcdb`, session
  `ses_179e4f628f2f4ba8a4e22e99214adddd`; no source edits or fresh attempt were
  needed. `071b5c1` passed its checks and landed on main in `9f629db`.
  LZ-39 task `99d6b8cf-1eea-4f6c-98ff-27afcd8a6240` ran next through runtime,
  attempt `73a87f31-e426-4a18-b660-16d9b2b3c199`, session
  `ses_eb06e02908524b91b32a465069df2b69`, returned `351a04f`. Root checked its
  narrow positive loss signature against pinned ORT source and independently
  passed five adapter/lifecycle tests / 25 assertions. Reviewed source is prepared
  on main `b77d981`; no native compatibility pass or freeze-fix claim. Existing
  ordinary review/navigation/question/decision/speech/model-switch gate remains.
- **LZ-41** plan `c4f5e9be-9b81-4914-a3a5-24dfd14f345c`, task
  `312a2e4f-ec16-4608-bc66-2f428a6dbf07`, attempt
  `06d7c1b9-7592-43ed-9057-b3328b4169f7`, session
  `ses_4863cad4d7834d9c9a7d684b7713a058`, returned `bdb26a0`. Ordinary merged Git
  baseline accounts for admitted prerequisites plus incorporated reviewed main;
  unauthorized worker edits remain checked. Root found no blocker, independently
  passed 11 focused tests/92 assertions and 415 full tests/3,886 assertions.
  Runtime combined checks passed after normal reconciliation; the earlier failed
  truncated receipt remains without an inferred cause. Source merged in `63d828a`;
  runtime integrated v11 and native registry/filesystem confirm non-forced cleanup.
  Full independent rerun log: `/private/tmp/lazers-lz41-full-suite.log`.
- **LZ-42** plan `bff93c8b-3be6-4b4e-8a51-affcf42a8b60`, task
  `af0199a8-8c28-4fdd-b410-96f31eabf0c4`, session
  `ses_60b7ffe6a5ae4aa2ab5230b8230c8dbf`, attempt
  `e7ee71ef-75ad-4baa-a89e-796ed3c8376f`, returned `fd4e474`. Additive failed→RESUME
  fixes a real mismatch with the existing runtime command, without migration or
  a new retry lane. Root source review and six focused tests/143 assertions pass.
  Accepted v9 after normal reconciliation; source merged in `86835fb` with
  17 combined focused tests/235 assertions, 418 full tests/3,939 assertions and
  quality passing. Runtime reached integrated v11; Root verified the owned worktree
  removed. Backend activation and actual retained LZ-38 RESUME succeeded.
  No GUI build/reload accompanied either harness source merge.
- **Radar** plan `b0eb89b4-a071-49e2-a238-c474d53cc42f`, LZ-33→34. LZ-33 is
  coding in attempt `213639c4-fa4c-466f-8ae7-b6b869f7c1ca`, native session
  `ses_b60b5730aa0e43ac82e86d004f6ec2f4`, OpenAI Luna Max. Root observed actual
  native tools and the worktree in Desktop. LZ-34 has no attempt yet. Narrow panel,
  details below, native fonts/theme, C4 SVG/off-renderer ELK and evidence-linked
  activity remain the target; Tera screenshot review follows mounted UI.
- **LZ-43** healthy-time profiling, task `a357012b-1ace-434f-beb5-235623f30154`,
  plan `2af3a7c6-f1ea-4c7e-a455-9b6b7a4c094d`, attempt
  `42379578-3c87-4434-ae2d-19a5721684e5`, session
  `ses_50fc4d5372be4244b316e7f4989b7fc4`, is running on Luna Max. This addresses
  the real automatic capture's too-late Profiler.enable timeout. Architect
  researched, specified and dispatched from Root's ordinary feature request.
  Root's measured profile-size finding was attached as optional native guidance.
  A usable correlated profile from real Desktop work is still required.

Owned trees: `~/.local/share/opencode/plugins/lazers/runner/worktrees/<attempt>`.
Retain unmerged work; native runtime cleanup only after reviewed integration.
Native plugin.list proves main and worker locations already load the canonical
project plugin; do not invent another loader.

## Native evidence and remaining scope

Matched freeze [report](evidence/renderer-freeze-20261101T1540/report.md), `0f75340`:
window 1/PID 77897, request `11a8cb1f-ce2c-45db-ae91-949094f3f1ff`, eight questions /
2,087 actual tokens. Last run mark is pre-call, not proof of `_OrtRun`. Automatic
profiling timed out; unsymbolized V8/JIT/GC sample does not establish a cause.
Desktop-only Relaunch recovered interaction, not a proven fix. All six local
features remain ON, apple/WebGPU, idle Never. LZ-14 stays cancelled; do not revive
its abandoned isolation stash. No new confirmed freeze in the subsequent mounted
history/worker navigation observations.

Root saved a bounded 28.06s native DevTools performance recording at
`/private/tmp/lazers-native-profile-20261101T1308.json.gz` with screenshots and
source contents/maps excluded. It contains healthy UI/polling, not local inference;
it does not capture the later advisory device-loss failure. Renderer PID 80774's
profile chunks introduced 6,766 node entries at DevTools' sampling rate; this is a
qualified usability finding for LZ-43, not a mandated replacement cap. Raw trace
stays local and must not be dumped into model context or committed wholesale.

Desktop later displayed local-model transport timeout, with all six features still
ON. Supported window-only Reload restored Ready; native workers/identities remained.
DevTools is closed and the temporary GUI-build hold is released. No service restart
or manual inference-setting change was made. This is recovery, not causal proof.

LZ-39 also confirmed a fresh-worktree setup failure: full tests initially lacked
ignored `.cache/lfm3-engine.js`, then passed after build preparation. Native
Project.commands.start is now configured for dependencies and the pinned engine
in this development project. Architect reported clean-checkout validation passing
420 tests / 3,945 assertions; Root independently read back the native configuration.
Actual hook execution remains to be observed on the next worktree creation.
This is project setup, not a plugin-wide Bun installer or added agent reminder.

All remaining roadmap phases remain: Radar/stable Trajectory/compatible freeze
repair; whole-feature measurement and dated OpenRouter fallback market pricing;
live hierarchical persona mappings, Models DB/panel and provider/model-aware
Architect idle policy; conversation-led revisions/research; usable installed
package, restart/upgrade/backup/release and cross-machine real-task proof.

## Operating boundaries

Use Desktop CUA for prompts. Read-only pinned SDK and supported native maintenance
are authorized. Bounded status/tool reads avoid full-context polling; actual
busy/idle matters, old succeeded alone does not mean idle. One plugin, no custom
daemon. Normal tools/Code Mode stay available; workers do not spawn agents.
No catalog veto, silent fallback, invented budgets or source-hash proof. Keep JSON
validation and `lazers_verify_task` Architect self-review.

GUI builds hot reload local inference: activate only at an observed Ready/quiet
boundary. Root ended the `214adcb` mounted pass after reporting expiry; a corrected
candidate needs coordinated activation and remaining real interaction proof.
Model-only JSON configuration `54e4ecd` preserves the effective packaged worker
role; native main/retained worker readbacks match the shared role. See
[configuration proof](evidence/worker-role-precedence/report.md).
Bun: `/Users/tjw/.bun/bin/bun`. Load Portless before project listening servers.
`.agents`/Git writes need escalation; never print service credentials.
