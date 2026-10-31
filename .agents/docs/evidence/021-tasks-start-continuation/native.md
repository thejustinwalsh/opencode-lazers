# Tasks Start and continuation — native observation

## Observation status

Final repaired-build acceptance is outstanding. Source tests and a GUI bundle
do not establish native behavior or visual fidelity. The observations below
distinguish the worker artifact from the subsequent Architect repair.

The existing captures were inspected only as prior-state evidence:

- `/private/tmp/lazers-tasks-native-20261031.png`
- `/private/tmp/lazers-tasks-details-native-20261031.png`

They show the earlier inspector with truncated list/objective text and the
pre-change Details presentation. They do not show the new Start action,
record-backed state/reason, continuation, or revised split behavior and must not
be treated as post-change verification.

## Missing observations

- Start a real submitted task in Desktop and observe its runtime plan, worker,
  state/reason updates, and record-backed activity.
- Verify an existing Architect and a missing/archived-owner continuation,
  including queued notification delivery and restart recovery.
- Exercise search/header wrapping, pointer and keyboard resizing, saved split
  restoration, narrow/short panes, and independent list/detail scrolling.
- Return fresh running captures to Terra for review of native fonts/theme,
  panel quietness, and the final inspector composition.

No native observation is claimed for these behaviors.

## Worker artifact d215cc8 — driver observations, 2026-10-31

Root driver supplied actual Desktop captures:

- `/private/tmp/lazers-tasks-d215-review.png`
- `/private/tmp/lazers-tasks-d215-narrow-search.png`

At approximately 330 CSS pixels, Search made the header, list and inspector
overflow right. Terra confirmed the retained repair item; this is not a new
design request. The four retained items are narrow Search sizing, delayed
detail-scroll restoration, selection/scope-bound Start feedback, and disconnected
status accessibility. These captures precede the Architect repair and cannot
prove that repair passed.

The driver also opened the actual parallel-runner child through the native
subagent menu: Luna Max, the native isolated worktree and live tools were visible.
This proves that child's explicit route, not the repaired default native agent
selection or simultaneous worker execution. The worker's empty Session Tasks
view is tracked under existing projection task `efd8459f`; see
`../../spikes/023-scoped-observation-projections.md`. The driver returned to the
parent and left the narrow Tasks panel open for post-repair checks.

## Supported refresh handoff

The V2 GUI guide's **Reload and updates** section documents local bundle rebuild
hot reload via plugin updates; it does not restart the server entry. Root's
pinned-source research confirmed that `client.location.reload` rebuilds location
services and refreshes changed local TS dependency generations (Bun require cache;
Node `__opencode_reload`). Active sessions continue at their next step; pending
forms cancel. After the final build, root may reload this location, without a
background service restart or settings/inference changes, then exercise the
repaired Start/search/split/state paths and return running captures to Terra.

Native acceptance remains pending that repaired-build pass. Effective native
agent selection is now verified separately: the installed pinned client's
`agent.get({agentID: "lazers-implementor", location: {directory: checkout}})`
returned this checkout and `{providerID: "openai", id: "gpt-6-luna", variant: "max"}`.
This used `Service.discover` and the existing authenticated endpoint, without
starting/restarting a server. The earlier CLI read without location returned
`/Users/tjw` and null, not evidence about this project's selection. A real new
Start still needs to demonstrate the selected route end-to-end.
