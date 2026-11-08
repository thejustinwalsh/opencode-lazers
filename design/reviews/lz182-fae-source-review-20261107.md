# Tasks scheduling candidate review

Candidate `fae0967` is committed and clean in the original worker checkout. Root read the exact final native result: **731 pass / zero failures / 9,264 assertions /49 files /230.76s**, following the earlier19failures. Automatic quality fixes/type checks and GUI build passed. Root created one native review checkout at `/private/tmp/lz182-review-fae0967` and composed current main without conflicts as `fed8d3f0149a0acc55af0e234206d835ec4742f7`; combined checks are running. Models/GPU source remain unchanged.

Root reran the original transient-proof reproduction and no-failure control against the updated worker implementation. Both pass: a one-time Git I/O failure now yields unknown, and the next fresh read correctly finds the child without DB/HEAD changes. The successful control reuses its projection. No production DB mutation occurred.

## Parallel fallback regression

The new `buildScheduledGroups` in `src/tasks/execution-list.ts` preserves plan groups from scheduling data when legacy topology is unavailable, but constructs flat node rows without the existing expandable fork representation. This is the relevant fallback under the actual previously observed topology failures and concurrent watermark changes.

Root exercised the real `buildExecutionList` with the existing canonical four-task diamond shape: root → left/right → shared join. With topology, it returns root and join on the root lane, one fork and two branches. With equivalent complete scheduling data and no topology, it returns four flat rows, zero forks. The preservation assertion fails. Temporary reproduction: `/private/tmp/lz182-fallback-parallel-observation.test.ts`; it only calls the actual pure production builder with the existing fixture shape, no mock implementation, DB or network.

Preserve the already requested sequential/parallel presentation on the scheduling fallback as well as the topology path. Reuse existing relationship/fork logic rather than adding a second graph algorithm or changing dispatch. The same LZ-182 worker should correct this consumer behavior and cover the diamond alongside the existing chain/filtered context behavior. No new task, pixel-layout rule or runtime redesign is implied. Native connected acceptance remains pending; Root owns the current review checkout and activation.

## Same-worker correction and composition — 2026-11-08

Original retained worker committed `6dbae67` with a clean checkout. Its actual
broad native verification passed735 tests /9,293 assertions across49 files in
277.19s. Automatic formatting/lint/typecheck and GUI build also passed. The repair
reuses the existing relationship/fork composer for scheduling-only lists and
scopes returned Session data after project-wide arbitration, including associated
prerequisite plans. No replacement worker or microtask was created for this repair.

Root merged that commit into the recovered durable native checkout
`/Users/tjw/Documents/ChatGPT/opencode-lazers.worktrees/lz182-review-recovered`.
Composition HEAD is `c0cfd3707b15f441f9152aeee46d326a85ba041f`. Actual composition
checks pass: `bun run verify`, `bun run build:gui`,99 integration tests /974
assertions across19 files in19.05s. Logs are under `.cache/review/6dbae-*` there.

Read-only real-DB observations at Unix1794154567224–1794154567379 used the explicit
read-only store opener and candidate source; no migrations or production writes:
project scope149 plans /175 nodes /11 active reservations,113.73ms;
current Architect Session103 plans /117 nodes /10 active reservations,85.32ms;
unassociated Session0 plans/nodes/reservations,69.18ms. First pages were capped at
100 plans; coverage counts describe the full captured view. These are useful
scoping/read observations, not connected panel or final scheduler acceptance.

Connected narrow/wide Tasks interaction and native Terra visual review remain
pending macOS unlock. Do not mark the task accepted from source tests alone.
