# Roll out delegated-agent capacity

LAZERS starts with a project-wide limit of **3** active delegated agents. The setting is revisioned in the shared task database and keyed by the stable canonical-project identity, so worktrees of the same project share it. A different project has an independent setting. Lowering the limit does not interrupt work already admitted; new work waits until capacity becomes available.

The limit includes runtime Implementors and Auditors and native OpenCode subagents (including research and review helpers). Architect sessions are excluded. Queued runtime tasks remain in the task plan; native helper calls wait at their tool boundary. No worktree is removed or recreated to enforce the limit.

## Rollout probe

Run the focused persistence, registered RPC, and Settings component tests first:

```sh
bun test --max-concurrency 1 \
  src/runner/delegated-agent-capacity.test.ts \
  src/runner/delegated-agent-capacity-rpc.test.ts \
  test/plugin-settings/delegated-agent-capacity.test.ts
```

These automated checks use deliberate fixtures and do not replace the live rollout
probe. Then use a disposable project in OpenCode Desktop:

1. Open **Settings → LAZERS** from a session in the project. Confirm the initial maximum is 3 and the active/waiting counts are shown.
2. Create more independent, dependency-eligible task work than the limit. Confirm no more than three Implementor/Auditor attempts are active, overflow remains queued, and a queued task's reason identifies delegated-agent capacity in Tasks and `lz-inspect-plan`.
3. In a second worktree of that same canonical project, read the setting. Change the limit there and confirm the first worktree observes the new revision. In a separate project, confirm the setting remains independent.
4. With the limit full, launch a native research/review subagent. Confirm it waits rather than starting another agent. Verify an Architect session continues to work outside the quota.
5. Complete one active agent. Confirm the next eligible task is admitted by plan priority and dependency eligibility, with no active worker interrupted or restarted. Finish one native helper and confirm its waiting peer can start.
6. Lower the limit below the current active count. Confirm existing agents finish normally and no replacement starts until active work falls below the new limit. Restart/reload OpenCode while work is pending and confirm the setting and queued plan work remain durable.

Record the configured revision, active/waiting counts, and the observed wait/refill reasons. The probe is successful when the limit is never exceeded, overflow remains recoverable, and the independent project remains unaffected.
