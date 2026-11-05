# Tasks rendering control — 2026-11-04

Root compared the existing Tasks view with both Tasks/Trajectory tabs closed,
then restored the original tabs, selected Tasks and selected LZ133. Measurements
used current service95968, renderer8902 and GPU-process8898 over12-second windows.
Inference flags stayed true and native inference demand was false at1793849743111.
No model was unloaded or authority setting changed.

| View                        | Start, Unix ms | Service CPU | Renderer CPU | GPU-process CPU |
| --------------------------- | -------------: | ----------: | -----------: | --------------: |
| Tasks visible A1            |  1793849535728 |      40.59% |       14.94% |          30.13% |
| Both extra tabs closed B1   |  1793849630124 |      29.64% |       11.87% |          29.64% |
| Same Tasks view restored A2 |  1793849702188 |      38.14% |       18.94% |          30.41% |

The background136 worker and historical-review successor continued running; this
is not a quiet exact-workload before/after repair comparison. The fixed foreground
Architect chat was idle when the comparison began. Native activity can change
service load; GPU-process CPU is not GPU utilization.

Closing the panels did not remove the approximately30% GPU-process CPU. Renderer
CPU was modestly lower with panels closed. These windows do not attribute the
cost specifically to task-icon animation, so no animation change was made. Further
attribution should distinguish native app/global rendering from plugin work and
reuse these controls rather than assume the icons explain the whole issue.

A subsequent minimize hotkey did not establish an independently verified
occluded-window state; no minimized-window CPU claim follows. Native Window-menu
selection restored the current Architect window. Clipboard paste later failed to
change the composer; direct typing was verified and used to submit the actual136
draft review finding. No prompt was sent through a CLI/model API.

Raw counter rows:`/private/tmp/lazers-panel-cpu-windows-20261104.jsonl`.
