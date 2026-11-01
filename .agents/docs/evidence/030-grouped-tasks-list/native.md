# Grouped Tasks native review

2026-11-01. OpenCode Desktop 2.2.5, native Sol High Architect session
`ses_e6e0e6239ffdtzIePMeJ1sHA4l`, rebuilt repaired GUI `53ba06f`/`e3a6f56`.
The earlier Radar/Trajectory observations are separate.

Observed with real recorded project work:

- Tasks remains the bottom extra-panel choice, has a themed icon and closes.
- Completed history exposes real sequential plans and the five-task b50 plan.
- Searching LZ-21 reveals its contextual projection parent and actual Radar child,
  with the filtered sibling explicitly represented as hidden. Selecting that
  child loads LZ-21, prerequisite LZ-19 and successor LZ-23.
- Clicking LZ-19 from the filtered inspector clears the search and loads the
  actual projection details and its LZ-21/22 successor links.
- The unfiltered b50 root has a disclosure; expanding it records both real Radar
  and Trajectory branches, retaining speech and assembly on the root lane.

[Search and dependencies](grouped-search-450.png).

**Observed defect:** after scrolling the full history down to b50, toggling its
parallel disclosure jumps the list to the beginning. [Post-toggle capture](grouped-full-450.png)
shows the retained LZ-19 inspector and unrelated first rows. Row/link accessibility
identities also churn during refresh. Root reported the reproducible defect to
the native Architect for repair in the same task; no replacement worker started.

Whole-plan native review remains open for the repaired disclosure/scroll/focus
behavior, narrow screenshot and Terra 6.1 High comparison. Paging, full custom-font
and disconnect/reconnect matrices are not established by this pass.
