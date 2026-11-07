# WebGPU cache ownership recovery

2026-11-07. Source fix: `cbd66d8`.

## Defect and repair

The main provider used `ModelLease.lost(window)` for both document reload and
permanent window close. Document loss deliberately reserves the ownership token
for the same window's replacement document. After permanent close, that window
cannot return, so another window's acquisition remained rejected with
“The model cache is owned or being cleaned up”.

The native `ctx.windows.on("close")` callback now uses `ModelLease.closed`.
It joins outstanding document-loss cleanup, drains cache operations, then removes
the closed window's reservation. Late acquisitions/registrations from that
window are rejected. Reload retains the existing same-window handover. Cleanup
failure retains ownership; unrelated windows cannot free a live owner.
Downloaded model files and feature settings are unchanged. No new timer,
background process, persistence store or cache deletion was introduced.

## Checks

- Regression coverage failed before the new close operation existed.
- 30 tests passed across lease, registered main IPC, main tracing, renderer runtime
  and model lifecycle. 173 assertions. Existing reload tests remain passing.
- An additional inherited-provider ownership regression passed afterward:
  lease suite 16 tests / 106 assertions. It verifies an unrelated close cannot
  release inherited ownership.
- Bun formatter, linter, strict typecheck and GUI build/evaluation passed.
- Registered main fixture exercises the actual native window-close callback,
  followed by a different window acquiring successfully.

## Native Desktop observation

Built the repaired GUI and fully quit/reopened only Desktop. Native service
PID3219 remained unchanged; the original LZ-177 Luna Max implementor remained
active. No server reload or worker interruption.

1. The original window returned `local GPU ready.`: 19 input / 4 output tokens.
2. Opened a second window through File → New Window and opened the existing
   Architect session. The second window displayed the ownership error while
   the first window legitimately owned the model.
3. Selected the original window through the native Window menu and used File →
   Close Window. Kept the application and second window running.
4. The surviving window automatically moved from the ownership error through
   Loading to Ready. No manual reload, model removal or application restart.
5. The surviving window returned `local GPU ready.`: 19 input / 4 output tokens.
6. Switched to the decision model and received
   `{"ok":true,"kind":"boolean","value":true}` from the native diagnostic probe.

All six feature switches remained enabled; idle unload remained Never; the
downloaded-model display remained 3.19 GB. One window remains open after the test.

[Surviving-window screenshot](webgpu-closed-window-recovery-20261107.png).

This demonstrates the repaired close/handover path. The user's earlier error
did not include an operation trace, so this report does not attribute every
historical occurrence to that one path. Simultaneous ownership by two windows
remains intentionally excluded. Contention currently appears as an error until
the existing automatic retry succeeds; improving that presentation is separate.
