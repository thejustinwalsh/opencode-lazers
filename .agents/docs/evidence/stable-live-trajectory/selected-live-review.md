# LZ-36 selected live event — source review hold

Root reported the stale live-inspector path in candidate
`08b2a4726564a43adec77238aa8315ae5dc7eebc`. Native independent review
`ses_e6810b9d2ffeurL4xH881YkKsS` confirmed it without source edits, live inference,
reloads or worker restarts. This is not a mounted native reproduction or pass.

`panel-state.ts:613–622` resolves captured event, then selectionEventSnapshot,
then liveEvents; selecting a live event stores that object in the snapshot.
`refreshStatus:348–380` replaces liveEvents but not a surviving selection's
snapshot. `panel.tsx:314–324` uses the same stale precedence, and `:835–860` renders
that selected value's title/payload.

A one-shot in-memory check invoked actual selectEvent, actual refreshStatus and
the source-extracted selectedEvent projection plus eventPayload. After same-ID
completion, liveEvents showed succeeded/result tool completed, but the selected
projection remained running/result absent. Reselecting the same ID still returned
the stale snapshot. Existing panel-state tests at `:513–608` select a captured
historical event and assert only liveEvents completion, leaving this case uncovered.

Required correction: preserve captured-history as-of precedence, but use a current
live event before a fallback snapshot when no captured entry exists. Apply this
consistently to selection, inspector projection and reselection. Do not fix a live
view by rewriting frozen historical payloads.

The regression must select a newly running live tool absent from capture, open
Payload, apply same-ID terminal status/result and assert immediate selected title/
payload update plus correct reselection. Disclosure/open DOM identity and reading
anchor must survive; a separate case keeps captured payload frozen and proves
snapshot fallback only when neither captured nor current live value exists.
State/read tests of the live array alone do not prove these inspector/DOM outcomes.
Original exact-candidate mounted gate remains pending.

Runtime had already started a second attempt after the first artifact's quality
receipt failed because report.md needed formatting; focused/all/build passed.
This is an actual receipt failure, not the stale-receipt bug. The confirmed source
finding and prior no-bundle-checksum-proof instruction were installed on the
currently running repair session `ses_d82453d7170e4facb78c60fcc89cdbc1`, attempt
`29659c51-4151-4c61-8951-4482b6089b7e`, without restart or replacement task.
The eventual returned artifact must be checked for actual incorporation; native
instructions alone are not acceptance evidence.
