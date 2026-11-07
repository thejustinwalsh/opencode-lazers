# Live dogfood follow-through — 2026-11-07

## Runtime and delivery

Native readback at Unix 1794064489043: original LZ-174 worker
`ses_5210fab90d3745959a4d269dbd6ab744` is active on OpenAI Luna Max. Main
Architect remains OpenAI Sol High. Original LZ-173 worker completed corrected
candidate `0b289721647eddafa8e5d9bba4f5ce2daf945811`; independent Luna source
review found no material findings. Its native acceptance/binding remains open.

LZ-174 corrects the reviewed task-disposition race and adds recovery-command
fence regressions, in its original attempt/tree. LZ-175 is queued at priority105
behind LZ-174 priority110. It supplies the missing immutable repaired-candidate
binding for retained verification. Original LZ-172 UI work remains held, not
discarded. See the three task-specific Nov7 review records for the precise gaps.

The native plan snapshot still has Tasks148/149 and architecture170/171 queued;
Radar/Trajectory160/161 are draft. Several previously accepted Models plans
await real connected UI acceptance. This is incomplete delivery, not a completed
roadmap. Runtime prerequisites/reservations determine actual dispatch eligibility;
priority alone does not prove a task could run now.

## Current performance observations

After canonical LZ-129 source activation, a 3-second event subscription at Unix
1794064517588 saw **27 observability events / 27 distinct complete identities**.
Every returned identity appeared once at one location. The earlier Nov6 sample
had 435 events /319 complete identities and five copies across five locations.
These are different active workloads, so this is observed absence of duplication
in this sample, not a controlled throughput comparison or proof for every branch.

A separate 12.039-second CPU window, Unix1794064566738–1794064578778, with the
Trajectory panel visible and the recovery worker active, measured:

| Process          |   PID | CPU seconds | Mean percent of one core |   RSS KiB |
| ---------------- | ----: | ----------: | -----------------------: | --------: |
| OpenCode service |  3219 |        5.06 |                   42.03% | 1,459,136 |
| Desktop renderer | 35091 |        1.76 |                   14.62% |   378,160 |
| GPU helper       | 35087 |        4.54 |                   37.71% |    69,552 |

Source: cumulative process CPU counters, existing temporary measurement helper;
raw window retained in `/private/tmp/lazers-panel-cpu-windows-20261104.jsonl`.
No controlled before/after, quiet-idle baseline, battery result or causal stack
attribution follows from this window. Residual CPU remains a live issue. Keep
the existing performance lane open; do not call LZ-129 whole-system performance
acceptance complete from publication deduplication alone.

## Inference recovery

Canonical `8975516` repairs process-scoped cache ownership. Native chat and d1
requests succeeded, followed by another successful chat request after fully
quitting/reopening Desktop with d1 loaded. Six switches and downloaded files
were preserved. Detailed regression and native outcomes are in
`inference-lease-lifecycle-20261104.md`. This does not establish renderer freeze
resolution or every LZ-165 navigation branch.

## Next observations

Review corrected LZ-174, integrate and activate through the native flow, then
recover original172 and qualify corrected173 using175. Exercise connected pricing
and approved narrow/wide Models interactions before recording acceptance. Check
Tasks148/149 eligibility and independent roadmap work through Architect rather
than treating Models holds as a global freeze. Capture attributable residual CPU
in the existing performance lane; keep source publication/navigation/scope
verification and CPU acceptance separate.
