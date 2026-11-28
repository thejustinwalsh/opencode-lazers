# Feature-PR plan execution homes

Authorized clarification, 2026-11-28. This extends the existing integration-target
feature; it does not replace its target store, proofs, state machines or scheduler.
Tracked feature: **LZ-296**, native OpenAI Luna Max, after the native Settings
producer plan. Runtime task/plan records remain authoritative for execution state.

## Durable feature-PR plan home

The user starts an existing feature worktree from main, opens OpenCode there,
creates a plan/tasks and associates an existing external GitHub PR. That
worktree and feature branch are the plan's execution and integration home.
Parallel workers use native child worktrees; Architect lands their work into
the same user-owned base worktree/PR branch.

Completing the plan proves integration into that feature target. It does not
require main to contain the changes, switch main's branch, merge the external
PR or delete the user-owned base worktree.

```text
Repository identity / settings / normal scheduler capacity
  ├─ Plan A → existing user base A / feature-A / existing PR A
  │            ├─ native worker child A1
  │            └─ native worker child A2
  └─ Plan B → existing user base B / feature-B / existing PR B
               └─ native worker child B1
```

Persist a per-plan binding, captured from the validated caller's actual
workspace when the plan is created, and reuse the existing integration target
for its branch/base/PR association. Task provenance alone is not routing.
The exact schema/helper names are implementation details, not existing APIs.

Keep repository/canonical-project identity, settings and resource ownership
separate from a plan's execution directory. Do not globally redefine
`TaskRuntime.directory` or create a project/settings partition per PR worktree.

### Required public behavior

- Normal plan submission, stored-plan tasking and manual Start must bind new
  work to the correct execution home. Default source commits come from that
  home, not unrelated canonical main. Preserve explicit historical baseline
  selection semantics where supported.
- Shared attempts execute in their own plan home. Isolated roots and dependent
  attempts use the plan's bound source and freshly proved integration target,
  retaining conflict resolutions and exact source/landed identities.
- Public controls can associate the plan with an existing external PR through
  the existing target authority. Different plans may bind different base
  worktrees/branches/PRs in the same repository without changing shared settings
  or bypassing normal capacity and scope scheduling.
- Integration, combined/retained verification, continuation and fresh Architect
  recovery resolve the saved plan home/target. A caller running elsewhere must
  not silently redirect the plan to that caller's checkout or canonical main.
- Inspection and recorded observations expose the home/target distinction.
  Missing, foreign, moved or branch-mismatched homes produce actionable existing
  recovery behavior, never silent fallback or recreation of a user worktree.
- Cleanup distinguishes the user-owned plan home from owned worker/check
  resources. Keep the base directory, branch, PR association and local files.
  Remove only eligible native child/check resources through existing non-forced
  ownership, containment and quiescence checks.
- Trunk plans and existing recorded attempts remain compatible. Do not relocate
  running work, rewrite old proofs or infer a new home for old plans from an
  arbitrary recent session.

Native worker/check worktrees still use the canonical repository's existing
native worktree parent and returned authoritative paths. A logical child of a
plan home does not justify moving that parent or making the user base disposable.

### Native PR association and progressing plan comparisons

Research the actual host and connected integration for an existing native
session/branch-to-PR association before selecting a fallback. Preserve native PR
metadata and reuse its supported lookup/link if present. Persist only the
linkage needed from task → selected plan/base session → plan home → existing
integration target. Do not copy independent editable PR fields into every task
or session or introduce a competing PR authority.

Pinned SDK 2.3 has VCS get/base/status/branch-list/diff, including branch diff
with an explicit base. Inspected session declarations have extensible metadata
but do not establish a dedicated session-to-PR API. The driver's inspected
2.4.1 session/VCS/git/header sources and a ComposerPill `openPulls` example do
not establish an implemented PR service either. These are evidence limits, not
proof that no host integration exists. Read-only actual-host/connected-integration
research must supply that distinction.

Extend the existing comparison and integration-target flows:

- A task can resolve its associated PR/branch through its selected plan and base
  session/home. Use one association resolver for Changes and review tools.
- Task scope stays about the selected task. Full plan/PR scope includes the
  complete feature branch range, including other plan tasks and actual Architect
  conflict resolutions, while the plan is still progressing.
- A bound plan/PR comparison must not require `plan.artifact` or substitute
  `body.baseCommit → plan.artifact` for the actual selected branch range.
  Retain a synthetic combined-worker preview only as a distinct source where
  appropriate, never as a claim about the PR branch.
- Use evidenced native/selected PR base and observed feature-branch head.
  Do not guess main. Distinguish local branch observations from remote published
  PR observations when both are present; worker-only unmerged commits/files
  must not appear as already on the PR branch.
- Pin resolved base/head/source identity and preserve old comparison links,
  source content and conservative task attribution. Resolving a newer branch
  observation must not rewrite an earlier pinned comparison.
- Reconcile changed native PR identity/base/head through the existing guarded
  target controls, preserving native metadata and historical evidence.

The queued final Changes consumer (LZ-290) consumes this producer: compact
branch/PR identity with a working PR link, explicit task versus full plan/PR
scope, and separate worker-only sources. It retains its existing stored reopen,
discussion, symbol and navigation obligations. It must wait for this producer's
integrated contract; do not add another active UI writer or expand LZ-291 into
this new functional work.

### Current source findings

Relocated in the checkout before tasking:

| Source | Missing boundary |
| --- | --- |
| `src/runner/schema.ts:71-118` | Plan has base commit/mode, no durable base-worktree binding. |
| `src/runner/runtime.ts:754-755` | Runtime directory is repository identity's project directory. |
| `src/runner/dispatch.ts:99-108,350-377` | Shared independent dispatch uses canonical HEAD/directory; isolated roots use input base commit. |
| `src/runner/integration/task-prerequisites.ts:19-77` | Managed dependencies already prove the selected target; reuse this authority. |
| `src/runner/architect-ownership.ts:89-120,168-179` | Fresh continuation defaults to and validates canonical directory. |
| `src/planning/tasking.ts:117-150`; `src/runner/tools.ts:12-40` | Stored-plan and direct submission entrypoints must carry the actual creator workspace. |
| `src/tools.ts:96-109` | Task workspace provenance is recorded, but does not bind plan routing. |
| `src/runner/native.ts:736-745`; `src/runner/workspace-location.ts:4-11` | Existing native child-worktree creation/root policy should remain. |
| `src/runner/integration/record.ts`; `src/runner/worktree-cleanup.ts` | Existing target/lineage/proof/cleanup consumers need the per-plan binding, not a parallel authority. |
| `src/code-review/comparisons/selection.ts:194-213,361-383` | `planComparison()` requires `plan.artifact` and returns `body.baseCommit → plan.artifact`, not a progressing actual PR branch range. |
| `src/code-review/integrations/contract.ts:5-28`; `src/code-review/integrations/rpc.ts` | Existing target/PR association and pinned landed-comparison contracts are reuse points, not separate task/session PR stores. |

Operator-reported baseline: `bun test --timeout 120000
src/runner/integration/target.test.ts` passed six tests/116 assertions. Those
branch-ref tests are not evidence for two actual PR base worktrees with restart.
No new execution or probe result is claimed by this plan.

### Verification

Use owned fixtures with two actual native/Git base worktrees on distinct feature
branches, different marker content and existing-PR metadata. Treat them as
user-owned bases, not attempt cleanup resources. Exercise public submission and
scheduling with shared and isolated attempts, successive dependency landings,
combined checks and fresh runtime/Architect recovery after closing/reopening
durable state.

The regressions must fail if A uses canonical main or B's home, if recovery
returns to canonical main, if project settings split per home, or if cleanup
removes either base. Keep main and both external PRs unmerged; verify local base
files survive. Use deterministic native transports/owned native fixture helpers
where possible; no additional Desktop profile, real PR creation or live user
preference mutation is needed.

Also probe a progressing plan before any combined artifact exists: land task A
on its feature branch, keep task B's marker only in a worker child, and add an
Architect resolution on the base branch. Task scope shows A; plan/PR scope
shows the complete actual selected branch range and resolution, not B's
unmerged marker. Repeat after another landing and evidenced PR base/head
change; old pinned links still reopen their original sources. Exercise native
association reuse when available and a supported, explicitly documented
unavailable/fallback case when it is not.

Run `bun run verify`, focused new plan-workspace/public-entrypoint tests,
existing target/proof/dependency/cleanup/continuation regressions and
`bun run build:server`. Publish the actual binding/control symbols and native
probe observations in `design/plan-workspaces/`.

## Integration order and overlap

One coherent systems task owns binding producers, routing/recovery consumers
and regressions. The native Settings backend plan is its prerequisite: reuse
that plan's canonical settings/inheritance/custom-agent adapters rather than
racing the same runner/core interfaces. The external Settings UI need not
finish first. The queued final Changes consumer follows this producer as well
as its existing discussion/symbol prerequisites. Preserve normal scheduling and
all active workers; this is not a global pause.

Existing Changes structural/discussion/symbol/consumer work continues. The
separate theme/semantic-population/importance-order/dim-unchanged finish feedback
still awaits the user's word; this feature authorizes no duplicate UI writer.
