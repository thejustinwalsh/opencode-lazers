# Native profiler startup stall, 2026-11-01

Observed on OpenCode Desktop 2.2.5, canonical source `fc1a5aa`, freshly built GUI.
Inference settings remained enabled: all six switches ON, apple/WebGPU, idle Never.
Architect remained OpenAI Sol High; retained LZ-28 and LZ-36 stayed in their original
busy OpenAI Luna Max sessions. This is not native acceptance of LZ-39 or LZ-43.

## Timeline (UTC)

- Canonical GUI build succeeded. Renderer controls reloaded, but new main IPC
  methods were initially unavailable. Supported native Desktop Restart activated
  them. Native Reload model recovered its disconnected startup status to Ready.
- 19:07:09.399: armed capture `04981389-8d20-4317-a87e-636c4303dcc9` began;
  profiler start was acknowledged at 19:07:10.450. Settings could close/reopen
  without ending the capture.
- 19:08:10.483: no-job deadline produced truthful `job-not-seen` metadata.
  The actual review tool ran at 19:08:20.596, after streaming its arguments.
- Real review completed: first request `5964e650-1d85-4e88-aeb8-3722964ef27c`
  used eight questions / 1,867 actual input tokens and completed in 9.168 s.
  Follow-ups completed with four / 1,871, three / 1,814 and one / 1,686.
  Final completion was 19:08:41.770. These are four jobs in one task review,
  not four independent review repetitions.
- 19:09:20.515: re-arm `8cd4c3fc-5edf-4844-b13b-32ca5537a8a4` began.
  At 19:09:22.517 it returned a `profiler-start` timeout, with no target job.
- Native unresponsive event: 19:09:44.514; responsive event: 19:09:51.532.
  Last recorded inference stage was already `complete`, request
  `bc66f310-c9ff-4ce3-9b24-19d6b6a9de84`.
- A subsequent renderer-lag trace recorded 38,503 ms lag, with no active job.
  JS heap was about 370 MB. The five-second OS sample began at
  19:10:14.670, after the recorded responsive event, and reported 2.5 GB physical
  footprint / 4.9 GB peak. It is a post-stall sample, not a blocked-renderer stack;
  these are distinct measurements and times.
- Native Export Logs succeeded. Its recovery dialog repeats after export by
  design. Keep Waiting dismissed it; Desktop was Ready without another relaunch.

## Evidence and interpretation

Local artifacts (not committed wholesale):

- `/Users/tjw/Downloads/opencode-debug-20261101T191030.zip`
- `/private/tmp/lazers-renderer-70740-freeze-20261101T1913.sample.txt`
- `/Users/tjw/.local/share/opencode/plugins/lazers/diagnostics/renderer-armed-capture-1793560090483-1.json`
- `/Users/tjw/.local/share/opencode/plugins/lazers/diagnostics/renderer-armed-capture-1793560162517-2.json`
- `/Users/tjw/.local/share/opencode/plugins/lazers/diagnostics/renderer-unresponsive-1793560186515-3.json`

Window 1, exact renderer PID 70740. No valid standalone CPU profile was obtained.
The OS sample has largely unresolved V8/native frames; it does not attribute
the lag to an application function or establish a memory exhaustion cause.

The observed stall followed profiler startup after completed inference. A CDP
timeout bounds the caller's wait, not the renderer's synchronous V8 operation.
Profiler startup is an investigation lead, not proven causality or an explanation
of the earlier run-stage freeze. Do not disable inference or claim recovery fixes
passed on this basis.

Research: [V8 profiler startup source](https://chromium.googlesource.com/v8/v8/+/89ed6b764afb0878ab0fb0a2f96e90e12220b490/src/profiler/cpu-profiler.cc)
shows existing compiled-code enumeration and Wasm code logging during startup.
This supports investigating startup cost, but is not a version-matched diagnosis.
[OpenCode GUI documentation](https://opencode.ai/v2/docs/build/plugins/gui/#reload-and-updates)
documents local rebuild reload of both GUI processes; the observed stale main IPC
still required native Restart in this session.

Next observation should arm before a genuine review begins, with enough lead time
for streamed tool arguments. Further startup attempts after D1 is loaded need care:
the latest attempt timed out and preceded a substantial lag. Successful capture,
repeated ordinary review/navigation, speech/question/model-switch compatibility
and the original lifecycle/Trajectory gates remain unproven.
