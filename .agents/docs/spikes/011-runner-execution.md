# Spike 011 — first real worker change integrated

## Result

The Desktop Architect dispatched the existing retry-safe submission task to a
native implementor child. The worker committed `38be10db9c398e978c68638fc8b7105070cd56cb`.
Runtime task and graph checks passed and the plan reached `accepted`. The driver
reviewed the change, resolved two additive test conflicts and merged it into main
as `3b4c1051b7c0d1f742ca810269061bba2d639cf9`. The user delegated review and merge
for this dogfood run. This is real product work, not a simulated model response.

- Task: `5f5743c3-1bd0-4a53-a86b-a347dd961e1a`, revision 1.
- Plan: `6d1d3afe-f236-4a33-a5a2-86328e838249`; integrated version 22.
- Attempt: `3ceef8dc-c679-4eb7-b1fe-04cc0951f672`.
- Native child: `ses_b6d619d62ec44b25bd27acd8ca5f64c6`.
- Actual model: OpenAI GPT-6.1 Sol, High, through the subscription.
- [Worker implementation and checks](007-retry-safe-submission.md).
- [Visible trajectory and verifier receipts](../evidence/011-runner-execution/worker-visible.json).

Desktop Architect recorded the reviewed merge through `lazers_plan_command`.
The native `worktree-remove` effect completed with `removed: true, native: true`.
Git inventory lists only main and the owned ~541 MiB directory is gone. Four
original tasks remain open; this result does not close their acceptance.

## Corrections established by dogfooding

Native child creation inherits the parent location even when given a location.
Isolated dispatch now moves the child, awaits the queued native operation and
checks its actual directory before prompting. The original misrouted edits were
preserved and the child completed in its assigned worktree.

Workers receive short prose directing them to `lazers_get_task`. That tool renders
readable task instructions for implementors and retains typed structured output.
Repeated raw JSON context injection was removed. Serial work defaults to shared
native children; explicit isolation remains available. Parallel execution is a
later acceptance boundary, not established by this serial run.

Guessed execution quotas and repository-hash evidence gates were removed.
Schema validation, Architect self-review through `lazers_verify_task`, System One
checks, actual verification and usage history remain. Resume and fresh retry are
runtime commands; neither erases earlier attempts or usage.

Accepted work is reviewed and merged before cleanup. Runtime records the reviewed
target and checks accepted-artifact ancestry. Cleanup reconciles native inventory
and removes only recorded owned worktrees through OpenCode with `force: false`.
Each worktree's HEAD must also be merged: a clean abandoned attempt can contain
valuable unmerged commits. Active, dirty, unmerged or unregistered work is retained
with a visible, retryable `cleanup-blocked` result. Interrupted cleanup resumes;
already-removed directories reconcile without deleting unrelated work. See
[workspace policy](../workspace-policy.md).

## Verification

The worker's final boundary passed 105 tests / 720 assertions. After integration,
the combined main passed 116 tests / 839 assertions, formatting, lint, typecheck
and the GUI build. A subsequent cleanup regression added protection for clean
unmerged commits: **117 tests / 851 assertions pass**, with formatting, lint and
typecheck passing. The targeted real-Git tests cover successful removal after
merge, refusal before merge, dirty-file preservation, explicit cleanup retry and
unmerged-commit preservation. Native Desktop cleanup subsequently completed as
recorded above. Task-guidance baseline `28c4e67` passes 120 tests / 883 assertions,
formatting, lint, typecheck and GUI build.

## Usage and equivalent cost

The retained native worker session reports 227,387 uncached input tokens,
3,494,784 cache-read tokens, 16,615 visible output tokens and 6,671 reasoning
tokens, with zero cache-write tokens. The pinned host accounts visible output and
reasoning separately; both are priced as output. Across 37 token-bearing assistant
messages the largest input was 132,092 tokens, below the catalog's long-context
tier.

Using the [OpenRouter catalog](https://openrouter.ai/api/v1/models) observed on
2026-10-31 for `openai/gpt-6.1-sol` (`openai/gpt-6.1-sol-20260929`), rates per million
tokens were $2 uncached input, $0.10 cache reads and $10 output. The **worker-only
equivalent estimate is $1.0371124**. This is subscription usage priced by public
metadata, not a charge. It excludes Architect/driver usage, machine verification
cost and unavailable provider/tool charges. [Per-message calculation and dated
rates](../evidence/011-runner-execution/equivalent-cost.json) retain the method and
[pinned native accounting source](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/usage.ts).

The session contains earlier failed routing, quota and context delivery attempts.
It is not a clean efficiency benchmark. Large cached context reflects that history;
no Repomix or prompt savings claim follows from this one successful task. A fresh
next task should measure the corrected prose/fetch path.

## Original brief: available and missing

| Contract            | Demonstrated                                                                        | Still required                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Completion          | One original task accepted, reviewed and merged                                     | Four original tasks remain open; native cleanup pending                                             |
| Autonomy            | Native child dispatch, checks and outcome delivery; owner resume/retry              | Full native dependent-task run, general replan/revision decisions, interruption recovery acceptance |
| Efficiency          | Actual usage/cache fields and visible trajectory retained                           | Repeated accepted-work comparisons; evidence-driven corrections; affordable model selection         |
| Quality             | Structural task validation, self-review retained, real checks and scope enforcement | Broader native Code Mode/LSP/skill delivery and permission acceptance                               |
| Context             | Repomix map/focused reads and worker task-fetch path implemented                    | Unseen native research acceptance and named specialist dispatch/web research                        |
| Workspace lifecycle | Native APIs, shared serial default, owned cleanup behavior tests                    | Actual native cleanup, parallel work and integration acceptance                                     |

The remaining original records are Tasks panel `2d955ffa-8b58-48c7-b34b-494b2af0d7fc`,
runner `94298112-1c6c-44ba-87f6-a06533eafa59`, Repomix research
`313174d7-8358-4911-b006-1a1f25ca779c` and implementor/context
`9dde2941-541a-43cd-b426-283854bcf403`. Existing implementation is not proof of all
their acceptance clauses. Reconcile them through Architect before defining more
work. Rejected hash-receipt supplement `75f62b3b-4cd2-4a3a-b17b-30d22c37aaad`
must not execute; it needs a legitimate disposition, not fabricated acceptance.

Retain the increment. Native integration/cleanup is complete. Continue the fresh
Luna Max trial and reconcile remaining records against their actual acceptance
and the user's corrected scope.
