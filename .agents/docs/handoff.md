# Current dogfood handoff

Updated 2026-11-06T04:40:00Z. The goal remains active: drive OpenCode Desktop until the
active roadmap is implemented, verified, integrated and cleaned; then present
an observation-based improvement plan. Preserve the full backlog.

## Operating decisions

- Drive model prompts through Desktop CUA. Read-only SDK/SQLite inspection is
  allowed; no production SQL mutations or CLI model sessions.
- Architect: OpenAI `gpt-6.1-sol/high`. Implementors and research: OpenAI
  `gpt-6-luna/max`. Reuse native Tera High for screenshot review.
- Root reviews/integrates and fixes blockers. Native runtime owns dispatch,
  task state, attempts, workspaces and cleanup. Use native worktree APIs.
- Evidence means passing checks and observed product behavior. No file hashes
  as evidence, no proof-only model turns, forced acceptance or arbitrary model
  budgets. Keep `lz-verify-task`, schemas and System One review.
- Keep all six inference flags enabled and unload Never. Do not disable models
  or alter the inference stack. Pricing uses current market-source data.
- Priority: Models, Tasks/Trajectory, then Radar; retained recovery can proceed
  independently. Radar is a live agent/system monitor, not another task list.

## Landed source and checks

Main received reviewed merge `717af358649d85779b04089aa4923a5985639c00`:

- LZ-147 activity/state filters: worker `f5699708`, review merge `7461df7`.
- LZ-151 market scenarios: `c800e46` plus provider-identity repair `bff6013`.
- `7d8a198`: Architect 758→663 words; live persona routing documented;
  queryable state/history excluded from continuity; optional pricing lesson.
- `727274d`: repaired brittle transport-test padding without changing the
  7,026-character payload, 14 checks or production validation.

Combined tests: **1,357 pass / 15,068 assertions / 154 files**, plus native Bun
format/lint/types/diff and GUI build. Main's GUI bundle was rebuilt successfully.
The earlier baseline had one brittle fixture failure (fixed) and two sandbox
process-observation failures (both passed with process-observation permission).
No broad battery/idle-performance qualification is claimed.

Evidence: [dogfood capture](evidence/dogfood-20261106/observations.json),
[combined tests](evidence/dogfood-20261106/combined-tests.log),
[completed-plan audit](evidence/dogfood-20261106/completed-plan-audit.json).
The audit covers 39 integrated plans / 47 tasks / 123 passing task-check receipts;
all six tasks requiring human assertions have matching records. This verifies
records and integration ancestry, not every feature's current live behavior.

## Immediate coordination

Main Architect: `ses_e568438ebffeaoFbF9nBb942XM` (Sol High).
Service last observed PID71027; revalidate actual service registration/state.
151 was reconciled after activation; 152 and 153 are now running concurrently.
Root fixed a reproduced Tasks row-removal crash in `7f5133b` and activated its
GUI bundle. Reactive identity + mounted panel tests passed; broader Tasks suite
34 tests / 152 assertions passed, with lint/types/build. Native Tasks selection,
Start153 and Queued→Running filtering survived without blanking.
See `design/reviews/tasks-keyed-row-crash-20261106.md`.
Review batch HEAD `231805d29313ced9b3e73607a78cdacadb302d2d` in
`/private/tmp/lz147-compact-review` contains147compact,3e09menu test fix,
153c8530aa and15259cf8f8. Full independent regression1364tests/15208assertions
passed (250.53s); fmt/lint/types/diff and combined GUI build pass. Logs in
`evidence/dogfood-20261106/models-tasks-batch-{tests,build}.log`.
147/152/153 workers are inactive/succeeded.138dependency correction remains
active, now running its declared suite after focused15tests/169assertions pass.
Use a completed-worker activation boundary; do not interrupt138's current execution.

LZ-151: task `77155457-70ca-424b-b5cf-0598244fe738`, plan
`9f7c80ad-a799-443e-8a40-f294e15f9d50`, attempt
`8bc20618-e418-4edc-81b2-20a085edd9f8`, worker
`ses_ba3fb8caf0734f65b0d68cc6db11e0b9`. Its genuine repair completed inactive,
clean at `bff60132ade3bd5bfafdb92886d32392dae6eaf3`, empty native controls,
confirmed zero-background terminal for tagged input
`msg_lz151_substantive_market_identity_repair_20261106_v1`.
Metadata requestID: `lz151-substantive-market-identity-repair-20261106-v1`.
Architect reconciled the genuine tagged input and accepted151, allowing152.
Do not rewrite the old untagged notice or create a turn for proof.

LZ-152: `34de5cf6-afdd-41c0-82f5-6ea8356fba2e`, UI scenario presentation,
same plan, depends on151. Running attempt
`6c5b0677-3a6e-4956-ad23-cb8e3f54f70c`, worker
`ses_06ae893559b2433d88f788baaf2e966c`, OpenAI LunaMax in its own native tree.
Current edits are comparison-panel.tsx/css; review on completion.

LZ-153: `5d4548ce-e5c0-4f7a-b3d1-3614e973e3f5`, plan
`a27556ef-015b-4084-bc5a-ed12dea9329e`, running / priority100 / Systems / LunaMax.
Worker now inactive/succeeded and clean at `c8530aa0612403e4eb7de9d136183b55660a7b22`.
Root merged it into `/private/tmp/lz147-compact-review`; independent Models183tests/
2152assertions passed there. Actual read-only project capture succeeded over16315
facts/155tasks,5.3s. Native full producer/UI still unqualified. See
`design/reviews/models-history-read-review-20261106.md`.
Root clicked Start in Desktop; native attempt
`4e7fb2d5-e54f-4f9c-a153-58a38aa87dc2`, worker
`ses_bb1ddbbe1ca84e498de9597792c602f6`, separate native tree.
Trajectory navigation works and shows actual activity and usage.
Growing history currently exceeds the producer's15,000-fact limit and creates
inconsistent unavailable snapshot IDs. The real Models panel still needs this
repair. Architect prepared baseline ec00abd; Root started153 through Tasks. It has no whole-plan prerequisite:
waiting for151+152 combined acceptance would create a cycle. Its producer scope
and152's UI scope permit native isolated parallel work.

LZ-154: `19d5deff-69e2-4780-be58-83594a4d1969`, plan
`c8fdd538-c1eb-4ca5-8414-e74f0f1aabbf`, draft / Systems / LunaMax, behind
151/152 and Tasks148/149 plan `7d463854-6ef1-4206-beb8-5a9b8d4e6692`.
Expose normal same-worker steering using native messaging and automatic input
association. Existing136 reconciles external tagged input but does not send it.
Clarification attached: communication to active/waiting work does not require
empty controls or zero background. Preserve those facts; later verification
still requires actual successful completion and current background evidence.

## Tasks visual follow-through

LZ-147 task `c1e32cb7-6c7b-427c-927c-97f8332a8165`, plan
`b4736219-82ba-44f2-b319-f26a5095d0a2`, original attempt
`3b4bad86-2aad-44d2-a17a-fb98707dcd6e`, worker
`ses_f4eb00b5f274438a8aba61a09782395f`.
Source landed; old formal native hold remains. Desktop Running filter excludes
queued tasks and distinguishes recorded state from observed foreground activity.
The visual pass is too noisy: Recorded/Foreground/nonterminal labels and long
hold messages fill the list. Do not claim visual acceptance.

Native Tera High reviewer `ses_e52a5ae04ffeObat8Bt6imz4ci` compared
`design/task-panel/tasks-focus-v2.png` with
`.agents/docs/evidence/dogfood-20261106/147-running-desktop.png`.
Tera completed review; visual acceptance remains open. Architect sent a genuine
tagged correction to the original147 worker, now inactive/succeeded at
`ebdf41a044f761b78308f70eefedf24f2f113fc3`. Root source-reviewed the correction
in native `/private/tmp/lz147-compact-review`, combined with keyed fix/current main.
69 tests passed;6 menu tests passed after generating their required Radar build
artifact. Root then fixed that unrelated test prerequisite in review commit
`3e09c37`: real GUI/Vite compiler, configFile:false; all6 tests passed with the
artifact temporarily absent, plus lint/types. Include this test fix at integration. Mounted UI/keyed tests, fmt/lint/types/build passed. Keep the clean
review tree for next combined integration; no canonical activation yet. Compact title-first rows; full hold reasons in
selected inspector; preserve truthful foreground states and149 scope. Root owns
keyed.ts separately. Use screenshots, not mockup-to-components.

## Retained recovery

LZ-138 task `0d18d8c6-959f-4b0f-9f37-bb79c5aee0c4`, plan
`e48290a6-a871-42a2-94f1-c88f700c0d11`, attempt
`87c14979-917d-4495-9fa6-90bb3aaeff17`, worker
`ses_28780d1d92544da880d3db3496c8a29d` is now inactive and clean at
`d37858f` (resolve full commit from Git). Query the current owner; do not revive
archived predecessor coordinators. Root answered owner134's missing-plan
question, caught historical142-journal drift, and Main directly steered the same
worker. Actual source now removes the fixed test-command Map and root/candidate
manifest equality. The actual147 quality/build command is recognized.

Worker reports548 LZ138 tests,128 observability tests,154 models tests, quality,
and a real isolated full quality/build execution with an unchanged committed
candidate and resource witness. Its only broad-suite failure is the transport
fixture Root fixed in727274d. See [worker report](evidence/dogfood-20261106/138-worker-report.txt).
Full independent review, integration and native retained-task walkthrough are
still required. Luna reviewer `ses_e522ffd49ffeenRSBj8xvTAxMB` completed: NOT READY.
Candidate dependency lockfiles still must equal root installed state; fixture only
adds already-installed package without lockfile. Root confirmed isolation.ts228-255
and sent the defect to Architect; original138 worker is active on the genuine correction.
See `design/reviews/lz138-candidate-dependencies-review-20261106.md`.
Review tests14/156assertions plus quality/build passed; no durable native receipts
proved. Do not integrate d378 as full candidate-dependency support.
Do not accept based only on the binder or fixture tests.

## Models UI source review

152 initial committed candidate `26a0d882488e2615703e8b83bb58bd79733eea85`
passes worker184tests/2794assertions and quality/build, but Root rejected default
presentation: many caveat/metadata paragraphs above collapsed evidence contradict
the approved compact mockup. Architect steered the same152worker, now inactive/succeeded and clean at
`59cf8f8d23c027c0cb0b8c4e7fe8a72bfafee43c`. Worker184tests/2816assertions and
quality/build pass. Root source review passes and merged it into review batch;
Main natively reconciled its genuine correction and reports accepted152. Keep summary price/endpoint/essential uncertainty visible,
detailed tier/retry/cache/source information under collapsed Evidence & assumptions.
No data-policy expansion. Wait for corrected source before visual acceptance.

## Trajectory pricing follow-up

Architect submitted LZ-155 task `c23ffca3-fe8d-4102-afe6-3ee6ebf12f0c`, plan
`b2d491ae-b125-485e-8637-796ae194447e`: draft, Systems/LunaMax, after Models151/152
plan and153plan. It connects existing102 valuation to authorized trajectory tool/
panel consumers, preserving partial/unknown usage and current cached source provenance.
No new price arithmetic or subscription charges. It has not run.

## Newly observed pricing connection gap

Root opened153 trajectory: actual calls and token totals render, but API-equivalent
cost remains unknown. `src/trajectory/accounting.ts` hardcodes
marketEquivalentCostUSD null/unknown. Root asked Architect through Desktop to
check102 and related work, then reuse/task the missing current-market valuation
connection after active Models work. Preserve true missing coverage and retries;
no subscription pricing. This is not a worker scope extension.

## Other backlog and cleanup

Keep88 stale observation holds →148 scheduling eligibility →149 compact task
ordering/grouping,139 historical trajectories,131 observed timestamps,128/110
GPU ownership/recovery, Radar33/34 and129 source correction, proactive recovery,
handoff/live verification (including two real correction/reprobe runs), audio,
model metrics and packaging/install/upgrade/cross-machine verification in scope.
Use runtime records and [roadmap](roadmap-execution.md); the prior detailed
[handoff](handoff-before-20261106-activation.md) is historical context only.

Root removed `/private/tmp/lz147-integration-review` through OpenCode's native
non-forced worktree API after the batch landed; physical absence was confirmed.
Native metadata remains at `/private/tmp/lz147-root-review-worktree.json`.
Do not delete retained worker trees or resources to clear a state flag.
