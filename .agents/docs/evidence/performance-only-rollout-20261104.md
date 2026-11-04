# Performance-only rollout: reported native observations

## Final integrated outcome — supersedes the quiet hold below

Root reports complete performance integration at
`8aed4ea4cf54b28ce8f46af04559c3bd1a93a6aa`; canonical Git confirms that HEAD.
Read [Astra's full measured account](../../../design/reviews/astra-performance-repair-20261104.md)
for exact observation windows, workload, source semantics and private artifacts.

- Same-PID warm service CPU **46.36→17.61%**, about62% lower in bounded quiet
  windows. This is not battery-life proof. Intermediate post-repair18.61% is a
  distinct window, not a contradictory final value.
- Exact outbox-query median **390.34→4.74ms** with all98returned rows deeply equal;
  live outbox sampled stacks **2,853→37**. These are not independent CPU shares.
- Permanent Radar query/privacy and both Radar/Trajectory event-directory filters
  remain integrated. Temporary JSC API/helper/tests were removed; no new permanent
  profiling endpoint is authorized by this evidence.
- Root's independent checks and final quality passed. All six inference flags true,
  Never unload unchanged, no explicit restart. Raw captures remain private under
  `/private/tmp`; Astra's clean fully merged tree was removed natively, force:false.

The quiet hold is **released** for nonoverlapping authoring and normal native
execution. Root still owns offline bootstrap lifecycle repair; do not edit or
activate79ceb78. Residual Git prerequisite/session/attempt work follows the existing
roadmap proportionally; prerequisite proof also gates finalization and must not
be skipped solely because no queued task is present.

## Earlier Radar rollout and reserved capture window

Root reports source integrated at merge `744d9a9` from Astra's `9edc37f`, then
focused event-location correction `472` cherry-picked as
`d2d31a3946009856dd4f23e92c70750bb4677798`. Canonical Git confirms these landing
commits; this evidence note does not independently reproduce native measurements.

Root independently reviewed query/privacy semantics with **33 tests / 364
assertions** and transport with **14 tests / 62 assertions**. GUI build and smoke
passed. No duplicate build or test run was started by Architect.

Actual same-scope native Radar reads reported by Root:

| Sample | Before ms | After ms |
| ------ | --------: | -------: |
| 1      |      1401 |     1534 |
| 2      |      1049 |     1086 |
| 3      |      1260 |      751 |

Both sides retained **9,638 edges / 1,908 routes**. Results are mixed; these samples
do not establish a uniform latency improvement or a battery fix. Root's quiet
12-second same-PID CPU report is retained verbatim because separators were absent
in the message: `service46.3646.37%, renderer.33.50%, GPU0.17%`. Do not silently
derive an exact CPU delta from that text. All six settings remained true; no
explicit restart was reported.

The quiet reservation continues for **Astra's bounded in-process idle-JSC profile**.
No new Architect dispatch, build, reload, activation, local GPU review or competing
measurement during capture. Bootstrap remains offline with its independent
guard-lifecycle blocker; performance landing does not clear it or release retained
effects/resources. Never unload remains unchanged.

Astra owns both landed Radar and Trajectory event-directory filters, separate from
LZ131 backend attempt timing. Preserve this ownership when reconciling held work.
