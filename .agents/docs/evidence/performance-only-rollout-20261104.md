# Performance-only rollout: reported native observations

Root reports source integrated at merge `744d9a9` from Astra's `9edc37f`, then
focused event-location correction `472` cherry-picked as
`d2d31a3946009856dd4f23e92c70750bb4677798`. Canonical Git confirms these landing
commits; this evidence note does not independently reproduce native measurements.

Root independently reviewed query/privacy semantics with **33 tests / 364
assertions** and transport with **14 tests / 62 assertions**. GUI build and smoke
passed. No duplicate build or test run was started by Architect.

Actual same-scope native Radar reads reported by Root:

| Sample | Before ms | After ms |
| --- | ---: | ---: |
| 1 | 1401 | 1534 |
| 2 | 1049 | 1086 |
| 3 | 1260 | 751 |

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
