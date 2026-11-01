# Matched Desktop freeze during real task review

2026-11-01. Times below use UTC and local EST (UTC−05:00) explicitly.
This supersedes the earlier follow-up's statement that no matched incident existed;
it does not retroactively change what that earlier inspection established.

## Captured incident

After a real Architect self-review retry, Desktop stopped updating at about 89k
context and Local model Busy. The server had already continued to a later final
response while the window retained older content. An accessibility tab click did
not switch Tasks; a coordinate click then produced the native not-responding
alert at about 15:40:49 UTC / 10:40:49 EST. [Native alert](dialog.png).

The deployed main-process hook logged window 1, **renderer PID 77897**, last stage
`run`, request/job **`11a8cb1f-ce2c-45db-ae91-949094f3f1ff`**. This is the same
retry whose inputs-ready/run began at 10:32:23.865/.868 EST with 2,087 actual
input tokens, shape `[1,2087]` and eight questions, without later terminal trace
in the earlier inspection. The earlier request `324b3c9e...` had returned a
MapAsync device-loss tool error; it is a different request, not this retry's
terminal result. Source log is `20261031T205316/main.log` lines 16271–16290.

The [automatic capture](automatic-capture.json) timed out at **profiler-enable**
within its two-second deadline. No valid `.cpuprofile` was obtained. Root then
used the supported one-shot macOS `sample` utility on the exact reported PID:

```text
/usr/bin/sample 77897 5 1 -file /private/tmp/lazers-renderer-77897-20261101T1541.sample.txt
```

The [live five-second native sample](renderer.sample.txt) started at 10:41:20.579
EST. It records **9.2 GB physical footprint, 11.0 GB peak**. A simultaneous
read-only process observation reported about 68.6% CPU. Main-thread frames traverse
V8/JS/JIT/GC-related code with many unsymbolized/offset frames. No `_OrtRun` frame
was found by the bounded inspection. This supports a matched stalled execution
and substantial process footprint; it does not identify an application function,
prove memory exhaustion, or establish a particular ORT/driver root cause.

Native Export Logs produced the local archive
`/Users/tjw/Downloads/opencode-debug-20261101T154140.zip`. It remains outside the
repository; raw debug exports can contain broad logs and should not be published
wholesale. The committed capture/sample contain no prompts, audio or headers;
the sample has no inline data URLs. No custom daemon or continuous profiler ran.

## Recovery and preserved work

After artifacts were preserved, Root used the dialog's **Relaunch** action for
Desktop only. It was recovery, not a source fix. No background-service restart,
task retry/replacement, model switch or inference setting change was requested.

Fresh native interaction switched to Tasks and restored Project, Completed,
LZ-9 search/selection. LAZERS settings showed all six features ON (master WebGPU,
questions, decisions, task review, dictation, speech), chat/speech Ready on apple,
and existing idle-unload Never. Root returned to the roadmap without changing them.

Public API readback before/after relaunch retained these exact native sessions,
Luna Max routes, workspaces and attempt identities; busy timestamps were unchanged
and new updates/tool progress followed recovery:

| Task  | Native session                         | Retained attempt                       |
| ----- | -------------------------------------- | -------------------------------------- |
| LZ-28 | `ses_0837d798635a4b10a58e1fdc9175854f` | `941526b0-62de-4578-b82e-f2a458c95358` |
| LZ-36 | `ses_63fe4a90c94a4d85aeb2f78bc11232a4` | `83daf09a-0112-484e-af40-57ff1ff6e554` |
| LZ-37 | `ses_f34b22b676264c88852c3cf86b77284d` | `27667b0c-aadd-4ec5-804b-bcc9af770642` |

## Next boundary

Give this matched case to Architect's existing responsiveness investigation.
LZ-37 corrects diagnostic clocks; it must not be credited as the freeze fix.
Evaluate current runtime/decision/recovery source and the matched run before
selecting a compatible repair and discriminating checks. Preserve working local
features and independent workers. The earlier cancellation of the abandoned
LZ-14 refactor/stash still stands; this evidence does not automatically revive it.
Actual cause, repaired behavior and repeated native acceptance remain unfinished.
