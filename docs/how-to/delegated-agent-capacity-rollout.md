# Roll out delegated-agent capacity

A project's delegated-agent limit is its **Limit** in **Settings → Projects** (`limit` in the shared settings store, keyed by the project key, so every checkout and worktree of the project shares it). A different project has an independent limit. With no limit set nothing waits for capacity, which is how LAZERS behaved before the limit existed. Lowering the limit does not interrupt work already admitted; new work waits until capacity becomes available. A changed limit applies on the next scheduler pass.

The limit includes runtime Implementors and Auditors and native OpenCode subagents (including research and review helpers) started from LAZERS sessions. Architect sessions are excluded; an Architect takeover keeps the task's single slot. Queued runtime tasks remain in the task plan; native helper calls wait at their tool boundary. No worktree is removed or recreated to enforce the limit.

## Rollout probe

Run the focused capacity tests first:

```sh
bun test src/runner/delegated-agent-capacity.test.ts src/runner/roles-capacity.test.ts
```

These automated checks use deliberate fixtures and do not replace the live rollout
probe. Then use a disposable project in OpenCode Desktop:

1. Open **Settings → Projects**. Set the project's **Limit** to 3.
2. Create more independent, dependency-eligible task work than the limit. Confirm no more than three Implementor/Auditor attempts are active, overflow remains queued, and a queued task's reason identifies delegated-agent capacity in Tasks and `lz-inspect-plan`.
3. In a second worktree of the same project, confirm the same limit applies. In a separate project, confirm its limit is independent.
4. With the limit full, launch a native research/review subagent. Confirm it waits rather than starting another agent. Verify an Architect session continues to work outside the quota.
5. Complete one active agent. Confirm the next eligible task is admitted by plan priority and dependency eligibility, with no active worker interrupted or restarted. Finish one native helper and confirm its waiting peer can start.
6. Lower the limit below the current active count. Confirm existing agents finish normally and no replacement starts until active work falls below the new limit. Clear the limit and confirm queued work starts on the next pass.

Record the limit, active/waiting counts, and the observed wait/refill reasons. The probe is successful when the limit is never exceeded, overflow remains recoverable, and the independent project remains unaffected.
