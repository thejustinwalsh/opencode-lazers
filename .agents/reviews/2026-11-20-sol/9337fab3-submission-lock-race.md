# 9337fab3 — submission-lock-race

No actionable finding established.

## Checked and sound

- Submit key lookup, provenance and inserts remain inside one immediate transaction.
- Busy retries restore synchronous timeout and yield; deadline produces a visible retryable error.
- Permission checks precede replay/conflict lookup.
- Request-keyed annotations retain caller request identity on retry.
- Lock tests hold the lock past the old budget instead of merely asserting a helper call.

## Not reviewed

- No cross-process test run; tests create databases/git fixtures outside the permitted output directory.
- Not every recovery/audit handler was proven idempotent after every possible post-commit failure.
