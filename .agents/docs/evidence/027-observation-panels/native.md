# Radar and Trajectory — native observation

## Status: partially observed; remaining coverage open

The root driver's native evidence is recorded in canonical main commit `ff4a717`
at `.agents/docs/evidence/027-observation-panels/native-root-review.md`. It
records actual mounted panels and Terra's review of the shown captures. This
worker did not run that Desktop session; the captured portions below are the
only native coverage claimed, and the source-of-truth record contains the full
observations and repair history. Design files and deterministic fixtures are not
live-output evidence.

The recorded environment facts are:

- LAZERS task: `8db1b281-c288-4c2e-abaa-f846dd642246`.
- Worktree: `/Users/tjw/.local/share/opencode/plugins/lazers/runner/worktrees/0bd64a2f-c81d-4b61-b1b5-c6af0bf75a30`.
- Starting revision: `e7aae9618ad1f07563c02d82b7dddaa1936f1bf2`.
- OpenCode CLI: `v2.2.5`; the root evidence reports Desktop `2.2.5` in the
  canonical checkout.
- Bun: `1.4.4-canary.1` (`da867c60b`).

## Observed by the root driver and reviewed by Terra

- Radar Timeline showed real plan `b50a1a71`, with recorded Radar/Trajectory,
  projection, and speech intervals. Terra reviewed the dark approximately
  450-CSS-pixel capture and passed the shown comparison/layout goal.
- Radar Flow rendered the projected `lazers-task/1` machine; selecting its
  running node updated the inspector, with possible and recorded transitions
  distinguished. Terra passed the shown readability/selection cleanup; the full
  tall graph was not visible.
- Trajectory showed actual attempt/check data and a selected plan check. Native
  keyboard resizing changed the split `56 → 61 → 56`; closing and reopening
  retained the selected check and split. A native marker click changed the row
  and inspector. Terra passed the focused header, selection, and inspector
  cleanup in the shown dark panel.
- Root recorded repairs for selection attribution, Radar startup, compact
  Timeline tracks, and routine refresh banners. Their commit IDs and details
  remain in `native-root-review.md`.

The supplied root record identifies the observed plan but does not include the
product task/session IDs, exact product worktree, or evidence of overlapping
isolated product workers, all-branch review, or owned cleanup. Those facts are
not inferred here.

## Remaining native observations

The root driver should open the built plugin in Desktop, use actual ongoing
scheduler work, and return captures plus running references for Terra to review.
Record concrete findings and their resolution; absence of an observation remains
unresolved.

- Confirm Radar Flow and Timeline update from live scheduler changes, and
  Trajectory shows all actual attempts/checks/token usage, including failed and
  retried history and unknown timing/cost where records are incomplete.
- Exercise wide, narrow (including 330 CSS px), and short panes; selection,
  search, resizing by pointer and keyboard, independent scrolling, theme/scope,
  close/reopen, and disconnect/reconnect. Confirm no duplicate registrations or
  stale foreign-scope data.
- Record the actual task/session/worktree/version facts and captures. Have Terra
  review running references and resolve reported layout or behavior findings.
- Record overlapping native isolated product workers, all-branch integration
  review, and nonforced cleanup of only owned, idle, clean, merged worktrees.

The root evidence explicitly leaves alternate themes/fonts, 330-pixel and short
panes, full graph scrolling, complete reconnect/error interaction, and all
source/session navigation unobserved; it also notes coincident Timeline points
may overlap for pointer selection. No inference is made about audio quality,
performance guarantees, model rankings, or unknown costs. Worker-fan-out and
cleanup evidence also remains absent from the supplied record. Automated
verification results are in [`verification.md`](./verification.md); they do not
satisfy the remaining native review.
