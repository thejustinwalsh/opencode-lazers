# Shared-target delivery review

Reviewed candidate: `113cdb6962f5b3ffe2b3521abfa8ac576a32e605`.
These are source-review findings and required regression procedures, not
executed probe results. Runtime verification is separate.

## Preserve

The delivery extends `recordIntegration`, binds preflight to an exact target
commit, retains actual target comparison blobs, keeps legacy receipts readable,
and checks native cleanup against the recorded target rather than unrelated main.
Keep those changes and existing containment/cleanup safeguards.

## Corrections before integration

| Finding | Source evidence | Required behavior and discriminating regression |
| --- | --- | --- |
| Dependent task dispatch still selects canonical main. | `Dispatch.taskDependencyIntegration`, `src/runner/dispatch.ts:148-166`, obtains the canonical checked-out branch. `evaluateTaskPrerequisiteIntegration`, `src/runner/prerequisite-proof.ts:196-205`, rejects a receipt for another branch. Neither consumer changes in this delivery. | Bind two dependent tasks to a feature target, land and record the first while main stays unchanged, then drive the scheduler. The second must start from a freshly proved target baseline, including landed conflict resolutions. Preserve legacy branch checks and reject foreign or mismatched target membership. |
| Original source-attempt objects are not retained when only the target view is materialized. | `managedIntegrationRecord`, `src/runner/integration/target.ts:134-155`, prepares only the target-before/after comparison. `prepareIntegrationComparison`, `src/code-review/integrations/comparison.ts:29-51`, retains changed blobs from those two trees. `combineArtifacts`, `src/runner/artifacts.ts:275-280`, fast-forwards a single artifact without creating a memoized combined ref. | Use a single-task squash or conflict-resolved landing whose source text differs from the target text. Without opening source Review first, remove the worker and source branch, expire reflogs and prune Git. Both the original task/attempt view and actual landed view must resolve and read their distinct source. Reuse existing Git retention where sufficient and extend owned retention for missing source/base objects; do not add a second workspace registry. |
| A rewritten target cannot be refreshed through the current public authority. | `landedRange`, `src/runner/integration/target.ts:81-94`, asks callers to refresh a diverged recorded head. `assertTargetCanExtend`, `src/code-review/integrations/target-store.ts:86-98`, requires the submitted head to equal the old stored head, while `recordIntegrationTarget`, `src/runner/integration/record.ts:343-344`, requires it to equal the current Git head. | Provide an explicit, guarded reconciliation through the existing target authority. After a reviewed force-push/rebase, preserve target/PR identity and old receipts, acknowledge the old and new observations without inventing a proven intervening landing, then permit the next real task landing. Stale or unacknowledged changes must still fail. |
| Shared batches are implicitly restricted to one plan. | `managedTargetPreparation`, `src/runner/integration/target.ts:67-77`, accepts project-wide target task membership but obtains nodes/attempts only from the command's plan. Each record also uses that plan in `recordManagedIntegrationEvent`, `src/runner/integration/record.ts:98,122`. | A selected project task group may span plans. Exercise a shared landing for accepted tasks from two plans and retain each task's real plan/attempt and one shared range. Require explicit disambiguation if accepted-source identity is ambiguous; do not record the second task as a new empty landing or copy the first plan's identity. |
| Later PR association is absent from earlier task reads. | `updateTargetPullRequest`, `src/code-review/integrations/target-store.ts:112-148`, updates the shared target, but `CodeReviewIntegrationStore`, `src/code-review/integrations/store.ts:74-85,128,171`, reads the embedded historical target JSON unchanged. | Record a task before PR publication, associate the PR later, and read that task's integrations. Navigation must expose the current shared association without changing its historical source/range/batch evidence. Also exercise later group extension and successive landings. |

## Verification emphasis

Current tests demonstrate a direct feature landing, same-plan merge batch and
retained target-source reads. They do not establish all cases above.
Add the regressions through the existing command, scheduler and Review RPC
entry points rather than testing a replacement authority in isolation.

Keep source and landed identities separate under squash, replay and conflict
resolution. Do not weaken containment, dirty-worktree or native quiescence checks
to make a target case pass. Do not create PRs or merge a feature PR into main
during regression tests.

The analysis test's expected schema generation changing from 2 to 3 is a
justified scope divergence; it is not one of the behavior defects above.
