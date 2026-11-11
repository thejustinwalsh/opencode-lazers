# Current dogfood handoff

Updated 2026-11-09. Goal remains active: native Architect/LAZERS must deliver the
whole roadmap, then propose improvements from observation. Runtime/API/DB state
is authoritative; this file is a locator. Earlier detail remains in Git history.

## Cleanup-first continuation and cancellation waits

This continuation supersedes older delivery observations below; native state is
authoritative. LZ-185 stays first, in its SAME recovered worker. LZ-195 final
`9c5e434` is reviewed and integrated in main `59b9578`, with native worker removal
and cache retirement confirmed. It preserves worker provenance and unavailable/
disabled limitations. Main quality, 11 registered controls / 133 assertions and
38 recovery tests / 515 assertions passed. LZ-201/LZ-164 are also integrated;
actual registered history paging is recorded in
`design/reviews/retained-inspection-live-20261109.md`. Manual cleanup is not proof
that LZ-185's automatic repair works.

Required sequence: **LZ-185 → LZ-154 → explicit SAME-worker LZ-182 continuation**.
LZ-154 no longer waits on Models/Tasks: those were coordination dependencies, not
functional producers. Its real prerequisites are LZ-185/LZ-199/LZ-195, reusing
`src/recovery/tools.ts` and `src/recovery/journal.ts`. LZ-182 remains temporarily
cancelled, not rejected or integrated. Original source, attempt and Architect
composition `1f3efb0` remain preserved. After cleanup/steering integration,
Architect explicitly continues that attempt for authorized-dependent continuation
and scheduling reads with 101 blocking reservations, preserving negative controls;
then composes, reviews, qualifies and integrates Tasks. Ownership guidance already
landed as `b42f512`; feature composition has not.

LZ-189 retains genuine source prerequisites; LZ-200 still requires Tasks source.
LZ-196 consumes LZ-154/LZ-195/LZ-199; LZ-192 consumes LZ-196/LZ-182/LZ-200. LZ-200
retains the single project-configurable limit, explicitly 3 here, across
implementers, Auditors and research/review helpers; Architect excluded. It is not
implemented yet.

Silent cancellation waits were reproduced: `runtime.ts:7376–7380` returns when
cross-plan integrated-source proof is absent, while `store.ts:2952–2988` exposes
only same-plan dependency waits. Public tasks consequently reported queued with
no reason and empty waitingOn. Proportional correction stays in existing work:
LZ-200 produces canonical prerequisite identity/state/wait reasons; LZ-196 routes
changed incidents and concrete deferred follow-up to the current Architect;
LZ-192 displays those facts and the owner action. Intentional cleanup deferral
must remain visible. Cancellation neither proves integration nor authorizes
automatic redispatch. Reads stay nonmutating; source gates and truthful unknowns
remain intact. Implementation and connected qualification are still pending.

## Standing driver role

When the user explicitly invokes dogfood, use
[dogfood](../skills/dogfood/SKILL.md) for the external Codex driver workflow.
Architect and workers retain their normal execution responsibilities. Direct
repair requests use normal development workflow.

## Current native observations (2026-11-09)

Runtime/API/DB state is authoritative. Architect remains
`ses_e568438ebffeaoFbF9nBb942XM`, OpenAI Sol 6.1 High. Main includes reviewed
LZ-199 (`efde8d1`), LZ-164 (`6b571c0`) and LZ-197 (`51fd20c`). LZ-199 and
LZ-197 are runtime-integrated; their native worktrees and cached locations were
removed. LZ-164's live paging failure produced LZ-201 rather than a fabricated
probe pass. See `design/reviews/native-progress-20261109.md` for checks and the
activation helper's lost completion notification. Original LZ-181/LZ-198 are
cancelled with useful work preserved; do not resume the failed original worker.

Urgent LZ-185 workspace lifecycle now has priority 4000 and no afterPlans. It owns
automatic cleanup after integration/cancellation/restart, resolved-hold retries,
stale activity reconciliation and owned review/verification resources. Its worker
is `ses_6a0c6753d66f4a90b413e2d2773fa6c4` (OpenAI Luna Max), in native checkout
`/Users/tjw/.local/share/opencode/plugins/lazers/runner/worktrees/3156909f-f2b7-429d-b50c-a9c879079a18`.
Provider transport failures stopped both worker and Architect; Desktop also showed
an OpenAI DNS failure. After current DNS recovered, the driver resumed Architect
through Desktop. Architect then resumed that SAME worker through native controls
(plan version 8); its activity is confirmed. This is driver-assisted recovery,
not autonomous outage recovery. Keep the original session and useful work.

The worktree audit found 141 present additional checkouts and about 82.8 GiB across
the two audited folders. Fifty clean merged checkouts map to 38 cleanup-blocked
plans; all 44 associated sessions were inactive in the foreground observation.
A fresh runtime cleanup retry still reproduced the stale idle hold. Architect
subsequently recorded 16 native non-forced removals, including LZ-195's worker
and review checkout; independent disk/native/cache checks confirmed absence.
Net allocation fell 7.8144 GiB across the same measured roots, while retained
workers could allocate files. This manual intervention is not automatic recovery.
LZ-185's repair and remaining historical holds remain unresolved. Exact records:
`design/reviews/worktree-cleanup-audit-20261109.md`,
`design/reviews/worktree-lifecycle-inventory-20261109.json`, and
`design/reviews/worktree-cleanup-intervention-20261109.json`.

Implementors own features, checks and commits; Architect owns synchronization,
rebasing, conflicts, composition and integration. Native ownership guidance is
landed in main as `b42f512`, separately from retained LZ-182
composition `79ae40e`, which is not integrated. Original LZ-182 commits `fae0967`
and `6dbae67` remain preserved. Its 20-hour-old session is not 20 hours of continuous
inference. Architect corrected stale advice and kept that implementor idle while
handling composition itself. Independent review found continuation-admission and
bounded scheduling-read defects; final correction/review remains open. The latest
native verification could not start because Bun was absent from the shell PATH;
do not call that a failed feature test or send the worker into integration work.

LZ-195's SAME worker delivered limited-review-status correction `9c5e434`, now
source-merged as `59b9578` and runtime-integrated (version 37). Its full live
handoff/recovery walkthrough remains open. LZ-201 correction `e2833b0b` landed in main as
`5f6b759`. LZ-164 and LZ-201 are runtime-integrated with native cleanup confirmed.
Architect exercised actual registered full/history reads through two pages with
normal telemetry; main quality and 23 focused tests/214 assertions passed. See
`design/reviews/retained-inspection-live-20261109.md`. Their earlier fixes
were retained through concrete native review-to-repair cycles. LZ-193/LZ-194
repairs remain pending with original workers preserved. LZ-196 (automatic recovery)
waits on LZ-154/LZ-195/LZ-199; LZ-192 waits on LZ-196/LZ-182/LZ-200. LZ-200
is the queued configurable limit of 3 across all delegated roles, Architect
excluded; the limit is not implemented yet.

Main Radar source landed at `bd2896d`; connected qualification remains incomplete.
The live panel reports some current session/model states, but tool-call activity
was empty during observed work and legacy sessions often show unknown. See
`design/reviews/radar-live-integration-gap-20261109.md`. Provider/model-aware
Architect cache policy remains unproven; a scalar default is not a provider's
cache lifetime. Existing roadmap work remains in scope; cleanup priority does
not cancel it.

LZ-182's plan is now cancelled, not completed. Its original and Architect-owned
checkouts/commits remain present. The driver found LZ-154/LZ-189/LZ-192/LZ-200
still depending on that cancelled plan and raised the gap through Desktop in
`msg_1c0d4b4f30012lDKUBjRgwBYv0` (Unix1794236539424), keeping cleanup first.
Architect rewired LZ-154 and retained the other three genuine source edges.
The explicit same-worker continuation at the top now supplies the retained Tasks
path; implementation and connected qualification remain open. Do not claim
routine cancellation itself handled these dependents.
See the latest section of `design/reviews/native-progress-20261109.md`.

## Delivery and preservation

Architect owns verification, product probes, review, integration, activation,
cleanup and recovery. Human input is for material unresolved decisions or
required authorization. Stuck work must show an actionable reason in Tasks and
offer one-click Architect investigation. Autonomous end-to-end recovery and
that action remain unproven.

LZ-131 original worker `ses_e8e85ff547f941e2b3e960621c3db6dd` and accepted work
remain retained. Composition with accepted LZ-130 has test conflicts. Use native
repair/integration controls; do not mutate SQL or discard failed-attempt history.
Old standalone scheduling diagnostics lack the process-local source-guard
registry and may overreport holds. Native runtime observations determine actual
reservation ownership.

## Preserved UI work and walkthrough locator

Review checkout:
`/Users/tjw/Documents/ChatGPT/opencode-lazers.worktrees/lz182-review-recovered`.
Candidate66927d5 composes Tasks/Radar with the native summary-control fix3ada1c3.
Earlier quality/build,320UI/observation tests and66audit/native-tool tests passed;
this does not establish current live acceptance. Preserve existing review images.

Native Luna Max probe `ses_e4300c5d7ffeNSzVZm3oOZpWzU` completed setup only.
Owned root ends `lazers-full-instance-9TcU4T`, owner
06a0c8a9-1305-4fb3-a083-11e588e6cef5. The owned Desktop was quit to restore
main-window Computer Use targeting. Reobserve service/process state and reopen
through the supported lifecycle; old PIDs are not proof of liveness. OpenAI
consent and ChatGPT usage were authorized for this instance and completed. Do
not repeat sign-in, copy credentials or substitute a free default model.
Its canary session and four synthetic unrun tasks remain retained. No completed
two-implementer live walkthrough has been demonstrated. LZ-197's real Ctrl+T
shortcut support is needed for owned-window effort selection.

The setup probe compacted without completing a real implementer walkthrough;
this is delivery inefficiency, not acceptance. Reuse original fixture images and
`design/reviews/lz182-fae-source-review-20261107.md`,
`design/reviews/lz184-combined-validation-20261108.md`, and
candidate `.cache/review/native182184-results.md`. Earlier source checks and
fixture screenshot reviews do not establish current live acceptance.

## Auditor delivered

Auditor role/native Fallow3.41.0 and durable task-linked SQLite history are on main
(`7126ebf`, `c9ffb96`). Five Code Mode tools query runs/findings, append assessments,
import legacy reports and regenerate exports outside worktrees. See
`design/auditor.md`. LZ-186 was reviewed/merged7afd88b→0d0fa9b; runtime plan is
integrated and its original worker checkout was removed natively. Before/after
runs remain durable. User approved Muse training; exact Go workspace privacy
setting was verified ON after reload. Remaining audits187–191 retain their order.

## Working rules and locators

- Model prompts through Desktop CUA; SDK/DB diagnostics read-only. No production
  SQL repair. Native agents can use their normal SDK/tool/fixture workflows.
- CUA focus-input shortcut is Ctrl+L. AX setValue alone changed the visible draft
  without firing input state; use focus, paste/type, verify Send, then submit.
- `.cache/driver/client.ts` discovers the existing service; bounded state/latest
  tool helpers are there. Discovery timeout is not proof the service stopped.
- Follow README/AGENTS and pinned `.agents/docs/opencode-api.md`. Use native
  worktree/lifecycle APIs. Preserve original workers, useful work and history.
- Evidence is real checks and behavior, not source hashes or arbitrary limits.
  Keep schema validation, Architect self-review and advisory System One.
- Six inference flags remain ON, idle unload Never. Preserve downloaded models.
- Auto-fix formatting/lint through `bun run verify`; relevant behavior tests.
  Project listeners use Portless; native OpenCode follows its supported lifecycle.
- Original brief: `.agents/docs/sources/original-design-brief.md`. User steering
  supersedes it. Task-sizing research: `design/reviews/llm-work-decomposition-research-20261107.md`.
