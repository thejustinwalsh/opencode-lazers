# Tasks grouping and historical volume — 2026-11-04

## Observed failure

Root navigated Desktop from archived Main to the existing unarchived Architect
session `ses_e6e0e6239ffdtzIePMeJ1sHA4l`, then selected Tasks → Project. The task
list and selected LZ-132 detail loaded, but dependency/group rendering showed
“Execution links unavailable: [object Object]”. Read-only native snapshot RPC
reproduced `rpc.internal` at1793843271896. The service log identifies the actual
cause: `Observation scope is too large; narrow it`.

Read-only DB counts at1793843333291:107 project plans,11047 transitions,
128 attempts and667 verification checks. `loadProjectionSource` loads complete
history before rejecting more than10000 transitions. Tasks needs current plans,
nodes and dependency relationships, but currently requests the full historical
snapshot. The optional-read retry and observation invalidations repeatedly rerun
that failed read. Logs at01:49:57–01:50:05UTC show several failures per second;
this is not model execution or evidence of useful work.

Opening LZ-132's trajectory from the same unarchived scope also showed unavailable
data followed by “No tasks are associated with this scope.” That empty-state text
does not describe the database. Full historical readers remain a separate issue;
repairing Tasks topology alone does not prove their recovery.

The OS-only failing-Tasks window1793843436982–1793843449019 measured service
PID95968 at25.92% CPU, renderer54076 at8.97% and GPU process54072 at9.31%.
GPU-process CPU is not GPU utilization. Raw measurements remain in
`/private/tmp/lazers-panel-cpu-windows-20261104.jsonl`. Native worktree creation
at1793843561742 followed the window and did not overlap.
All six inference flags remained true and demand false at1793843470025–29.

## Integrated and observed repair

Astra's candidate b764c1d was reviewed and integrated as3f30c3c. The additive,
explicitly history-free topology RPC shares current-row loading/projection with
snapshot. It preserves current dependency relationships, project/session scope,
dependency-plan closure and list/version coherence. No historical arrays are
fabricated and no lifetime cap is increased. Existing full snapshot semantics
remain unchanged. The original LZ129 bounded Radar/history work remains retained
and separate; it is not accepted by this repair.

Canonical validation:51 tests/331 assertions across topology, observation reads,
native RPC authorization, task state and execution-list tests,14.16s. Bun
check/lint and changed-file formatting passed on the candidate. Canonical GUI
build and process-free smoke passed; existing ONNX CommonJS warnings remain.
Native registration380d0427 at1793843814864 confirms the same servicePID95968.
Actual topology RPC returned107 plans/126 nodes/15 dependencies/6 unplanned tasks
in16ms at1793843814881, with no history payload. Desktop showed plan groups and
selected LZ-132 details without the prior error.

The post-reload window1793843831657–1793843843684 measured30.52% service,
7.40% renderer and8.48% GPU-process CPU. A later settled window
1793843898556–1793843910591 measured26.59%/7.48%/8.56%. Service CPU did not
improve materially against25.92% before. This is a proven availability repair,
not proof of an overall CPU or battery fix.

## Additional proven no-op write repair

Existing diagnostics over1793843881149–1793843922732 counted eight native gets
and eight full context reads, with127 cached assignments (five active/122
terminal). The shared scheduler retained one process timer. Historical catch-up
remains required; no polling, late-result or context coverage was removed.

Astra's isolated fixture with200 retained tool messages produced401 facts.
Ten unchanged recoveries left facts and observation revision unchanged, but
advanced SQLite's sequence401→4411 and committed a database change. Every
existing fact attempted an ignored AUTOINCREMENT insert before reading its row.

Candidate35a3acc, integrated9bcf77f, now reads the durable key first under the
existing immediate transaction and inserts only if absent. Existing material
merge/update behavior is retained. Tests verify unchanged replay causes no
sequence/data-version/fact/revision change; another connection's changed evidence
remains visible; new facts still persist. Recorder/reconstruction suites pass
22 tests/340 assertions; Bun check, scoped lint/format and diff checks pass.
No live CPU reduction is claimed: the user reported the OpenAI reset and native
model work resumed before another quiet comparison could be made.

Remaining: full historical snapshot/Trajectory capacity and misleading empty
states, residual service/renderer CPU, compact renewal context and current-owner
navigation. No roadmap task acceptance follows from either performance patch.

Astra's integrated worktree was clean and source-identical to canonical. Native
non-forced worktree removal completed at1793844574283; registry inventory and
filesystem absence agree. Commits/captures remain; original worker trees remain.
