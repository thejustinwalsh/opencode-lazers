# Current dogfood handoff

Updated 2026-11-06T05:27:15.449713+00:00. Goal remains active: drive OpenCode Desktop until the full
active roadmap is implemented, verified, integrated and cleaned, then present
an observation-based improvement plan. The scope is not limited to Models/Tasks.

## Operating decisions

- Model prompts through Desktop CUA; read-only SDK/SQLite inspection is allowed.
  No production SQL writes or CLI model sessions.
- Architect: OpenAI gpt-6.1-sol/high. Implementors and research: OpenAI
  gpt-6-luna/max. Reuse native Tera High for screenshots; no mockup-to-components.
- Root reviews/integrates and fixes blockers. Runtime owns task state/dispatch,
  attempts and cleanup. Use native worktree APIs. Preserve active workers.
- Evidence is tests and observed behavior, not file hashes. Keep schemas,
  lz-verify-task self-review and advisory System One. No arbitrary model budgets.
- Keep all six inference flags enabled and unload Never. Do not disable GPU/models.
- Current priority: Models, Tasks/Trajectory, Radar; retained recovery can proceed
  independently. Radar monitors actual agents/models/tools/files/messages/health.
- One reusable plugin; native SDK/adapters, no custom daemons. Portless before
  listening project servers. Native one-shot tests and supported app lifecycle
  follow their documented flows.

## Landed and activated

Canonical code is at4319bde2a0594ca81ac5dd49c9e0ec3417e617cf; later commits are
retained documentation/evidence. It includes147 compact rows (ebdf41a),153 large
history reads (c8530aa),152 scenario UI + compact evidence (26a0d88/59cf8f8),
Root keyed-row crash fix7f5133b and clean-checkout menu-test fix3e09c37.

Independent combined verification:1364tests/15208assertions/154files,250.53s;
fmt/lint/types/diff and GUI build/bundle evaluation pass. Logs:
`evidence/dogfood-20261106/models-tasks-batch-tests.log` and corresponding build log.
GUI rebuilt on canonical source. Actual native RPC and UI reads confirm activation;
no service restart was needed. Service last observed PID71027; revalidate.

LZ-153 plan a27556ef-015b-4084-bc5a-ed12dea9329e is INTEGRATED v12 atc8530aa.
Task5d4548ce-e5c0-4f7a-b3d1-3614e973e3f5; original worker
ses_bb1ddbbe1ca84e498de9597792c602f6. Native cleanup removed its tree; physical
absence confirmed. Root observed actual project capture over16315facts/155tasks,
coherent authenticated overview/rows/configurations, connected Refresh and a fresh
close/reopen from the extra-panel list. Three rows/scenarios render, with no old
15000-fact failure. Evidence & assumptions starts collapsed and expands/collapses
with real rates, categories, retries and scoped caching provenance.

Native context evidence and screenshots:
`evidence/dogfood-20261106/models-native-activated-contexts.json`,
`models-live-activated.png`, `tasks-compact-live-activated.png`.
Reader capture took5.3s; responsiveness remains a follow-up concern, not a reason
to restore arbitrary data ceilings. See models-history-read-review-20261106.md.

Root review tree /private/tmp/lz147-compact-review was natively removed after
landing; physical absence confirmed. Do not reuse it. Its metadata JSON in/tmp is
historical. Other Root review/adoption/performance trees were removed earlier.

## Active native coordination

Main Architect: ses_e568438ebffeaoFbF9nBb942XM (Sol High).
Use current runtime versions/records rather than copying stale versions into calls.

147: task c1e32cb7-6c7b-427c-927c-97f8332a8165; plan
b4736219-82ba-44f2-b319-f26a5095d0a2; attempt
3b4bad86-2aad-44d2-a17a-fb98707dcd6e; SAME original worker
ses_f4eb00b5f274438a8aba61a09782395f is ACTIVE on a genuine inspector correction.
Tera found diagnostics before objective/Done when. Put identity/status, objective
and visible Done when first; full hold/lifecycle/raw-worker detail is progressive.
Keep truthful activity/unknowns and filters. Repeated plan headers/density belongs
to existing149; do not duplicate that grouping work. Original native idle mismatch
history remains; do not manufacture proof. Old compact source is already landed.

138: task0d18d8c6-959f-4b0f-9f37-bb79c5aee0c4; plan
e48290a6-a871-42a2-94f1-c88f700c0d11; attempt
87c14979-917d-4495-9fa6-90bb3aaeff17; SAME worker
ses_28780d1d92544da880d3db3496c8a29d is ACTIVE on async setup/partial-resource repair.
It checkpointed fee2a89 after fixing candidate-lock dependency support;549 task
suite tests and isolated candidate quality/build passed. Old d378 review rejected
root lock equality/cloned root installation; fee2 addresses that issue.
Root then found synchronous120s execFileSync installation on service thread and
possible unregistered partial resources after setup failure. Advice8 records the
findings. Worker ended before Root activation, then Architect resumed it for a
genuine async native/existing-executor setup and owned failure/cancellation
reconciliation. No new worker/daemon. Source still unapproved; independent review,
integration and actual native retained-verification walkthrough remain required.
Reuse Luna reviewer ses_e522ffd49ffeenRSBj8xvTAxMB after the corrected commit.

Progress note checkpoint initially failed1200-character validation, then succeeded
when shortened. Retain this actual cap/retry finding for follow-up; do not confuse
it with removed320-character advice cap (b0548ba, regression4tests/59assertions).

## Models pricing and visual acceptance

151/152 plan9f7c80ad-a799-443e-8a40-f294e15f9d50 remains blocked on
connected-live-pricing-review:human.151 task77155457-70ca-424b-b5cf-0598244fe738
sourcebff6013 is landed.152 task34de5cf6-afdd-41c0-82f5-6ea8356fba2e,
attempt6c5b0677-3a6e-4956-ad23-cb8e3f54f70c, worker
ses_06ae893559b2433d88f788baaf2e966c is inactive/succeeded at59cf8f8;
its genuine correction was natively reconciled and task accepted. Source landed.

Current actual UI: all3 canonical rows show Unknown cost and no graph points.
Kimi endpoint scenario shows a scoped known-usage amount. These are different
valuations. Native context says OpenRouter configured, no applicable cached quote,
price index unavailable/pins empty. Do not speculate or invent plot data.
Existing native Luna researcher ses_e5337592effeefMspoKIlcYx4F is ACTIVE diagnosing
actual retained sources/valuation. Main will task the smallest grounded correction.

Tera High ses_e52a5ae04ffeObat8Bt6imz4ci completed actual screenshot review:
Tasks visual acceptance open; Models unavailable-state layout acceptable, full
comparison unaccepted. Report design/reviews/activated-panels-review-20261106.md.
Models scenario-card dominance and full wide/interaction/chart evidence remain
open. Avoid another cosmetic pass until actual price diagnosis resolves the gap.
Approved references: design/task-panel/tasks-focus-v2.png and
design/models-panel/models-approved.png. Use actual screenshots and Tera.

155: taskc23ffca3-fe8d-4102-afe6-3ee6ebf12f0c; plan
b2d491ae-b125-485e-8637-796ae194447e; DRAFT Systems/LunaMax, after151/152 and153
plans. Reuse102 valuation to connect trajectory tool/panel current market values,
with partial/unknown coverage, retries and cached-source provenance. No subscription
charges/new price arithmetic.153 prerequisite is now integrated;151/152 is not.

154: task19d5deff-69e2-4780-be58-83594a4d1969; plan
c8fdd538-c1eb-4ca5-8414-e74f0f1aabbf; draft Systems/LunaMax, after Models and
Tasks148/149 plan7d463854-6ef1-4206-beb8-5a9b8d4e6692. Normal same-worker native
steering/control should automatically associate input through verification; existing
136 aliases external tagged messages but does not send them. Communication itself
does not require zero background/empty controls; preserve current facts and later
verify actual completed work. No extra admission fences or invented stopgaps.

## Full backlog and limits

Keep88 transient observation holds→148 eligibility/order→149 compact task grouping,
139 historical trajectories,131 observed timestamps,128/110 GPU leases/recovery,
Radar33/34 and129 source correction, audio, model metrics/projections/persona
selection, packaging/install/upgrade/cross-machine work. Preserve proactive worker
recovery, structured handoffs and live product verification contracts, including
two actual implementer correction/reprobe walkthroughs. They are not proven by
unit tests or delivered notifications. Use README contracts, design briefs and
roadmap-execution.md; historical handoffs are context, not current instructions.

Completed-plan audit retained39integrated plans/47tasks/123passing task-check
receipts and matching human records for6required tasks. It proves records and
ancestry, not every current feature. Full mission/release completion is unproven.
Active-performance sample found service~100%CPU during parallel work, renderer
~20–27%, GPU process~13–18%; not an idle/battery qualification. No repeat2000% spike
in those samples. Source profile is unsymbolicated; no speculative attribution.
See design/reviews/active-dogfood-performance-20261106.md and retained native sample.

## Latest follow-through

147 inspector candidate14e8928 is committed. Root found its Waiting on references
were hidden inside Activity and holds, contrary to the user request. Main resumed
the original3b4bad86 worker for a narrow visible-links regression/fix. Preserve the
objective-first hierarchy. A separate failed147attempt59b56192-a6e3-4419-b802-df2ee7ed2e53
retains50cc2f2dcb4b9a83389f6bead072dbfafe80cf3f (child of14e): terminal lifecycle /
Completed tasks must not be Waiting because a plan has a hold. Main has native
Luna reviewer ses_e50a3b4ccffesHNeu80o108Z04 reviewing that fixed source. Root must
combine both useful changes in the next integration; do not delete failed work or
assume original3b is the latest runtime attempt. Native records are authoritative.

Pricing researcher completed the actual diagnosis: exact identity matches exist.
Kimi/Qwen whole-model OpenRouter quotes lack a cache-write rate despite positive
observed writes. Luna's two published prompt tiers have no captured selector.
Current exact unknowns are therefore expected under old contracts; they do not
complete the requested estimation UI. Root asked Architect to deliver clearly
labelled current-market reference estimates/ranges and partial coverage, preserving
exact accounting and genuine missing rates. In a native interview Root chose actual
observed cohorts first, including failed/retry effort per accepted task, labelled
for differing task mixes; no invented shared-workload frontier. Main is planning
that missing feature without interrupting138/147.

Root also asked Main to verify source semantics against pinned API/source:
OpenCode fallback means accessible published native model/catalog market data,
not subscription/session charges or requiring an unrelated execution-provider
login. Explicit source settings and true missing data remain. Research before
carrying the old connection gate into the new estimation path.
