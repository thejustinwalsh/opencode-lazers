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
