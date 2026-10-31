# Speech replay repair

Root repaired the three independently reproduced cases after canonical merge
`68a1c5d`: duplicate execution-start resets, mid-line code delimiters split across
parts, and repeated unmarked successful completion. Native durable start sequence
now makes starts idempotent; stale previous-turn events are ignored, per-turn
deduplication is bounded and terminal delivery is idempotent. The Markdown parser
retains line position across parts rather than interpreting an inline delimiter
as a closing fence. Stop suppression remains intact across duplicate starts.

Discriminating regressions use monotonic native event sequences and canaries.
The supported unmarked-provider successful-final fallback remains.
Validation: **253 tests passed, 0 failed, 2,408 assertions**; focused registered
composer/event tests and strict typecheck pass. Native speech observation follows
the GUI build; it is not inferred from these tests.

Native replay was driven while Architect continued working. The speaker remained
available, reached its Preparing/Stop state, and clicking it returned the control
to replay. Persistent native inference tracing recorded successful local speech
generation (including a 52-token input / 104 generated-token segment) without
logging the prose. This is generated/playback-state evidence, not a claim of
perceptual audio quality. The native auto menu successfully toggled from off to
on; the next real final response is used for automatic-speech observation.

A further hardening reads the playback signal unconditionally in the native pill
so its Preparing/Reading/Stop title is reactive. When the native text stream ends,
the current automatic turn is suppressed: an opening fence may have been lost,
so an unseen continuation cannot safely be spoken. A known subsequent execution
start resumes automatic speech; manual completed-response replay remains usable.
The registered event-path regression demonstrates both suppression and next-turn
recovery. This does not claim replay of events that the host stream did not retain.
