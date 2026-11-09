# Current dogfood handoff

Updated 2026-11-09. Goal remains active: native Architect/LAZERS must deliver the
whole roadmap, then propose improvements from observation. Runtime/API/DB state
is authoritative; this file is a locator. Earlier detail remains in Git history.

## Standing driver role

Follow AGENTS.md → Dogfood driver role. Codex is the human developer in this
loop; Architect owns recovery and raises material unresolved decisions through
native questions. Observe outcomes rather than supplying unsolicited steering.

## Current native observations (2026-11-09)

Runtime/API/DB state is authoritative. Architect is
`ses_e568438ebffeaoFbF9nBb942XM`, OpenAI Sol6.1High; it was idle at the last
observation while scheduler verification was actually running.

Original LZ-181 and the unstarted replacement LZ-198 are cancelled, with useful
work/history preserved. Do not resume the original failed worker. The user's
one-time takeover is LZ-199, plan `5412cca2-3cd5-4d51-abfb-f64e1e59d685`,
worker `ses_325a8b20d34449fe9ac4100bcb0a35a2`, attempt
`42f98841-b29b-43d1-9fb9-a1374bcfb31f`. Its actual route is OpenAI Sol6.1
**default**, not High. Commit `159f4c9` passed quality and 679 runner tests;
runtime task-level verification also passed and node is accepted. The declared
plan-level behavior check also passed (exit0, no timeout). Runtime plan became
accepted and Architect automatically resumed at Unix1794203003814 to review the
exact candidate. Review completion, integration, activation and cleanup remain
unproven. Preserve all original drafts and retained work.

LZ-200, plan `a543e146-60f0-49a8-bdd7-c3df7265cda7`, is queued after LZ-199 and
preserved LZ-182. It implements the user's configurable project limit of three
across ALL delegated agents, excluding Architect, with durable overflow queuing,
priority/dependency refill and truthful waiting reasons. No such limit is active
yet. Native worktrees already support parallel coding.

Independent LZ-164 is accepted after same-worker correction `22b5abc` (75 focused
tests); native review/integration remain pending. LZ-197's shortcut candidate
`36a661b` has a clear native source review but remains unintegrated. LZ-195's
corrected handoff candidate `1e68969` still has an Architect-role defect in its
verify wrapper: worker-only draft saving blocks review of an existing draft.
Normal retained repair is waiting on LZ-199. LZ-196 (automatic recovery consumer)
waits on LZ-195/LZ-199; LZ-192 (visible recovery) waits on LZ-196/LZ-182.
Preserve original workers for LZ-182, LZ-193 and LZ-194 repair after the runtime
fix; do not replace retained work with fresh implementations.

Current RCA and measured progression:
`design/reviews/lz181-runaway-trajectory-20261109.md`,
`design/reviews/recovery-controls-review-20261109.md`, and
`design/reviews/native-progress-20261109.md`. Advice attachment alone does not
prove worker consumption. A driver-dismissed routine worker question aborted its
turn; Architect subsequently amended scope and resumed the SAME worker. Future
autonomous question routing is still unproven and belongs in LZ-196/LZ-192.

Main Radar source landed at `bd2896d`; connected live qualification is incomplete.
See `design/reviews/radar-live-integration-gap-20261109.md`. During LZ-199 checks,
Tasks displayed Running/Worker Active while runtime was verifying and worker was
idle. Track that mismatch with existing task-status work, not a second system.

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
