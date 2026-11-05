# LZ-142 native completion mismatch

## Observed failure

Routing and formatting source are integrated in9be146c and836b8ca. The merged
source passed598 tests/7579 assertions; the native formatting repair also passed
its255-test dispatch suite and quality checks. Completion remains held by the
native observation adapter, independently of those results.

Exact retained repair attempt: `56382e52-7ef1-4ace-9369-e4039e318e09`, session
`ses_b8ffc8cf2d004610b38e0135de2d20fc`. Its current input is
`msg_c553142adviceNOWREV3format` and the final response is
`msg_1ad3b6f03001yN9NXTiPzCLwF6`.

- At1793907299316 the project recorder observed native execution start sequence7.
- At1793907728730 the assigned location's real idle hook recorded diagnostic
  `idle-entered`, backgroundCount0, executionStartSequence7, eventSequence337.
- At1793907728848 that listener recorded `idle-lineage-unavailable` for the exact
  current review input. It did not publish a formal idle report.
- Native success sequence402 then invalidated the durable row with “Native
  execution success did not match the current experimental.idle execution.”
- The listener IDs at start and idle differ across the loaded locations. This
  shows replacement occurred; it does not establish which reload caused it.
- Read-only native `experimental.session.log` calls, both with omitted `after`
  and explicit `after:0`, returned only `log.synced` at402. They supplied no
  historical events for this adapter's replay algorithm. Negative cursors are
  rejected by the installed API. Do not infer a general retention policy from
  this single session's responses.

The diagnostic zero count is an actual native hook observation. The hold means
LAZERS failed to correlate it, not that a background job was observed running.
Neither tests nor an inactive session alone repair that correlation.

## Current action and later repair

Root asked the native Architect to use the existing exact-input guarded
source-only quarantine, if eligible, so independent work can continue. Preserve
both attempts, failed-check history and unresolved resource/completion state.
No worker turn, historical report fabrication, SQL mutation or new approval is
needed for that existing flow. Verify its actual seal before claiming release.

The native owner subsequently sealed quarantine at1793908578570 with a null
hold and authenticated the exact SourceFence on service PID95968. Ordinary
reconciliation then dispatched existing LZ-57 at1793908728075, attempt
`3b639290-ffc8-4a2c-a5dd-a550abf18da6`, session
`ses_bb2a0db8dda24991a059e5a3138fc39a`. Root independently read its durable policy:
Systems persona, project-mapping authority, exact OpenAI `gpt-6-luna/max` route.
The live native session was active on that same route at1793908779678. This is
a substantive subsequent dispatch observation for LZ-142, not a proof-only task
or acceptance of LZ-57. LZ-142's completion and resource holds remain unresolved.

Later lifecycle consolidation needs an observation path that survives supported
location replacement, with real product coverage for an execution containing
shell work and a mid-execution listener replacement. Existing synthetic tests
passing did not establish this live case. Keep that work behind overdue visible
delivery unless a concrete admission blocker cannot be resolved through current
controls.
