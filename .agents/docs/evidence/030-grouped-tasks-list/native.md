# Grouped Tasks native review

2026-11-01. OpenCode Desktop 2.2.5, native Sol High Architect session
`ses_e6e0e6239ffdtzIePMeJ1sHA4l`. Current repaired GUI: `f2beb81`, including
Terra's dependency spacing `bdc9137`; full validation recorded in `87cfe98`.

Root drove actual recorded work in Desktop:

- Tasks is the bottom extra-panel choice, has a themed icon and closes normally.
- Session/project completed history exposes real sequential pairs and b50's
  five-task plan. Its projection parent expands into the actual Radar and
  Trajectory branches. Independent speech and their shared assembly remain on
  the root lane. The assembly inspector lists all three real prerequisites.
- Searching LZ-21 reveals its contextual projection parent and Radar child, with
  its filtered sibling explicitly represented as hidden. Selecting Radar loads
  LZ-21, prerequisite LZ-19 and successor LZ-23. Following hidden LZ-19 clears the
  search and loads its actual details. Clearing search restores normal disclosure.
- At a scrolled b50 position, pointer collapse and Space expansion retain the
  list position and inspector selection. Keyboard expansion still works across
  a native refresh interval. Selecting either child and the join remains stable.
- At approximately 450 and 330 CSS pixels, groups stay within the list viewport,
  the objective and Done when wrap in the independent inspector, and Details and
  Activity start collapsed. Restored width is approximately 450 CSS pixels.
- Closing and reopening Tasks retains Project history, b50 expansion, the
  scrolled lane, LZ-23 selection and explicit 39% list split.

Terra 6.1 High reviewed the actual wide, narrow and disclosure screenshots
against `design/task-panel/tasks-focus-v2.png` and the visual contract. Its narrow
spacing adjustment is included; no material visual correction remains for the
shown states. This is native task-list acceptance, not a claim of universal
external-link, custom-font, arbitrary-DAG or disconnect/reconnect coverage.
Schema/state/graph regressions cover the source boundaries separately.

[Repaired wide](grouped-repaired-detail-450.png),
[narrow](grouped-repaired-330.png),
[collapsed disclosures](grouped-repaired-disclosures-330.png),
[close/reopen](grouped-reopen-450.png).
[Rendered-message task navigation](../029-task-references-links/native-root-review.md).

The earlier [post-toggle failure](grouped-full-450.png) reproduced a real list
jump from object-identity remounts. `f2beb81` preserves canonical render owners;
the observations above retested that behavior after rebuilding. The earlier
failure remains recorded rather than treated as a passing capture.
