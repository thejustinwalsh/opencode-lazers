# Active dogfood performance observation

This is an active-work observation, not an idle benchmark or a performance fix.

At 2026-11-06 04:10 UTC, native process observation found service PID 71027 at 104.2% CPU, renderer 43368 at 26.8%, GPU process 43313 at 17.6%. A second bounded observation found 102.2%, 20.5%, 12.9% respectively. Several native model sessions and tool/trajectory recording were active. The prior 2,000% spike was not present in these observations; these samples do not establish sustained battery or idle performance.

A three-second native sample of PID 71027 is retained in `evidence/opencode-active-service-sample-20261106.txt.gz`. JavaScript frames are unsymbolicated. SQLite schema loading, statement preparation and execution appear in sampled stacks, but this does not identify the responsible JS caller or prove a connection-lifecycle defect. No speculative source fix, restart or inference-setting change followed this sample.

Follow-up qualification needs a JS-attributed service profile and matched active/idle windows with source/trajectory workload stated. Preserve current workers and existing priority while collecting it; do not treat this observation as completion of the performance roadmap.
