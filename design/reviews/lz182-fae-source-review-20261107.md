# Tasks scheduling candidate review

Candidate `fae0967` is committed and clean in the original worker checkout. Root read the exact final native result: **731 pass / zero failures / 9,264 assertions /49 files /230.76s**, following the earlier19failures. Automatic quality fixes/type checks and GUI build passed. Root created one native review checkout at `/private/tmp/lz182-review-fae0967` and composed current main without conflicts as `fed8d3f0149a0acc55af0e234206d835ec4742f7`; combined checks are running. Models/GPU source remain unchanged.

Root reran the original transient-proof reproduction and no-failure control against the updated worker implementation. Both pass: a one-time Git I/O failure now yields unknown, and the next fresh read correctly finds the child without DB/HEAD changes. The successful control reuses its projection. No production DB mutation occurred.

## Parallel fallback regression

The new `buildScheduledGroups` in `src/tasks/execution-list.ts` preserves plan groups from scheduling data when legacy topology is unavailable, but constructs flat node rows without the existing expandable fork representation. This is the relevant fallback under the actual previously observed topology failures and concurrent watermark changes.

Root exercised the real `buildExecutionList` with the existing canonical four-task diamond shape: root → left/right → shared join. With topology, it returns root and join on the root lane, one fork and two branches. With equivalent complete scheduling data and no topology, it returns four flat rows, zero forks. The preservation assertion fails. Temporary reproduction: `/private/tmp/lz182-fallback-parallel-observation.test.ts`; it only calls the actual pure production builder with the existing fixture shape, no mock implementation, DB or network.

Preserve the already requested sequential/parallel presentation on the scheduling fallback as well as the topology path. Reuse existing relationship/fork logic rather than adding a second graph algorithm or changing dispatch. The same LZ-182 worker should correct this consumer behavior and cover the diamond alongside the existing chain/filtered context behavior. No new task, pixel-layout rule or runtime redesign is implied. Native connected acceptance remains pending; Root owns the current review checkout and activation.
