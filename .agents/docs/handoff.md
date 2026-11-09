# Current dogfood handoff

Updated 2026-11-09. Goal remains active: native Architect/LAZERS must deliver the
whole roadmap, then propose improvements from observation. Runtime/API/DB state
is authoritative; this file is a locator. Earlier detail remains in Git history.

## Standing driver role

Follow AGENTS.md → Dogfood driver role. Codex is the human developer in this
loop; Architect owns recovery and raises material unresolved decisions through
native questions. Observe outcomes rather than supplying unsolicited steering.

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
subsequently removed 11 settled verification/review worktrees through native
non-forced APIs. Independent disk/native/cache checks confirmed all 11 absent;
folder allocation fell 5.6 GiB. LZ-185's automatic repair and the 50 worker-checkout
holds remain unresolved. Exact observations and subsequent updates:
`design/reviews/worktree-cleanup-audit-20261109.md`,
`design/reviews/worktree-lifecycle-inventory-20261109.json`, and
`design/reviews/worktree-cleanup-intervention-20261109.json`.

Implementors own features, checks and commits; Architect owns synchronization,
rebasing, conflicts, composition and integration. Native ownership guidance is
committed as `98d7c05` in Architect's LZ-182 composition checkout, alongside
composition `79ae40e`; neither is integrated. Original LZ-182 commits `fae0967`
and `6dbae67` remain preserved. Its 20-hour-old session is not 20 hours of continuous
inference. Architect corrected stale advice and kept that implementor idle while
handling composition itself. Independent review found continuation-admission and
bounded scheduling-read defects; final correction/review remains open. The latest
native verification could not start because Bun was absent from the shell PATH;
do not call that a failed feature test or send the worker into integration work.

LZ-195's SAME worker delivered handoff finalization correction `157bd523`; LZ-201's
SAME worker delivered paging correction `e2833b0b`. Both plans are accepted;
review/integration and real connected probes remain open. Their earlier fixes
were retained through concrete native review-to-repair cycles. LZ-193/LZ-194
repairs remain pending with original workers preserved. LZ-196 (automatic recovery)
waits on LZ-195/LZ-199; LZ-192 (visible recovery) waits on LZ-196/LZ-182. LZ-200
is the queued configurable limit of 3 across all delegated roles, Architect
excluded; the limit is not implemented yet.

Main Radar source landed at `bd2896d`; connected qualification remains incomplete.
The live panel reports some current session/model states, but tool-call activity
was empty during observed work and legacy sessions often show unknown. See
`design/reviews/radar-live-integration-gap-20261109.md`. Provider/model-aware
Architect cache policy remains unproven; a scalar default is not a provider's
cache lifetime. Existing roadmap work remains in scope; cleanup priority does
not cancel it.

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
