# Trajectory timing: current data and executable repair boundary

Read-only research at source`9fa5d87`, Repomix
`6c782a4a-bf24-40bc-8ff1-4a7a7cab3083` (1793824414267). SQLite was opened read-only;
schema inspection preceded bounded project-scoped SELECTs. No historical rows changed.

## Current measurements

- 125 attempts:96accepted,13cancelled,13failed,2labelled running,1verifying.
  `runner_attempts` has reservation`started_at`, no lifecycle endpoint column.
- All658completed verification receipts have integer Unix-ms start/end and
  nonnegative duration. The four112examples in Root's timing diagnosis match.
- 39resumes across23attempts.20resumed attempts have a recorded stop older than
  the latest resume.11accepted,4failed,1cancelled attempts lack WORKER_STOPPED.
- All584execution-outcome progress facts lack structured timing endpoints.

For112, reservation1793790519537, later native start1793790533400,
success1793792598479, runtime acceptance1793792603366 and combined check
interval1793792603400–1793792607233 are **different boundaries**. An earlier
native execution1793790524519–1793790524533 also belongs to that attempt.
The later success row's recording time1793793236405 is not execution completion.
For127, stop1793818970972 precedes resumes1793819173786/1793820785713 and must
not close the resumed execution.

## Small repair increments

- **LZ130:** render existing ordered check endpoint pairs as proportional spans,
  exact selected milliseconds/provenance and truthful zero/missing/reversed cases.
  Existing fixed-marker code fails the proposed geometry and registered-DOM
  regressions. No controller, runtime or observability reader edits.
- **LZ131:** capture actual terminal lifecycle observations atomically; retain
  original reservation and prior episode history, reopen current end on resume;
  record genuine native timestamp provenance separately from local ordering time.
  Migration/read-only/replay/rollback behavior must preserve honest unknowns.
  Excludes observability files; later observability-to-panel consumer wiring must
  follow Root/Astra source coordination rather than overlapping performance edits.

Plan`96cc983c-f6a6-4ea5-8f1a-7a5e8c7f71a0` was authorized for native isolated
execution with exact`openai/gpt-6-luna/max` task routes. Existing runner reservations
remain authoritative; no predecessor is cancelled or replaced to free them.
Source/tests are not real Desktop delivery. Root provides actual observations
after coordinated activation, with no new OS permissions or announced-capture
build/restart interference. Check selection resetting on remount remains a UX
follow-up, not an additional acceptance condition.

Local authoring inference encountered interruption and then an explicit WebGPU
device-loss error while mapping an ONNX buffer. This is a concrete later failure,
not evidence that the earlier cache-owner failure had the same cause, and not a
semantic pass. Root forwarded it to Astra; no restart, feature/preference change,
profiler or lease takeover followed. Proposed behavior tests have not run yet.
