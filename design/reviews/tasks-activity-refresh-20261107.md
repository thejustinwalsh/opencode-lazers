# Tasks activity refresh — 2026-11-07

## Observed and repaired

The project Tasks list repeatedly displayed original LZ-174 as Worker Unknown
while native session.active and the public task activity RPC both reported its
exact original worker active. A full30-task activity call also reported active,
in165ms; filtering to LZ-174 immediately showed Active. This is not evidence that
the native worker was idle, replaced, or missing.

`TaskPanelState.refresh` and `observeCurrentActivity` cleared the previous
activity before awaiting its replacement. Frequent list refreshes therefore
discarded useful observations while the native read was in flight. The panel
now retains the previous observation during replacement reads, then replaces it
with the returned exact activity. An actual failed read clears the requested
activities and reports unavailability. Scope/generation/selection guards remain;
no native task state or producer was changed, and no polling was added.

## Verification

The new regression failed on unchanged source: the previously active worker
became undefined during a held ordinary refresh. After correction it retains the
same observed attempt until the replacement says inactive, and a subsequent
failed read clears the observation. All22panel-state tests/91assertions pass,
including late scope/selection responses and event coalescing. Formatter, lint,
typecheck, diff checks and GUI build/bundle evaluation pass.

Native Desktop Reload Webview loaded the correction. The project-wide list then
displayed the original174and173 workers as inactive/succeeded, matching their
completed native sessions, instead of clearing all activity to Unknown. A
subsequent active-work observation remains needed to qualify sustained behavior;
the unit regression covers the in-flight replacement interval deterministically.

## Separate reload defect

At chat-ready, native OpenCode → Reload Webview caused local inference to report
`A stale renderer generation cannot claim the model cache`. This is existing
LZ-165's fresh-page/window-generation case, distinct from8975516's verified full
Desktop process restart recovery. Root queued the exact reproduction to Architect
and released its WebGPU source reservation; the focused Tasks change touches only
panel state/tests. Do not mark LZ-165 complete from the process-restart repair.

Full Desktop quit/reopen restored chat-ready with settings/cache unchanged.
The native local chat probe then returned `local GPU ready.` again
(19input/4outputtokens). The reload-generation defect remains queued for165;
restart is a recovery observation, not its implementation.
