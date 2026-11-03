# LZ-72 retained-check preflight

Observed at Unix ms `1793739951028`, using reviewed repair `055ab04` integrated
with the original preflight and routing foundation. Exact candidate checks:
11 tests / 106 assertions and quality passed. Main checks: 21 tests / 199
assertions and quality passed. Independent review also cleared the four original
production-binding and inspection-race defects.

The inputs were captured through a read-only SQLite transaction for the exact
retained plan/task/attempt/effect. They are supplied snapshots, not a continuing
live-state guarantee. The CLI separately revalidated the candidate and receipt.

- Supplied binding matched: plan version 9, node version 4, original attempt
  `ed96f0b9-102b-4c64-aa8b-708a62d49fe7` and uncertain `verify:runner` effect.
- Candidate `e6a58ea` matched and was clean.
- The original runner receipt is missing; original child identity is unavailable.
- Containment remains **unproven**, coordination remains required and
  `executionPermitted` remains **false**.

Retained input/output: [request](request.json), [inspection](inspection.json),
[result](result.json). The inspection's Git manifest is input to the existing
preflight contract, not an additional correctness gate.

## Remaining path — preparation only

1. Coordinate and separately authorize a runtime-owned exclusive window that
   blocks new dispatch/verification for this resource. Do not interrupt the
   independent Models lane to create that window.
2. Obtain positive runtime-owned containment evidence for the original check and
   its descendants. Missing original child identity is a real blocker. Neither
   empty inventories, elapsed time, worker idle nor service replacement supplies
   this proof. If identity cannot be recovered, a wider containment method needs
   separate review and authorization; do not invent one from these snapshots.
3. Re-read the exact binding under that same window and stop on any change.
4. Only then authorize a distinct runtime-owned fresh verification operation,
   with its own bound receipt and normal acceptance. Preserve the old uncertain
   effect rather than rewriting it as passed or replaying implementation.

Current commands do not implement that fresh uncertain-effect recovery path.
The preflight supplies its precise handoff, not authority to execute it. LZ-72,
LZ-88, LZ-57/58 and LZ-99 retain their existing states/reservations.

## Integration and cleanup

The LZ-98 repair plan recorded task/combined source integration and native
non-forced cleanup completed (version 13); its worktree is absent from the native
inventory. The original LZ-94/95 plan recorded both source landings and combined
integration, but cleanup remains held at version 40 because worker activity is
not conclusively idle. Both original worktrees remain registered. No unchanged
cleanup retry, forced removal, service action or uncertain check execution was
performed.
