# LZ-32 native Desktop observation

Observed 2026-11-01 against history candidate `74ffb3a`, merged into main as
`a078ea0`, with later documentation commit `6a05b01`. OpenCode Desktop 2.2.5,
current native Architect `ses_e68a9ed37ffeVqzPWRXN5SB7Uw`; local inference stayed
Ready/enabled. Driver used native Computer Use, not CLI model prompts.

## Working interactions

- Project Completed shows accepted historical work. Selecting LZ-31 and opening
  Trajectory identifies task `83a61fc2-88f5-40d2-97a7-f39c37b2bb13` and original
  attempt/session after its native worktree was removed. Available native context
  remains reported; there is no source-tree requirement to inspect old work.
- Searching `LZ-9`, selecting it and opening Trajectory identifies
  `970b0feb-1fd3-40bb-a61d-f8decccb8a9f` and all four attempts (three failed, one
  accepted). Retargeting a mounted panel and closing/reopening the panel both
  preserve this exact task identity rather than falling back to LZ-31.
- Returning to Tasks preserves scope, state, search and selection. Clearing search
  preserves Completed. Project to Session preserves Completed and narrows results
  to the current Architect's associated completed work. Failed/exhausted is
  truthfully empty in this retained dataset; Project keeps that filter.
- Project Cancelled reveals three real cancelled tasks, including LZ-14 and LZ-28.
  All includes mixed accepted/cancelled/queued/verifying records. These are real
  persisted tasks; no synthetic live-database fixtures were created.
- At approximately 330 CSS px, scope/state/search controls wrap within the pane,
  detail text stays readable and the trajectory/copy actions wrap without
  overflow. At approximately 450 CSS px, old trajectory controls and all four
  attempts remain readable.
- Keyboard: Escape closes the State menu and returns focus to its trigger;
  Return reopens it, Down + Return selects Completed and applies that state.

Screenshots: [LZ-31 after cleanup](lz31-native.png),
[LZ-9 all attempts](lz9-native.png), [narrow cancelled view](cancelled-narrow.png).
The screenshots predate the pending presentation correction below.

## Checks and remaining boundary

Combined main passed 388 tests / 3,674 assertions, formatter/linter/strict types
and GUI build. Logs were retained at `/private/tmp/lazers-history-integrated-tests.log`
and `/private/tmp/lazers-history-native-build.log`. Native GUI hot reload occurred
on build; no separate verification server was started. Functional filter/RPC
behavior was observed in Desktop, not inferred from those checks.

**Native usability acceptance is withheld.** Tera's screenshot review found
unlabeled active/total fractions misleading in filtered history (`0/1` above
accepted work, and `1/1` above one cancelled task). See
[the design review](terra-review.md). Driver sent the finding through Desktop to
Architect for correction; recheck the affected live presentation before recording
`native-usable:human` against the corrected artifact. This observation does not
claim the correction is implemented or accepted.

## Corrected artifact recheck — passed

Candidate `b21e3e30309616713a206278de7b5011cb7f7953` was independently
reviewed and activated by merge `73f77838d20dd3d0ecc424d24334052323e3c072`.
Its delta changes the group-heading presentation and scope label, adds the
rendered component and checks, and updates worker evidence. Main's focused Tasks
checks passed 41 tests / 284 assertions; formatter/linter/strict types and GUI
build passed. Scheduler receipts independently report focused/all/quality/build
exit 0, no timeout and unchanged input for this exact candidate. The earlier
388-test combined-main result was not rerun or relabelled as this correction's
full-suite result.

Fresh Computer Use after GUI hot reload observed the narrow Project Completed
view without active/total fractions, then Project Cancelled without the formerly
misleading count on LZ-14. Both retain meaningful title-only accessible group
names. Scope now reads Project. Switching back to Open restores the existing
active counts and truthful running/verifying/queued icons. Local inference
returned to Ready without changing its setting.

[Corrected Completed](completed-corrected.png) and
[corrected Cancelled](cancelled-corrected.png) were re-reviewed by Tera 6.1 High:
[visual follow-up](terra-follow-up.md) passes the prior blocker. The screenshot
review does not substitute for driver functional evidence.

On the corrected candidate, the driver again selected Completed, searched LZ-9,
selected that exact task and opened the mounted Trajectory. It identified
`LZ-9 · 970b0feb · r1`, all four recorded attempts, 267 tool calls and 4/4
available native contexts. The earlier full filter/scope, mounted/reopened-target
and keyboard observations remain applicable to the unchanged underlying logic.

Root's native usability review is now satisfied for this candidate. Runtime
acceptance/integration must still be recorded through Architect's tools; this
paragraph is observation evidence, not a direct task-state mutation.
