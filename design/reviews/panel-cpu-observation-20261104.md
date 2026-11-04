# CPU observation with Radar visible and hidden

Root drove the native Desktop panel toggle while existing OpenCode work continued.
The panel was restored afterward. No model setting, profiler, service restart or
worker interruption was used. These are consecutive real-work observations,
not matched idle benchmarks: Architect/reviewer/worker activity changed.

Process identities: service 95968, renderer 54076, Chromium GPU process 54072.
Percentages are CPU-second deltas divided by elapsed seconds, multiplied by 100.
GPU-process CPU is not GPU hardware utilization.

| Condition         | Start Unix ms | Elapsed ms | Service CPU | Renderer CPU | GPU-process CPU |
| ----------------- | ------------: | ---------: | ----------: | -----------: | --------------: |
| Radar visible     | 1793819615433 |      12036 |      70.62% |       33.15% |          25.17% |
| Side panel hidden | 1793819702889 |      12038 |      51.42% |       23.18% |          31.07% |
| Radar restored    | 1793819767732 |      12040 |      44.60% |       24.25% |          25.75% |

Hiding the panel did not eliminate sustained service/renderer activity. Reopening
it did not reproduce the first window's rate, so these differences cannot establish
Radar's causal CPU contribution. The independently measured 8.65MB Radar response
remains a specific read-path problem; it is not a complete battery diagnosis.

Continue with bounded live reads and subscriptions, while separately attributing
remaining service/runtime and renderer activity. Compare the event-driven Tasks
candidate after actual integration/activation under recorded workload conditions.
Do not claim a battery fix from one shared timer, a passing build or these windows.

Normalized records calculated from the retained CPU-second counters:
`/private/tmp/lazers-panel-cpu-windows-normalized-20261104.jsonl`.
Read costs and source candidates: [Astra review](astra-radar-perf-20261104.md).
