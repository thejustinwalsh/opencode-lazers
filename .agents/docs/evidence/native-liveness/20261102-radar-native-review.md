# Radar native visual and interaction review

2026-11-02. Source corrections `fb0d54a`, `25297d6`, `a2af5c0`, after source
integration `fe5cd61`. Built and activated through native Desktop View → Reload.
No background-service restart or model-setting change.

Tera 6.1 High reviewed actual screenshots against `system-timeline-v3-narrow`
and `tasks-focus-v2`. It rejected the original report-first view: summaries and
connection lists hid the SVG, with overly tall nodes and missing readable edge
labels. Corrections lead with the graph, collapse metadata and record lists,
reflow the header, compact node/ELK spacing at native text size and place SVG text
inside ELK label bounds. Full source records remain available in the inspector
and disclosures.

## Observed

- [Narrow](radar-native-20261102/narrow.png), approximately 400 CSS px: two named
  actual sessions, state/model/effort and a readable directed prompt relationship
  appear together above the horizontal divider. Runtime component begins below.
- [Wide and selected](radar-native-20261102/wide-selected.png), approximately
  560 CSS px: selected relationship and matching lower inspector persist after
  the native divider resize. Tera accepted both observed layout scopes.
- Native click selects the real prompt edge. The lower inspector exposes matching
  endpoints, status, source task/attempt, message and recorded runner transitions.
- After resize, native Session menu opens This session/Project. Dismissal preserves
  scope. From restored menu focus, six Tabs reach the real prompt path; Enter sets
  its accessible pressed state to true and retains the matching lower inspector.
- Upper-pane manual scrolling leaves the lower inspector in place. [Before](radar-native-20261102/scroll-before.png) and [after](radar-native-20261102/scroll-after.png) natural refresh retain the visible graph
  position and selected prompt record while observation changes from approximately
  13:46:20 to 13:47:03 local. This is one live refresh interval, not a universal
  future-position guarantee.
- Current and temporarily stale observations both occurred while actual workers
  ran. Read-boundary/lag warnings remain explicit. No error was hidden to produce
  the clean capture. All six inference settings remained enabled; local runtime
  regained Ready after candidate loading.

Checks: 27 Radar tests / 212 assertions, formatting, lint, typecheck, diff check
and GUI build pass. The last full Main suite predates these visual corrections.

## Still unproven

Actual event-only animated pulse and quiet resynchronization/recovery behavior
remain live acceptance items. A static screenshot, source check or the observed
refresh interval does not establish them. Do not call the entire Radar task or
roadmap complete from this review. Full task text is intentionally abbreviated in
nodes and must remain reachable in the inspector/disclosures.

## Parallel dogfood

At Unix ms 1793644987364, both original implementation sessions read back as
`openai/gpt-6-luna#max` in distinct native worktrees, without pending permissions
or inbox items: Models editor `dffe9628-84f2-42cc-8774-109a2c610717` and recovery
producer activation `ba1dd1f0-1ea8-40e3-933a-01a9f6ca122c`. The producer later
returned `9f68dcf`; that return is not integration or product acceptance.

A transient pair of session-read timeouts was followed by successful re-poll of
the same handles. No worker or service was restarted. Cheap inference settings
RPCs answered in 39–42 ms during diagnosis. A one-second service stack sample
(`/private/tmp/lazers-service-20261102-slow-read.sample.txt`) was mostly
unsymbolicated and does not establish a cause. Renderer DevTools were used for
read-only layout inspection and then closed; no profiler was armed. Its red log
entries included both HTTP 500 inference RPC failures and ONNX warning text;
these are not interchangeable evidence of a GPU crash.
