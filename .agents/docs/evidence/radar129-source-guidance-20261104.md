# LZ129: concise source guidance and same-worker steering

Original durable task `91c6c95d-9965-421f-9b35-49da50f84979`, revision1; attempt
`58d8d699-6a12-44c3-a5af-954b2b5564bc`, worker
`ses_aeff3e9ac5d24c6c944d35e31b050963`. This is a task-linked guidance addendum,
not an immutable-specification rewrite, replacement task or added acceptance rule.
The current native task API has no general guidance-amendment action; do not
silently mutate stored proposal/context entries or misuse a scope amendment.

## Decision from actual evidence

At1793834104797, exact assignment-bound public metadata showed native execution
running, zero pending permissions, and more completed reads/greps. One completed
assistant interval was289790ms and ended with a grep; a subsequent read completed;
the current assistant turn had no completed endpoint. These are message wall
intervals, not model-compute/CPU durations or proof of struggle. No reasoning bodies,
raw tool input/output, prompts or arbitrary metadata were exported. The owned tree
was still clean atf06a65e. Content-free evidence is retained at approved temp path
`radar129-activity-check-20261104.json`.

No stopped-worker, permission, failed-tool or exhausted-effect evidence supports
retry/restart. Clean source and elapsed time alone do not establish failure.
However, original guidance cited predecessor IDs instead of enough actual starting
seams. The1854-character later instruction mixed useful findings with coordination.
Decision: one short same-worker source/scope steer, then let it continue; request a
concise progress note at its next natural boundary, not a proof-only turn.

## Selected-history interpretation

Keep the original goal: compact live reads separated from on-demand pageable
selected **persisted observation/progress facts**. The companion history read
belongs in129 because it demonstrates that live reads never fetch/rebuild it.
Complete native conversation capture, a Trajectory replacement, history UI and
file-preview production do not belong here. This follows original129's zero-native-
context constraint and later Radar B boundary; it does not remove history acceptance
or broaden authorization. No indispensable writer-scope amendment is established.

## Inline worker guidance

```text
Original LZ129: same goal and acceptance; current execution is authorized. Selected history means on-demand pageable persisted observation/progress facts for the exact authorized selection, not native conversation history or a Trajectory/UI rewrite. Keep that small companion read here so tests demonstrate live reads do not fetch history.

Three source findings at f06a65e:
- observability/contract.ts:473 and rpc.ts:56–86 are the registered boundary and authorization seam. Smaller legacy Radar output still inherits its historical source work; authorization precedes cache/read access.
- runner/store.ts:2465–2478 and progress/projection.ts:232 offer limited attempt progress and safe export, not paging/byte guarantees. Seq-only polling misses existing-row terminal enrichment; journal change metadata can help, but constructor/page/advance write.
- observability/read.ts:1817–1848 captures native context for Trajectory history; it is not the context-free history reuse. Radar B owns consumer/preview presentation.

At your next natural break, one lz-report-progress note with the chosen live/history cut and first test or concrete blocker, then continue. Compatibility tests are under src/radar/{transport,state}.test.ts, not test/radar.
```

Source research: native read-only reviewer ses_e57287b39ffeYWXHam4l4IhONd, using
the actual registered/read/store/export seams at the running baseline. No tests,
build, source edits, local inference review, interruption or new worker ran.

## Delivery receipt

At1793834273290,1243characters were put and read back under original-worker key
`lazers.architect.radar129.source-findings.20261104.v2`, with exact project/agent/
attempt/location and unarchived identity checked before and after. Only after
successful v2 readback was the older1854-character v1 entry superseded, avoiding
duplicate active instruction overhead. Native instruction history and this note
retain the earlier context; original task specification and acceptance are unchanged.
No synthetic prompt/new turn, interrupt or retry was issued. Availability is proven;
actual consumption/response is not yet observed. Approved-temp receipt:
`radar129-source-guidance-v2-20261104-receipt.json`.
