# Native outcome inbox observation

**Status: pending exact-artifact verification.** This record is deliberately not
acceptance evidence for wake suppression.

On 2026-10-31, read-only `Service.discover({ version: "2.2.5" })` found the
authenticated local OpenCode 2.2.5 service; `server.info` reported PID 16786. The
task's Architect owner was still busy. The coalescing artifact in this worktree
was not loaded in that host, so its inbox behavior could not be tied to this
change.
No native messages were enqueued or cancelled and no user inbox input was
changed.

After the exact artifact is loaded in the pinned host, Architect must record the
actual old/current inbox IDs, types, delivery states, and matching durable
outbox IDs/receipts here. Confirm that only the owned same-plan queued synthetic
was cancelled, the newest outcome remains current, unrelated inputs remain, and
the obsolete outcome row/history is retained. Until that observation is added,
native wake suppression remains unverified.
