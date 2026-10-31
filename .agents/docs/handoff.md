# LAZERS current handoff

2026-10-31, 23:40 UTC checkpoint. Read [README contracts](../../README.md),
[pinned OpenCode API](opencode-api.md), and [current audit](completed-task-audit.md).
The [durable snapshot](evidence/033-completed-task-audit/live-state-latest.json)
is timestamped; inspect current state before acting. Original intent and research
remain in [the brief](sources/original-design-brief.md), [Repomix strategy](repomix-strategy.md)
and [implementor profiles](implementor-profiles.md).

## Native operation

Architect `ses_e6e0e6239ffdtzIePMeJ1sHA4l` uses `openai/gpt-6.1-sol#high`.
Implementors use `openai/gpt-6-luna#max`. The durable snapshot records counts and phases at its own timestamp. Grouping
has returned and is being reviewed, progress is running, and lifecycle is queued.
References are source-landed within the active grouping plan. Failed/cancelled history
and five retired broad task records remain preserved.

LAZERS is one plugin: scheduler/storage in OpenCode's service, native agent
sessions/worktrees, panels and local inference in Desktop. No LAZERS daemon or
standalone inference service. Driver SDK inspections and maintenance are one-shot
and not runtime dependencies.

## Delivered and observed

- Product plan `b50a1a71` is integrated. Observation projection, speech, Radar,
  Trajectory and GUI assembly are on main. All five owned worktrees were removed
  through native non-forced cleanup. [Desktop evidence](evidence/027-observation-panels/native-root-review.md)
  includes real timelines, state selection, split persistence, narrow layout and
  light-theme adaptation; System/Ayu and the wider panel were restored.
- Wake plan `1d4a866e` is integrated. Real b50 integration cancelled the exact
  owned queued accepted notice, retained history/unrelated inputs and queued the
  current non-resuming update. [Native proof](evidence/035-outcome-inbox/root-native-review.md).
  Scope amendments, same-candidate recovery and source-landing records remain.
- Context plan `caa8c80c` is integrated. A native isolated worker reused the
  published Architect snapshot without recollection. [Evidence](evidence/isolated-context-reuse/native.md).
- Go/Qwen Tasks affordances `8d505ab3` are integrated and natively reviewed.
  Manual Start, exact model routes, three optional personas, task references,
  readable instructions and permission-based trajectory inspection are implemented.

## Continue the existing work

- `58146c54`: reference task is accepted/source-landed; grouping artifact
  `dcba900` is accepted and under source/native review in attempt `f0eee1ec-7ec3-489d-aadf-77443df8d7a8`,
  session `ses_11bec70c82f04bfdb265ce5b5eab40f7`. Review, preserve Root fixes,
  mount in Desktop and ask Terra 6.1 High to review actual screenshots against
  `design/task-panel`. Complete native copied-Markdown-link click/routing; copy,
  paste and rendered response are observed, clicking remains unverified.
- `b9e55d09`: durable progress/hooks attempt `d543a0f7-670a-46eb-8a91-0ca590a0f848`,
  session `ses_043f3b7202dd41b8bd9bbb7c0b69c805`, is running after recovery of its
  original native worktree reservation. No extra model attempt was spent.
- `8253ff59`: lifecycle renewal follows progress integration. Use provider/model/
  options-sensitive cache policy, override/fallback, durable handoff and pending
  input preservation before native archival. It need not reuse the same Architect.

`b4fcd61` fixes the observed startup-recovery cancellation race. Conclusive recovery
of an attempt's own worktree uncertainty resumes preparation; unrelated blocked
reasons still stop it. Empty host errors are no longer blank. Runtime/artifact/
process-recovery checks passed 84 tests / 1,490 assertions; the final helper reuse
also passed focused positive/negative regressions and quality checks. Supported
all-location activation preserved PID 16786 and both active workers. Proof:
`evidence/035-outcome-inbox/startup-recovery-activation.json`.

`5d9be1f` retains fully recovered superseded wake/reference commit ancestry without
reapplying old code. Old driver review changes were preserved in Git and their two
worktrees removed through the SDK, without force. No dirty/unmerged work was lost.

## Driver rules and actual limits

Use Desktop computer use for model prompts and visual acceptance. Read-only SDK
inspection and supported native maintenance are authorized. Keep Architect and
workers moving while reviewing returned artifacts; do not create replacement
work or stopgap handoffs for already specified increments.

Use production tools/current versions, pinned OpenCode 2.2.5 V2 APIs and native
worktree lifecycle. Normal tools/Code Mode remain available; workers do not launch
subagents. No model catalog veto, fallback substitution, invented spend limits,
source hashes/fingerprint ceremony or model approval gate. Keep schema validation
and `lazers_verify_task` as Architect self-review.

Latest full merged checkpoint `0c5de84`: 339 tests / 3,214 assertions, formatter,
lint and strict types passed. Later runtime changes have focused validation above.
Use `/Users/tjw/.bun/bin/bun`; load Portless before any project listening server.

Inference remains enabled. Bounded tracing and next-freeze Electron CPU capture
are armed; the earlier renderer freeze cause remains unresolved. Do not infer a
fix or change the engine from the Radar startup error that was separately fixed.
Current speech regressions pass; OpenCode exposes no fixed-right ComposerPill
slot or modifier-click event, so the supported pill/menu/shortcut is used.
