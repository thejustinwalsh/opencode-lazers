# Native Tasks disclosure observation — 2026-11-08

Candidate: `66927d5`, existing Tasks/Radar review checkout. Native Desktop2.2.6,
owned instance `lazers-full-instance-9TcU4T`, service25100, renderer25133.
Root drove the approved owned native bridge after the existing probe explicitly
yielded UI control. No model prompts, task starts or implementation occurred.

## Observed

- LAZERS native plugin state was active, with server and GUI features. Architect,
  implementor and Auditor were registered in the canary project.
- Opened Tasks through the native side-panel action.
- Selected explicitly synthetic held taskLZ-1. Activity and holds was collapsed.
  A native click expanded it and showed the recorded hold reason and BlocksLZ-2.
- Changed State from Open to Failed/exhausted. Only synthetic failed taskLZ-3
  remained and was selected; the visible state label changed to Failed.
- Expanded its Activity history. Submitted, READY, DISPATCH and FAIL records,
  timestamps and the explicit simulated failure reason appeared in rendered text.
- This LZ-3 has no real worker/attempt. Its Activity and holds disclosure expanded
  to an empty section. Show useful data or omit an empty disclosure; do not invent
  a worker observation. Reuse existing Tasks recovery/presentation work.
- The held reason remains hidden until expansion. The expanded detail repeats
  diagnostic labels (Recorded blocked, Worker unknown, Observation has no current
  attempt). This confirms prior Tera feedback; simplify within existing work.

## Boundaries and assistance

Four manually seeded, labeled fixture tasks existed before this walkthrough.
Their plan was draft; none was dispatched. No real worker, failure recovery,
Radar activity, narrow viewport or full scroll acceptance is established here.
Details/Activity remained collapsed before user interaction.

Root navigated and clicked controls. One click was not delivered after the page
changed; observing the returned snapshot and retrying its actual control worked.
Action responses can precede the UI update, so a subsequent snapshot/capture was
needed to verify the visible result. Delivery alone was not counted as success.

Screenshot capture window: Unix milliseconds 1794180913936–1794181058725
(144.8s); this excludes earlier setup/navigation and is not total
implementation or verification effort. Owned instance and probe remain preserved
while OpenAI access consent awaits the user. Keep that approval separate from
these model-independent UI results.

## Captures

- [Held, collapsed](root-held-before-20261108.png)
- [Held, expanded](root-held-open-20261108.png)
- [Failed, empty holds disclosure](root-failed-open-20261108.png)
- [Failed, expanded history](root-failed-history-20261108.png)
