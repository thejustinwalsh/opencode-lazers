# Radar live delivery gap — 2026-11-09

## Actual product observation

Root reports that main Desktop Project Radar renders `[object Object]` and no
operational data; Refresh reproduces while the original LZ-181 and LZ-193 workers
are natively active. Main service logs at `2026-11-09T00:42:50Z` and
`2026-11-09T00:44:06Z` identify `lazers.observability` legacy `radar`/`snapshot`
failures: **Observation scope is too large; narrow it**.

This matches LZ-184's existing delivered-feature boundary. It is not a new feature
request, absent-worker evidence, or a reason to increase observation caps.

## Source and recorded checks

- Main inspected at `ba6b5f4fe413e059ae3349ea082829e45252ddae` still uses the legacy
  primary Radar consumer.
- Accepted LZ-184 artifact `89edd14b0cadad49b8b3cb84d733ce56ff82f549` is not main
  ancestry. Its recorded quality/GUI build and monitor checks passed: **158 tests,
  1,228 assertions**. Historical PATH-related exit-127 checks remain historical
  failures; they are not substituted for those later successful checks.
- The existing plan remains blocked on `connected-radar-agent-monitor` evidence.
  Task-node acceptance is not source landing or connected product qualification.
- The preserved combined Tasks/Radar review checkout at `66927d5` is older than the
  final accepted artifact; later changes must not be assumed composed into it.

## Fresh read-only producer observations

Authenticated calls through the existing service's `liveRadar` RPC used the
current Architect session and explicit Session/Project scope, without starting,
interrupting or replacing workers, changing settings, or reading native contexts.

| Scope   | Elapsed in this observation | Returned records                                    |
| ------- | --------------------------- | --------------------------------------------------- |
| Session | 54 ms                       | 1 session, 1 route, 0 calls, 0 flow                 |
| Project | 101 ms                      | 13 managed sessions, 52 routes, 144 calls, 256 flow |

Project inventory, progress, payload, flow and journal coverage reported bounded
or truncated data; these returned counts are **not complete project totals**.
Runner data was current and native events connected. Both scopes reported zero
native-context loads. The compact receipt is retained at
`.cache/driver/lz184-live-read-20261109.json`.

A subsequent Project read positively identified both original active workers:

- LZ-181: session `ses_12ba163aca2a4703a19aa82430adb1ab`, attempt
  `4d691f62-10c6-456f-b862-72cf665c4bb6`; busy, available, exact running assignment.
- LZ-193: session `ses_dd92813879ab4e0da0f5d1c8b5a197d4`, attempt
  `c49fbc65-db5c-44ca-bd42-e142dca7fb09`; busy, available, exact running assignment.

## Acceptance boundary

These observations establish an actual legacy-consumer integration gap and a
working bounded live producer with genuine managed-worker associations. They do
**not** establish rendered monitor behavior, supported file-target observation,
event-subscription recovery, narrow/wide/short layout, scrolling/divider/keyboard
behavior, or screenshot acceptance. Continue LZ-184's existing focused source
review, composition, safe activation and connected qualification. Keep the
user-owned paused OAuth instance untouched, preserve both active workers and all
existing evidence, and leave Desktop crash diagnosis with Driver.

## Reviewed source landing

The later accepted delta received focused independent Luna Max review with no
source blocker. One reviewer statement mistook the retained diagnostics transport
for the primary view; exact-tree inspection corrected it: `89edd14` registers a
wrapper whose default is `RadarLiveMonitorPanel`, with legacy reads only in
explicit diagnostics. That mistaken statement is not a product finding.

The preserved Radar review checkout was composed with the exact accepted artifact
and current main at `7be32be69df94cd1bc4ea0f1f82b6c9315d897e9`. Merge resolution
retained both the earlier UTF-8/output-boundary tests and the accepted output-cap
tests, and retained newer roadmap text. Main's newer worker identity and public
trajectory-input changes survived the automatic source merge.

The first composed quality check stopped because this private checkout lacked
main's newly added `@fallow-cli/fallow-node`; no behavior suite ran in that failed
invocation. Installing the existing pinned dependency with
`bun install --frozen-lockfile` resolved that setup issue. The subsequent checks
passed:

- `bun run verify`: automatic formatting/lint fixes, lint and typecheck.
- Progress, live reads, observation integration, Radar and registered monitor:
  **206 tests, 1,747 assertions, zero failures**.
- `git diff --check` and `bun run build:gui`.

Full logs remain under the Radar review checkout's
`.cache/review/lz184-composed-{quality,behavior,build}.log`.

Main landing is `bd2896d85e17a42a1698db82ad9a6b0fa668420d`. Immediately before
merge, both active workers were observed between tool calls; neither was stopped,
restarted or replaced. The runtime recorded **task source integration only** at
plan version 43. The main GUI was rebuilt successfully. A subsequent actual live
Project read returned six calls with attributed target paths, current runner data
and connected native events; both original LZ-181/LZ-193 exact running assignments
remained busy. This establishes effective producer activation, not rendered UI
acceptance. No explicit extra service reload was needed for that observation.

The connected Desktop interaction/layout/screenshot gate remains open. No consent
action or input to the user-owned paused instance was taken, no failed evidence
was erased, and no cleanup or complete-Radar claim is implied by source landing.

## Actual delivered monitor and Terra review

Root's post-landing interaction report and actual screenshot are committed in
`98e3cbf`: [report](driver-interventions-20261108.md), section “Delivered Radar
native interaction after source landing”, and
[capture](radar-live-worker-20261108.png).

The main Desktop default view is now the live monitor without an extra webview
reload: Root opened command search and escaped, executing no reload command.
Project showed connected updates and both original Luna Max workers busy with
matching task/attempt associations. Selecting LZ-193 updated lower session detail
and exposed 15 recent tool calls with durations. Requested patch targets included
`src/context/repository-snapshots.test.ts` and `tools.ts`; selecting the former
updated the lower Selected call detail. No synthetic fixture, extra model
invocation, worker replacement or interruption was added for these observations.
This resolves the observed legacy-reader blank default view in the delivered UI.

The existing Terra High reviewer independently inspected the capture against
`DESIGN.md` and `radar-agent-monitor-v2.png`:

- Visible: connected live header, session area above a horizontal split and a
  selected-session inspector below; native-consistent typography/dark surfaces.
- Visible: managed busy implementor, task UUID, matching configured/observed
  `openai · gpt-6-luna · max`, “15 returned” tool calls and separate succeeded patch
  cards with readable requested paths. “Patch requested” does not imply a file was
  changed.
- Presentation findings: tall call cards, raw IDs and diagnostic labels reduce
  scanability; task UUID is less recognizable than a task label. Card values such
  as `2s`, `35s` and `0s` lack an explicit duration label. Lower detail extends
  beyond the viewport.
- Report-only in this evidence set: no-extra-reload activation, both workers'
  matching associations, the selection sequence and the selected-call path update.
  The one screenshot does not independently show every reported interaction.

Additional actual Desktop interactions reported by Root establish:

- With LZ-193 selected, focusing the divider and pressing Up/Down changed its split
  value while retaining focus.
- Expanding selected-session history and choosing Load older history increased
  returned entries from **30 to 40**. This proves that pagination interaction, not
  complete history coverage.
- Switching to Session showed exactly **one returned current Architect**;
  restoring Project brought the worker activity back. This scope round trip did
  not involve a server disconnect or worker interruption.

Keep the presentation findings in LZ-184 or later polish according to materiality;
do not create a duplicate task from this capture. Narrow/short geometry,
independent scroll retention, reconnect/reset/flow, multi-call selection stability
over a full run, file-target-to-source navigation, cancellation and a full-history
walkthrough remain unobserved. Updating lower Selected call detail is not proof of
source navigation. No blanket connected-Radar acceptance follows from the source
checks, reported interactions or this single frame.
