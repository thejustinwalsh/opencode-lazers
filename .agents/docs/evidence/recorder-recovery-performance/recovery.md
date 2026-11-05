# Retained-message recovery optimization evidence

## Deterministic work counter

`src/progress/recorder.test.ts` wraps the recorder's private `appendIn` method in
tests only; production code has no profiling counter or loop. The fixture creates
histories of 1, 4, and 16 assistant messages, each with one retained tool fact.
The previous repeated-replay path attempted two fact appends per message (tool
and assistant step) plus one fixed recovery-gap append: `2N+1`, or 3, 9, and 33
attempts respectively. The first/cold projection reports those same counts.
Warm unchanged replays report zero fact append/merge attempts at all three sizes.

The warm replay still invokes reminder reconciliation once, fingerprints the
bounded retained history, performs the assignment/revision reads, and enters the
database transaction. If the project revision advanced, it hashes only that
attempt's durable progress rows before deciding whether retained-message
projection is still reusable. That digest streams durable rows and retains no
full progress history in the memo. An owned reminder retains its separate
reconciliation work. These checks are reported separately from per-message fact
projection. The counter establishes avoided append/merge attempts only; it does
not establish CPU savings or wall-clock improvement.

The 122-session round-robin fixture runs cold recovery for 122 terminal
assignments (366 append attempts and 122 per-attempt durable-fact hashes). The
first unchanged pass reports 0 append attempts and 121 per-attempt hashes to
account for the project revision changes caused by the preceding cold writes;
the next unchanged pass reports 0 append attempts and 0 per-attempt hashes. A
native progress fact is then recorded through another connection for an
unrelated worker. The following 122-session replay still reports 0 append
attempts (with 122 per-attempt hashes to refresh the changed project fence), and
the next replay reports 0 append attempts and 0 per-attempt hashes. Tracked
sessions' durable facts remain unchanged throughout the warm passes.

The per-recorder LRU is capped at 256 entries. The test retains all 122 session
memos across the round-robin passes and checks that each memo contains only an
assignment fingerprint, retained-history fingerprint, durable-progress
fingerprint, and project revision; it retains no messages or contexts. Each
fingerprint is a 64-character SHA-256 digest. The actual 122-session warm-reuse
checks, rather than the cap increase itself, establish the observed working-set
coverage.

The unchanged-history test compares all durable progress rows, the
`sqlite_sequence` value, and the observation revision before and after the warm
replay. A separate test records a native tool-success through the memoizing
recorder, then a native input-started fact through a second SQLite connection.
Replaying the identical retained message after either revision change is not
skipped: each replay performs the three expected message/gap append attempts,
preserves the terminal success and higher-authority native timing, and leaves
rows and sequence unchanged. Its following warm replay returns to zero append
attempts.

The DateTime regression starts with numeric retained timestamps, then replays
fresh Effect UTC instances and same-instant named/offset Zoned instances. These
warm passes produce zero append attempts and identical stored timestamp values,
matching the recorder's `dateMillis` projection. Earlier changed timestamps are
reprojected, late streamed/completed message and tool endpoints are recovered,
and a DateTime-stamped native input event recorded after memoization remains
authoritative after retained-history replay. DateTime values outside the known
`time.*` and `retry.at` timestamp positions are not normalized: a model route
change carried on such a value is reprojected. Class lookalikes, getters and
cycles continue to take the conservative full-recovery path; no `toJSON` method
is called.

## Recovery completeness checks

The prescribed recovery suite passed:

```text
bun test src/progress/recorder.test.ts src/progress/native.test.ts src/progress/reconstruction.test.ts
69 pass, 0 fail (660 assertions)
```

Existing recorder cases cover changed/new messages, retained tool transitions,
route/timing conflicts, late terminal history, and reopen/replay. The native test
`project recovery is coalesced while native hooks remain per location` observes
an event-triggered context reread. Reconstruction test `terminal historical
context is fairly rechecked without a native event` exercises terminal refresh.
Neither read path was changed or suppressed by this optimization.

## Native performance observation

Not measured by this worker. Acceptance still requires Root's controlled,
same-view native comparison on the exact candidate, with comparable idle
conditions, DevTools closed, and unchanged inference/model settings. Report warm
service CPU and recovery work before/after, plus new/late-fact observations. No
native CPU improvement is inferred from the deterministic fixture counter.
