# Local-review incident — native read-only follow-up

A later matched freeze was captured at 15:40 UTC; see the
[new incident](../renderer-freeze-20261101T1540/report.md). The findings below
describe the earlier pre-hang inspection.

Native investigation `ses_e684cfd22ffeA75L4NDI0b8iwj` followed the ordinary review
failure without changing files, settings, sessions or processes, launching
inference, attaching a profiler or sampling a live process. Main at inspection
contained the Root observations in `report.md`, including commits `1ee8c1e`,
`c64afb1` and `bc93d7a`.

## Matched execution facts

Source for all log line references below:
`~/Library/Application Support/ai.opencode.desktop/logs/20261031T205316/main.log`.
Times are 2026-11-01 local **EST, UTC−05:00**, not EDT.

Four consecutive window-1 `systemone` review jobs completed at 10:31:04.620,
10:31:09.855, 10:31:15.136 and 10:31:20.339 (lines 15602–15620, 15744–15762,
15886–15904 and 16028–16046). Actual input counts were 2,078, 2,043, 2,000 and
2,069, summing to the tool's 8,190 reported input tokens. This is sequence-level
usage, **not one 8,190-token input** or a context-overflow diagnosis.

The next request/job `324b3c9e-485a-45c6-9254-d0ba5a8004f8`, also window 1:

- `inputs-ready` at 10:31:20.863: 2,078 actual tokens, shape `[1,2078]`, capacity
  8,192 (lines 16108–16124).
- `run` at 10:31:20.864 (lines 16125–16140).
- `dispose` at 10:31:25.902 with no intervening `readback` (lines 16141–16154).
- Terminal `error` at 10:31:25.903, 5,045 ms elapsed, classification `unknown`,
  name `Error` (lines 16155–16172).

The configured provider is WebGPU; observed operator provider remains unknown.
The trace corroborates inference failure but omits exception text. The specific
ORT buffer-download/MapAsync device-loss error is an observed **tool result**;
there was no matching `device-lost` trace. Do not conflate those evidence sources.

Next request/job `11a8cb1f-ce2c-45db-ae91-949094f3f1ff` queued at 10:32:23.858
(lines 16173–16186), reached `inputs-ready` at 10:32:23.865 with 2,087 tokens,
shape `[1,2087]` and eight questions (lines 16234–16250), then `run` at
10:32:23.868 (lines 16251–16266). No subsequent readback/dispose/terminal trace
existed at inspection. It is the retry candidate by time/sequence, not a proven
join to a native tool-call ID.

## Limits and interpretation

- The diagnostics directory was still absent. No new LAZERS unresponsive,
  responsive, process-gone or debugger-capture record appeared in the current log.
- These new traces establish window 1, not a current renderer PID. Do not reuse
  yesterday's PID. No matching CPU profile or sampled frames exist.
- `Desktop renderer heartbeat was lost` comes from broker heartbeat expiry
  (`src/webgpu/broker.ts:26–29,50–57,72–81`, default 15 seconds). It is not an
  Electron unresponsive event. The last successful poll and expiry receipt were
  not established by the inspected logs.
- Runtime terminal trace precedes broker result delivery
  (`src/webgpu/runtime.ts:414–426`): execution and delivery remain distinct.
- The new renderer-log records at `renderer.log:91–92` are ORT placement warnings,
  not matched device-loss or freeze evidence. Existing recovery handling must be
  evaluated before proposing any change; absence of handling is not established.

The initial investigator's timezone comparison was wrong: local 10:05–10:22
events do postdate the 15:02:44 UTC snapshot. Relevant source equality was checked
separately; log freshness must not be inferred from that publication timestamp.

Root's healthy 15:24 UTC Network sample remains a before-case, not evidence about
this later failure: current 200 rows and measured payload sizes do not establish
context-read counts, sustained health or causality. Root closed DevTools to keep
the already-installed automatic next-freeze capture available. Root's 15:30 UTC
50 → 99 → 50 Activity-row observation is a distinct pre-LZ-36 pagination regression,
not a freeze cause or a page-union proof. It was supplied to the existing LZ-36
worker as supporting evidence without changing acceptance or recording a pass.

No causal freeze repair is justified by these facts alone. Preserve ordinary
authorized activity and existing capture hooks; no settings/provider/capacity
change, LZ-14 resumption or unsupported performance claim follows from this case.
