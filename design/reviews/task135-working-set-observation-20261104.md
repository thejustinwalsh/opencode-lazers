# LZ135 unchanged-recovery working-set review

The first draft passed recorder tests but retained only32 per-session recovery
memos. Actual reconstruction had122 terminal assignments and visits them in
round-robin order. Its project-wide revision fence also discarded reuse after
unrelated writes.

Root exercised the draft recorder with genuine disposable repository fixtures,
using terminal attempts and unchanged retained messages. No production data was
modified. At1793846899579–9623, calls to the durable append path per pass were:

| Terminal sessions | Cold pass | Second pass | Third pass |
| ----------------: | --------: | ----------: | ---------: |
|                 8 |        24 |          21 |          0 |
|                40 |       120 |         120 |        120 |

The40-session case demonstrates no projection reuse across the observed style of
workload. It does not by itself measure total CPU savings or allocation cost.
Probe: `/private/tmp/lazers-recorder-draft-working-set-probe-20261104.ts`.

Root sent the finding through Desktop. Architect attached durable guidance and
steered the same worker at1793847013512, preserving its original task/attempt/tree.
The worker acknowledged the correction and continued that assignment, planning a
122-session regression, unrelated-activity reuse and changed-fact freshness.
Correction and quiet native CPU benefit are not yet verified.

## Correction reprobe

The same Root fixture at1793847584547–4592 returned `[24,0,0]` for8 terminal
sessions and `[120,0,0]` for40. This repairs the reproduced round-robin reuse
failure. The worker subsequently committed335cd57 on top of3a85ecd and reported
66 passing recorder/native/reconstruction tests with624 assertions, plus format,
lint and typecheck. Its expanded test covers122 terminal sessions and unrelated
second-connection writes. No native CPU benefit or runtime acceptance follows
from these fixture results.
