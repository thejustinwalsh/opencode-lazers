# Scoped observation projection — driver review

Reviewed artifact `bb2c78d0dcb9d0aff659096774659b443206a443` from task
`efd8459f-1dbe-4472-968b-f26f59504291`, attempt
`7eaa8182-bc03-4200-9086-78a28bf709f2`. Runtime focused/full/quality receipts
passed unchanged. Radar and Trajectory workers have already started from that
accepted backend artifact; they are not stopped or redispatched by this review.

Independent review uses a native isolated checkout based on canonical main,
including speech repairs `0443758`/`bf73cbe`, diagnostics `ec3c882` and the
updated Radar design handoff `bbde60e`. The backend changes are confined to
scoped read projections, their registration and timing annotations. No second
runtime actor is created, snapshots use the actual task machine definition,
and the registered Tasks adapter preserves durable worker/owner links.

## Reproduced gaps and scoped corrections

- `changes.ts` inferred loss whenever native durable sequence numbers were not
  consecutive. `rpc.ts` subscribes to a subset of event types, so omitted
  sequence numbers are normal. The regression now requires monotonic jumps to
  invalidate normally, duplicate/late native records to remain ignored, and an
  actual stream disconnect to request resnapshot. The projection's own emitted
  event sequence still detects client-side gaps.
- Snapshot planned nodes omitted their task specification revision/objective;
  these are now returned from the complete scoped task set, independent of
  Tasks filtering/pagination, with the existing privacy sanitization.
- Snapshot had no attempt/check timing, forcing Timeline to request detailed
  trajectory (and native histories) merely to draw lanes. Snapshot now returns
  top-level `attempts` and `checks`, scoped by plan/task/attempt identity. Attempt
  reservation starts and unknown ends are labelled distinctly from recorded
  WORKER_STARTED/WORKER_STOPPED activity segments and verification receipt
  endpoints. Resumed worker segments remain separate; no acceptance time is
  substituted for a missing attempt end. Check metadata excludes stdout/stderr,
  command bodies, policy and native transcript content.

The new regression uses a native-history adapter that throws if called. It
requires exact persisted activity/check endpoints and task revision/objective,
and checks that no receipt log/secret enters the snapshot. Together with the
filtered-sequence regression, the tests failed against the returned artifact
before the corrections (3 pass / 2 fail), then the focused projection/trajectory
and registered RPC suite passed (28 tests / 209 expectations). A fixture needed
the newly required empty interval arrays before strict typecheck could pass;
the initial typecheck failure is retained rather than called successful.

After the fixture correction, independent full validation passed **263 tests /
2,485 expectations**, formatting/lint/typecheck and GUI build. The build retained
the existing Vite deprecation and ONNX CJS import-meta warnings. These checks
include canonical speech and debugger repairs, not only the old worker baseline.

## Measurement and remaining native boundary

Root measured the whole-project source stamp at **4–17 ms on current data**.
This is a scaling concern, not evidence about earlier renderer freezes. This
review does not rewrite polling or attribute those freezes to the stamp.

Native registered snapshot/trajectory reads and assembled Radar/Trajectory
captures remain separate evidence gates. Root drives the native visual/audio
observations. Source merging and these fixtures do not mark the whole b50 plan
integrated or certify its unreturned renderers/assembly.
