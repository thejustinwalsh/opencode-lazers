# LAZERS current handoff

2026-11-01, 14:45 UTC checkpoint. Runtime records are authoritative; recheck before
acting. Read [README contracts](../../README.md), [pinned OpenCode API](opencode-api.md),
[reviewed phase plan](phase-review-plan.md) and the Architect's
[roadmap execution map](roadmap-execution.md). Historical delivery evidence is in
[the completed-task audit](completed-task-audit.md); this file describes current work.

## Active goal and native Architect

Keep driving OpenCode Desktop while it dogfoods all four reviewed phases. Observe,
repair real blockers, review and integrate artifacts, verify working behavior,
then prepare an evidence-based improvements plan for user review. Do not stop at
planning or a single returned worker.

Current Architect: `ses_e68a9ed37ffeVqzPWRXN5SB7Uw`, “Build LAZERS roadmap”,
`openai/gpt-6.1-sol#high`. Initial uncoached user prompt:

> Here is the agreed plan: design/roadmap.md. Let's build it.

No decomposition coaching was added. Later Desktop messages corrected observed
review/execution issues and coordinated activation. Root represents the user in interviews;
reusable behavior belongs in the concise agent definition/skills. Architect
recognizes scope, researches/interviews, submits small tasks/dependency graphs
and requests execution. Scheduler dispatches/tracks workers and returns outcomes
for Architect review, repair, integration and replanning. Native worker routes
are `openai/gpt-6-luna#max` in isolated native worktrees. No replacement workers
should be created merely because a run is taking time.

## Current execution

| Ref   | State at checkpoint                             | Next boundary                                                   |
| ----- | ----------------------------------------------- | --------------------------------------------------------------- |
| LZ-28 | Held/cancelled, incomplete                      | Reassess durable late-input reconciliation; no no-op acceptance |
| LZ-31 | Integrated v9                                   | Corrected source and non-forced cleanup complete                |
| LZ-32 | Verifying corrected 74ffb3a in original attempt | Review/activate, actual Desktop history/filter/navigation proof |
| LZ-33 | Queued                                          | Operational Radar projection after history integration          |
| LZ-34 | Queued after LZ-33                              | SVG/ELK native implementation and design review                 |
| LZ-35 | Integrated v9                                   | Privacy correction and non-forced cleanup complete              |

All six plans belong to the current Architect. Radar no longer waits on the
unfinished lifecycle plan; its remaining prerequisites are integrated privacy
plans and history/navigation. Later Phase 1–4 work remains in the execution map.
Architect idle while a confirmed live worker/verifier runs is expected.

- LZ-28 plan `8253ff59-57a5-45fd-8847-acd971438af8` retained the original attempt
  `33e6b86d-edda-41dc-9ac4-93d195f537ea` and its candidate `8c8f86c`. A stale
  verifier-receipt bug caused unnecessary automatic attempt 2,
  `941526b0-62de-4578-b82e-f2a458c95358`; neither candidate was integrated.
  Native source research found a plugin archive adapter defect (HTTP client
  supports archival) and absent atomic admission sealing. Root challenged whether
  an atomic fence is stronger than the requested durable input accounting;
  Architect reopened investigation of late-arrival reconciliation. Do not claim
  renewal is delivered or waive actual input/archival acceptance. Preserve both
  idle, unmerged worktrees/history. See the current execution map and
  `evidence/architect-context-lifecycle/upstream-gap.md` for the evolving finding.
- Corrected privacy descendant `15eff84` passed independent native review and
  canary/positive-content checks, was merged in `c9db3b5`, and both privacy plans
  reached integrated with owned worktrees removed natively. Real read-only RPC
  subsequently returned LZ-31's original task/attempt/native context after cleanup.
  Full native history-navigation interaction remains separate.
- LZ-32 plan `c4be742b-4d11-485f-a657-48bbbd0cd554`, attempt
  `a059f222-eb59-4e7b-b083-b5a38da86b2a`, session
  `ses_cd6622d07eb74169bd1b753cff71511d`. Initial `b49116e` was held after native
  review found legacy omitted/false queries hid failed/exhausted tasks. Original
  worker repaired this in `74ffb3a`; current runtime created fresh artifact-specific
  checks without replacing the attempt. Observe separate scope/state controls,
  completed selection, exact old reference/all attempts in both mounted and newly
  opened Trajectory, and restored Tasks preferences at narrow native width.
  Tera review guidance: `/private/tmp/lazers-phase1-native-review-ready.md`.
- Radar plan `b0eb89b4-a071-49e2-a238-c474d53cc42f` owns LZ-33 → LZ-34.

## Recent evidence and remaining risks

[Natural roadmap observation](evidence/037-roadmap-planning/native.md) records
research, task creation and actual scheduler handoff. Current guidance recognizes
task/plan/roadmap shape without tasking epics. Task self-review coverage now tests
its own objective, preserving parent intent and plan acceptance (9d043bf).
377 tests / 3,454 assertions and Bun formatter/linter/strict types passed for that
change. Runtime fix `2536084` prevents resumed attempts from reusing another
commit's completed verification receipt. Its regression fails on the old runtime;
115 runner/recovery tests and quality checks pass. Supported native reload
activated it and the native delegation guidance; fresh LZ-32 checks for 74ffb3a
are observed. See [the finding](evidence/038-resumed-verification/native.md).

The task reviews observed so far repeatedly use three rounds and finish with
concerns; collect actual quality/cost evidence before changing calibration. The global
`horde` skill prescribed an external Codex CLI review; that command failed before
reviewing anything. Two concise packaged-definition sentences now keep research/
review in native OpenCode and implementation in LAZERS. Desktop steering was
honored; subsequent actual reviews were native. The global skill was untouched.

Existing failed LZ-14 responsiveness remains unresumed. Preserve the explicitly
cancelled isolation refactor/stash and enabled inference. Establish the actual
blocking boundary before focused repair. Live Trajectory stability/read cost,
whole-feature measurement, Models/persona routing, revisions/research and release
readiness remain in the reviewed roadmap. Tests/builds are not fresh-machine
installation or actual Desktop interaction proof.

## Operating rules

Desktop computer use for model prompts and visual acceptance; read-only SDK and
supported native maintenance are authorized. `location.reload()` can interrupt
generation: avoid casually reloading while agents work. Older sessions can retain
`succeeded` outcome while busy; use current busy/idle timestamps and tool state.

Use pinned OpenCode 2.2.5 V2 APIs and native session/worktree lifecycle. One plugin,
no custom daemon. Normal tools and Code Mode remain available; implementors do not
launch subagents. No catalog veto, silent fallback, invented spend limits or
source-fingerprint evidence gates. Preserve schema checks and `lazers_verify_task`
Architect self-review. Evidence is code, passing discriminating checks and working
native behavior. Keep local inference enabled.

Use `/Users/tjw/.bun/bin/bun`. Load Portless before project listening servers;
one-shot socket-free checks are exempt. `.agents` and Git writes require the
supported sandbox escalation. Never print service credentials. Model prompts stay
in Desktop; SDK inspection is read-only unless supported maintenance is necessary.
