# LAZERS current handoff

2026-10-31. Start with [completed-task audit and recovery plan](completed-task-audit.md),
[README contracts](../../README.md), and [pinned OpenCode API lookup](opencode-api.md).
Original proposal and research are retained under [sources](sources/original-design-brief.md)
and [implementor profiles](implementor-profiles.md). Historical execution evidence
lives in the numbered spikes/evidence directories and Git history.

## Live operation

OpenCode Desktop Architect `ses_e6e0e6239ffdtzIePMeJ1sHA4l` uses
`openai/gpt-6.1-sol#high`. Main recovery commit is `9b0ab5e`; all nine plans with
accepted results now record integration, including permission reads, Repomix and
Tasks continuation. Source/API maintenance and docs may have later commits: inspect
Git before changing anything.

Five existing product plans are admitted with durable priority and dependencies:

- `8d505ab3`: Go `qwen3.8-flash#medium`, Tasks menu order/tab icon.
- `b50a1a71`: OpenAI `gpt-6-luna#max`, observation API + speech, then Radar/Trajectory
  and GUI assembly. Initial workers run concurrently in separate native worktrees.
- `58146c54`: task references and grouping, after product integration.
- `b9e55d09`: hook-backed durable progress, after product integration.
- `8253ff59`: Architect renewal, after durable progress integration.

Use production tools/commands and current versions. `schedule` changes priority and
unstarted plan baseline/prerequisites; `run` admits; runtime dispatches. Scope
conflicts serialize. Integration records accepted artifact/branch/reason and triggers
native non-forced worktree cleanup. No manual SQL transitions or force acceptance.
The audit contains exact IDs, acceptance gaps and recorded schedule.

## Immediate driver work

Keep native workers cooking. Review their actual diffs/checks, integrate accepted
work with Architect, and verify cleanup. Confirm live parallel completion and new
panels in Desktop; do not substitute CLI fixtures for native acceptance. Terra
6.1 High reviews actual screenshots against `design/system-panel`,
`design/trajectory-panel` and `design/task-panel` references.

Five broad legacy records were retired through native `lazers_dispose_task`: rejected ceremony
`75f62b3b`, and superseded `2d955ffa`, `94298112`, `313174d7`, `9dde2941`.
Superseded does not mean every old acceptance observation passed. Preserve gaps in
the audit. Canceled inference-isolation task `c0ef9f9d` stays canceled.

Missing native observations: permitted worker trajectory reads, production Repomix
refresh/index/read reuse, optional guidance, complete parallel return/merge/cleanup,
and relevant theme/font coverage. Cheap heartbeat and compact inspection (`3623d50`) were activated with supported
location reload; existing attempts/sessions remained, and active tools saw the reload
boundary. A later renderer freeze is documented in [trace evidence](evidence/034-renderer-trace/report.md). Cross-worktree context delivery is
specified and admitted by Architect as plan `caa8c80c`, task `430e08d8`;
current workers have separate empty cache roots. Native diagnostics are active:
a Desktop decision check recorded 33 input tokens, ORT run/readback and completion
in the main-process log. The earlier freeze cause remains unresolved.

Architect renewal must use provider/model/options-sensitive cache policy with user
override and fallback; do not treat a universal timeout as a provider guarantee.
Preserve handoff, pending input, model and ownership before native archival.

## Operating rules

- Model prompts and visual acceptance through Desktop computer use. Read-only SDK
  inspection and supported maintenance are allowed; user authorized out-of-band
  recovery, review and merge for this dogfood.
- Architect has normal tools, Code Mode, research, edit and Git. Implementors have
  normal coding tools/LSP, broad reads, scoped writes and no self-subagents.
- Exact native model/provider/variant choices pass through; no catalog veto or
  fallback. Usage is measured; do not invent budgets.
- Source findings and research travel in concise task guidance. Repomix snapshots
  are reused as-of-refresh. No source hashing/freshness receipts as evidence.
- Keep schema validation and `lazers_verify_task` Architect self-review. Passing
  checks and observed behavior establish completion.
- Inference remains enabled. Persistent content-free inference diagnostics are authorized; no engine changes
  or inferred freeze fix. Last code-5 crash export is in Downloads.
- Use pinned OpenCode 2.2.5 V2 APIs and native worktree lifecycle. Bun binary:
  `/Users/tjw/.bun/bin/bun`; native `fmt`, `lint`, `check`, `test`.
- Load Portless skill before launching a project listening server. None is needed
  for native Desktop maintenance or one-shot checks.

Current verified tree: 229 tests / 2,303 assertions, formatting, lint and strict
TypeScript pass. Consult the audit for the boundary between tests and native proof.
