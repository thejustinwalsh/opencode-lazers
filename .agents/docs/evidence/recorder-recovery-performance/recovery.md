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
database transaction. An owned reminder retains its separate reconciliation
work. These fixed checks are not counted as per-message fact projections. The
counter establishes avoided append/merge attempts only; it does not establish
CPU savings or wall-clock improvement.

The unchanged-history test compares all durable progress rows, the
`sqlite_sequence` value, and the observation revision before and after the warm
replay. A separate test records a native tool-success through the memoizing
recorder, then a native input-started fact through a second SQLite connection.
Replaying the identical retained message after either revision change is not
skipped: each replay performs the three expected message/gap append attempts,
preserves the terminal success and higher-authority native timing, and leaves
rows and sequence unchanged. Its following warm replay returns to zero append
attempts.

## Recovery completeness checks

The prescribed recovery suite passed:

```text
bun test src/progress/recorder.test.ts src/progress/native.test.ts src/progress/reconstruction.test.ts
65 pass, 0 fail (593 assertions)
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
