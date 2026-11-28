# Feature-PR plan execution homes

Authorized clarification, 2026-11-28. This extends the existing integration-target
feature; it does not replace its target store, proofs, state machines or scheduler.

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

Run `bun run verify`, focused new plan-workspace/public-entrypoint tests,
existing target/proof/dependency/cleanup/continuation regressions and
`bun run build:server`. Publish the actual binding/control symbols and native
probe observations in `design/plan-workspaces/`.

## Integration order and overlap

One coherent systems task owns binding producers, routing/recovery consumers
and regressions. The native Settings backend plan is its prerequisite: reuse
that plan's canonical settings/inheritance/custom-agent adapters rather than
racing the same runner/core interfaces. The external Settings UI need not
finish first. Preserve normal scheduling and all active workers; this is not a
global pause.

Existing Changes structural/discussion/symbol/consumer work continues. The
separate theme/semantic-population/importance-order/dim-unchanged finish feedback
still awaits the user's word; this feature authorizes no duplicate UI writer.
