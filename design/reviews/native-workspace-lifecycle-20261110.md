# LZ-185 native lifecycle qualification

## Reviewed source

Candidate: `1222f8dff9cd28a6962303dd8f0a4367a9509f17`, latest retained
attempt `b1616897-5aaf-4ab0-b4f9-d71f1d0ba615`. Its task and combined
`lifecycle` receipts both exited zero. Original failed/interrupted receipts and
the previous accepted candidates remain recorded; no replacement worker ran.

The final repair adds complete-project terminal cleanup discovery instead of
the 1,000-plan display query, and skips repeated inventory for recorded-complete
retained cleanup until its durable version changes or the 60-second fallback.
Restart probes again. Pending cleanup still retries rather than treating cached
observations as settlement. Tests cover discovery beyond the display window and
completed retained cleanup's unchanged ticks, fallback and restart.

Architect composition preserves main `3ada9711bb81c0118e90ca714452a8ae7da4f83c`'s
complete active-attempt ownership query, paged runnable-plan enumeration, draft
admission guard and retained-check recovery. Retirement checks all active owners,
including owners in the same plan. Conflicts were resolved in the existing native
review checkout, not by rebasing or replacing the retained worker.

## Native create, readback, removal and committed-source recovery

Project: `b5da4cadd97e51f2f6c88ff71daa1006f6a5b7df`.
Canonical root: `/Users/tjw/Documents/ChatGPT/opencode-lazers`.
The candidate's `canonicalProjectWorktreeParent()` was imported directly from
the retained checkout and returned
`/Users/tjw/Documents/ChatGPT/opencode-lazers.worktrees`.

Using `.agents/docs/workspace-lifecycle.md` from the candidate, the supported
native API was called twice with the following payload (create, remove, recreate,
remove). Each command exited zero; removal responses had empty bodies.

```json
{
  "projectID": "b5da4cadd97e51f2f6c88ff71daa1006f6a5b7df",
  "from": "/Users/tjw/Documents/ChatGPT/opencode-lazers",
  "directory": "/Users/tjw/Documents/ChatGPT/opencode-lazers.worktrees",
  "name": "architect-lz185-native-fixture-1222f8d-20261110",
  "branch": "3ada9711bb81c0118e90ca714452a8ae7da4f83c"
}
```

Both native create responses recorded the exact same actual directory:

```json
{
  "directory": "/Users/tjw/Documents/ChatGPT/opencode-lazers.worktrees/architect-lz185-native-fixture-1222f8d-20261110"
}
```

Fresh native inventory after each create contained that directory with strategy
`git`. Git readback after each create confirmed HEAD
`3ada9711bb81c0118e90ca714452a8ae7da4f83c` and empty porcelain status.
Native `session.active` before creation and each removal reported only this
Architect session (`ses_8ce6308ac2ec4c61b45dea8aa759b28a`), not a fixture session.
Each removal used the exact native-returned directory and `force:false`:

```json
{
  "projectID": "b5da4cadd97e51f2f6c88ff71daa1006f6a5b7df",
  "directory": "/Users/tjw/Documents/ChatGPT/opencode-lazers.worktrees/architect-lz185-native-fixture-1222f8d-20261110",
  "force": false
}
```

After final removal, fresh native inventory, `git worktree list --porcelain`
and filesystem inspection all confirmed fixture absence. The second creation
restored committed source at the same actual path; this was deliberate removal
and recreation, not an actual interrupted create or a lost-response simulation.
No missing logs or background-idle proof were reconstructed.

This qualifies the reviewed candidate's helper and documented native workflow.
The fixture intentionally used already-integrated main as its source so that
non-forced cleanup did not discard unmerged work. It did **not** execute the
candidate runtime as a native producer or claim fixture HEAD was the candidate.
Runner-producer behavior is covered by the candidate and composition tests.
No service reload or watched-source activation occurred during the fixture probe.

## Preserved resources

Fresh inventory before and after the probe retained both Root-owned review
registrations and the LZ-185 retained runner checkouts. Final readback:

- `lz182-review-recovered`: HEAD `95db91a84c9134fa62fa6be2e7bb1bdb8cfe02f7`;
  six untracked native qualification screenshots remain untouched.
- `lz184-review-recovered`: HEAD `7be32be69df94cd1bc4ea0f1f82b6c9315d897e9`;
  clean status.

The existing `architect-lz185-composition-20261110` checkout remains the review
resource. Only the newly created disposable fixture was removed. Raw local
command readbacks are retained under
`/private/var/folders/tr/3_qw264x55z9g8391dqb7tb40000gn/T/opencode/lz185-native-probe-1222f8d/`;
the exact selected receipts and limitations above are the durable review record.

## Composed verification

`bun run verify` passes on the composed source (including automatic formatting
and lint fixes), as does `git diff --check`. The eight-file lifecycle/store/location
run initially returned 544 passing tests and one failure: receipt-cut valid plan
cancellation asserted no `Bun.spawn` calls at all. A focused rerun reproduced it;
inspection showed exactly `git status --porcelain` in the original attempt
checkout, main's asynchronous read-only cleanup safety probe, not check replay.
The composition keeps that safety probe and updates the assertion to permit only
that exact command and workspace, while forbidding any additional process.
All 12 receipt-cut cancellation variants then passed (176 assertions), and
`bun run verify` and `git diff --check` passed again. The original 544 passing
tests were not silently relabeled as a green full rerun.

The native-evidence hold was recorded against the exact candidate through the
plan control. Reconciliation also started a new combined check; while it runs,
its intended effect is live work, not proof of an uncertain failed execution.
Do not retry, cancel or replace that check merely to clear its intended state.
