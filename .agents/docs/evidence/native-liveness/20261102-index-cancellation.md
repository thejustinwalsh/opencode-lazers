# Cached-index cancellation leak

2026-11-02. Same OpenCode service PID 7793; no restart.

## Observed blocker

The unwanted LZ-65 replacement `ses_44f086948b924e2d92d5029995877408`
is no longer foreground-active. Its Code Mode call concurrently fetched task
instructions and `lazers_project_index({})`; it ran at Unix ms 1793639820284
and ended with tool error at 1793639972423. Despite that, native permission reads
at 1793640427893 still showed a new read request for main `src/webgpu/dictation.tsx`.
Other reads showed changing per-file requests. The active LZ-63 worker is also
waiting in an unfiltered index call, started at 1793640067841.

The context tools wrapped index work in `Effect.tryPromise` but ignored its abort
signal. Each per-file native permission assertion ran as a detached Effect promise
with no cancellation signal. Rejecting/interrupting the outer tool therefore left
the scan issuing subsequent requests. This is a concrete cancellation leak, not
evidence that foreground inactivity alone proves no background work exists.

## Repair and verification

Pass the native tool cancellation signal through the index principal, per-file
permission Effect and scan boundaries. Propagate abort rather than converting it
to ordinary denied-file filtering. Refresh cannot publish an aborted collection.
Existing permission assertions, denied-file filtering, workspace isolation,
immutable publication/cache reuse and Architect-only refresh remain in place.
The small permission adapter was extracted so the regression exercises the same
adapter used by plugin setup.

A registered-tool regression failed before repair: its permission wait received
no cancellation signal. After repair, interrupting that actual tool aborts the
native permission Effect and stops at one file. All 16 context tests / 128
assertions pass with Bun 1.4.4-canary.1, along with autoformat, lint, typecheck and
diff checks. The old already-detached invocation cannot acquire a new signal
retroactively; native reconciliation of that retained cancellation remains open.
No fresh model prompt or fabricated completion was used to test the repair.

Desktop remains explicitly locked according to Computer Use, despite the user's
unlock reply. New native tool cancellation must still be observed once control
is available. Broader indexing throughput and its per-file permission UX are
separate observations, not claimed solved by this change.
