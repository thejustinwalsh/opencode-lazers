# Radar connected baseline

Actual Desktop walkthrough while original Models LZ-172 and Tasks LZ-182 workers were natively active. Canonical GUI, narrow side panel, 2026-11-07.

## Consumer failure

Session and Project scopes both failed, including native Refresh. The panel displayed `[object Object]`, “No operational Radar data is available” and unavailable details. [Actual screenshot](artifacts/radar-connected-baseline/failed-project.png).

Read-only native SDK `snapshot` and legacy `radar` calls independently failed in both scopes at Unix ms 1794090159244–1794090159827 (154–230 ms). Native service logs identify the cause: **Observation scope is too large; narrow it**. This is a legacy read failure, not proof that workers are absent. No settings, worker state, resource ownership or production DB rows were changed.

## Existing live producer works

The accepted LZ-129 `liveRadar` RPC succeeded against the same real project and current Architect session:

| Scope   | Observed at, Unix ms | Elapsed | Returned data                                        | Response bytes |
| ------- | -------------------- | ------- | ---------------------------------------------------- | -------------- |
| Session | 1794090231569        | 73 ms   | 1 session, 1 route, no current calls or flows        | 2,390          |
| Project | 1794090231745        | 189 ms  | 12 managed sessions, 50 routes, 126 calls, 233 flows | 250,319        |

Project freshness reported current runner state and connected native events. Inventory, progress, payload and journal coverage were bounded; these counts are returned records, not complete project totals. It read 687 source rows / 659,811 source bytes, made 24 source queries, 1 inventory read and 9 selected native-session reads, with zero native context loads. These are single observations under active work, not a controlled performance benchmark.

## Application to existing work

The new agent-monitor consumer should use this existing live producer and progressive selected history, preserve its actual coverage information, and replace the failed broad legacy reads. Do not add another producer, inflate row limits, invent polling or treat missing telemetry as inactivity. Render structured errors usefully. Carry the observed failure and actual narrow/wide screenshot review into the same coherent Radar feature.

Root queued the actual failure and server cause to the native Architect without interrupting its current tasking. The native Architect separately verified the accepted producer's source is already on main and is reconciling the missing runtime integration receipt. Source landing alone does not establish consumer behavior or live performance acceptance.

A second live project read at1794090364431 explicitly included BOTH actual workers as managed, available, current and busy, with their original task/attempt/session IDs and observed routes. This establishes active-worker presence in the new producer; aggregate counts alone did not. Main's native integration record for LZ-129 is now integrated version119, preserving original accepted artifact9f61a6633dd3d64a3bc51672c4e5d63e1234adcb.
