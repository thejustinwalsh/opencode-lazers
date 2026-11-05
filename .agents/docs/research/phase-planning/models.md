# Phase 2: Models and persona routing — research and design

Research and reviewed product direction; implementation remains separate from this note. Sources checked 2026-11-01. Existing `.agents/docs/implementor-profiles.md` and its four `research/implementors/` notes are the starting evidence, not model rankings. The original brief and README prioritize completed, accepted work per dollar and hour; README explicitly requires measured usage, no invented budgets, and native host authority.

## Implementation reconciliation — 2026-11-05

Native Luna Max research `ses_e54c7ba62ffehWyvxhFebjVUsz` checked current source
and task records:

- Reuse the current mapping schema/store/resolver and accepted LZ67 settings
  authority. Cancelled LZ64 is not an acceptance claim; superseded LZ68's rejected
  editor should not be revived.
- Add editing to the existing comparison panel's Assignments tab: compact persona
  rows and one selected editor, using existing `Models.configure`. The current
  transport only reads settings. Reuse LZ108's panel; no second registration.
- Wire accepted/integrated LZ94 `resolveDispatchRoute` into real runtime dispatch
  and retain its decision in attempt policy. Explicit plan choice wins over the
  task/project/shared mapping, then native implementor fallback. Keep earlier
  attempts immutable; catalog absence does not prohibit an explicit route.
- `startTask()` currently copies `host.workerModel()` into `PlanInput.workerModel`,
  which `run` treats as explicit. Preserve deliberate override versus inherited
  fallback; calling the helper alone is insufficient.
- These are two linked increments, separate from126→122's decision producer.
  Existing missing-RPC and native narrow/wide/Tera gates remain open. Editor
  read/write tests and actual native readback, plus real runtime dispatch tests,
  must demonstrate behavior rather than stored settings alone.

Research performed no edits, tests, model inference or worker changes. These are
source findings for tasking, not delivered capabilities.

## Decisions and current gap

- A persona is a model-independent capability/guidance overlay; task class describes the work and its acceptance surface; provider/model/native variant is a route. These are separate dimensions. Existing overlays are UI, Systems, and Small task/refactoring. A design-heavy role could be a fourth persona only if its execution guidance and acceptance differ materially from UI; retain it as a user decision, not an implied requirement. Task class should be explicit and revisable with provenance rather than inferred permanently from persona.
- Current `PlanInput.nodes[].persona` is optional; a plan has one optional `workerModel`. Runtime resolves that or the native implementor selection into plan policy; attempts carry policy JSON and host creates a native `lazers-implementor` session. Thus per-persona routes and mandatory persona on new tasks require actual contract/runtime changes; the present catalog and optional overlay do not already provide them. Preserve legacy records as unassigned rather than inventing classifications. Ensure direct task submission and all plan creation paths honor the new invariant, with compatibility/migration explicitly specified.
- Versioned user-controlled binding: persona ID -> exact native providerID/model ID/optional variant. Use live OpenCode options and native selection semantics, permit exact explicit values even when catalog data is absent, and report native failures; no whitelist, silent substitute, or generated budget. User decision: shared defaults with project/task overrides; resolve the live hierarchical mapping when dispatching each attempt. At dispatch record the winning mapping layer and freeze resolved persona/overlay version, binding revision, route and route source in each immutable attempt policy transactionally before native session creation; retries use an explicitly recorded fresh snapshot, never rewrite prior attempts. Preserve configured route and observed native session route separately, including mismatch/unknown. Mapping changes affect waiting work at dispatch, not the task persona or running attempt. Running sessions retain their snapshots.
- Existing native `ctx.model.list` supplies route IDs, model metadata, context limits, cost tiers, variants and timestamp through `nativeWorkerOptions`; `ctx.agent.get` reads configured implementor. It is advisory and project-sensitive. OpenCode `/models` selection is session-specific; agent configuration can select its own model. Do not assume native session selection writes a persistent persona binding, or mutate host defaults. Use plugin-owned preferences with explicit selection and show native configured implementor as a distinct option/source. Investigate pinned V2 APIs and Desktop integration at implementation time.

## Provider metrics ingestion — documented contracts

- OpenRouter `GET /api/v1/models` supports `sort=coding-high-to-low`, `agentic-high-to-low`, `intelligence-high-to-low` (Artificial Analysis indices), `design-arena-elo-high-to-low` (best Elo across arenas), and `throughput-high-to-low` / `latency-low-to-high` (recent median performance); unscored models sort last. It also documents min/max index and tool-success-rate filters; that rate means requests ending in a `tool_calls` finish reason, not verified tool correctness. Sort order is provider-derived ordering; do not fabricate numeric benchmark or throughput fields from a sorted list. Catalog response documents IDs/canonical slug, architecture, context and pricing; validate the current response schema and units at implementation time. [Models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).
- OpenRouter `GET /api/v1/benchmarks` **does require any valid OpenRouter API key**, according to current documentation, though no inference call is needed. Pull it when the user has configured authorized access; credentials were not used for this research. It documents sources `artificial-analysis`, `design-arena`, `openrouter`; task types `coding`, `intelligence`, `agentic`, `search`; Design Arena arenas `models`, `builders`, `agents` and categories including `codecategories`, `uicomponent`, and `dataviz`. Documented examples include `model_permaslug`, Artificial Analysis `coding_index`, `agentic_index`, `intelligence_index`, and metadata `as_of`, `citation`, `source_url`, `version`; OpenRouter example provides `benchmark_type`, `accuracy`, `accuracy_stddev`, `avg_cost_per_task`, `total_tasks`, `last_run_timestamp`. Source-specific result shapes differ; preserve fields only when returned. Docs describe OpenRouter tau-bench, GPQA and search evaluations, not a promise of every model or benchmark. Limits are documented as 30 requests/min/key and 500/day/account. Handle 401, 429, 500, stale snapshots and missing model matches visibly. [Benchmarks API](https://openrouter.ai/docs/api/api-reference/benchmarks/list-benchmarks).
- OpenRouter documents `GET /api/v1/models/:author/:slug/endpoints` for per-model endpoints; its support notes model pages show latency/throughput by provider. The models sort contract establishes a relative performance ordering, not that numeric latency/throughput is present in each model response. Validate the endpoint response before specifying numeric telemetry. [Endpoints API](https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints), [support](https://openrouter.ai/support).
- Persist retrieved source data and timestamp distinctly from **LAZERS-observed** attempt measures and **projected** task results. A provider benchmark is a sourced external observation, not a projection or a measured LAZERS result. A projection must show its data, mapping and assumptions; changing provider or model aliases does not establish snapshot equivalence. Fetch metadata without launching paid inference. Expose absent external coverage rather than treating it as zero or vetoing the user's route.

## Reviewed market-price policy

OpenRouter is the standing fallback price index for all models. For subscription
work, calculate market-equivalent cost from observed usage and dated average
OpenRouter model/effort prices. Store averaging/source basis and the native effort;
where effort has no separate published rate, use that model's rates and measured
usage at the recorded effort. Keep actual billing/allowance and market estimates
separate. Scheduler/Trajectory own accounting as a core dependency, not a later
manual report. Real LAZERS work supplies observations; further machine/task
dogfood follows a complete usable public-repository release without announcement.

## Evidence model and accounting

Add plugin-owned, versioned records as needed; preserve existing runner/trajectory data rather than duplicate it as facts:

1. **Catalog observation:** source, retrieved-at, native provider/model ID or external slug, name, capabilities, context limit, native variants, raw price components/tier semantics, currency/units, freshness/error. Native catalog = runnable-route advice; Go subscription allowances and OpenRouter API prices = distinct sources. Explicit, evidenced mappings between route and external SKU/snapshot; unresolved mapping stays unknown, never fuzzy-join by display name. Keep previous snapshots for reproducibility; refresh manually/on bounded cadence without blocking execution.
2. **Benchmark evidence:** source URL, dataset/version, date, harness/scaffolding, model exact identity and effort if published, metric/unit, sample size and uncertainty if published. Preserve source-specific measures, never normalize heterogeneous scores into one rank or claim route equivalence without proof. Research notes include differing Vals, SWE-rebench and Search-SWE results, and some third-party provenance. OpenRouter programming popularity is adoption, not quality. Ingest supported OpenRouter benchmark data via its documented API when a configured credential is available; preserve source-specific shapes and unknown coverage.
3. **Assignment and attempt:** task/revision, explicit task class and persona with provenance; binding revision and frozen policy; attempt/session, base revision, timestamps, native actual route where observable, terminal outcome and acceptance evidence links. Immutable event/snapshot history permits later configuration changes and recovery. Include continuation/retry relations.
4. **Usage observations:** source/session and observation time, input/output/reasoning/cache read/cache write, time, tool calls/retries, missingness and coverage. Existing trajectory reads cumulative native session snapshots; deduplicate by unique session and use latest snapshot rather than summing snapshots. Confirm provider semantics before adding totals (reasoning or cache may overlap); do not double-count. Existing attempt has aggregate token_count and nullable cost; host currently returns cost null. No historical per-call pricing or Architect cost attribution should be implied.
5. **Cost observation/estimate:** separately record provider-reported charge, Go allowance consumption, and equivalent API-price estimate with snapshot/rate/tier/units and coverage. A subscription zero is not API cost. Require reliable per-call context/tier and cache semantics for exact price; otherwise label partial or unknown, not zero. Project from measured task mix only with explicit assumptions and a baseline; external benchmark token counts remain external, never LAZERS observations.

For an eligible cohort, acceptance rate = accepted logical tasks / all terminal logical tasks. Cost per accepted result = sum of attributable costs for all cohort attempts, failures, repairs and retries plus attributable Architect/verification/integration work / accepted logical tasks; report denominator and unknown or unallocated cost separately. Shared Architect sessions need explicit defensible attribution or a separate overhead bucket, not arbitrary distribution. Zero acceptances means undefined. Wall clock and human intervention should be visible separately. A task accepted after a change of route is a mixed-route result: show the full chain and avoid crediting its entire cost or acceptance to the final model. For single-route comparisons use matched starting revisions, task/acceptance, tools and independent quality checks; otherwise mark confounded, provide counts, range/uncertainty and avoid causal rankings. Small samples and censoring (pending/cancelled work) matter.

## Panel and chart

Use the existing native Desktop panel, tokens, accessible controls and interaction patterns. A compact decision surface: persona/route assignments at top; selected task class and time/cohort controls; then comparison chart with an adjacent sortable table. Show configured route, variant, data freshness, sample count, accepted/total, failed/reworked, cost coverage and source badges inline. Clicking a point opens exact cohort, session/attempt lineage, evidence and assumptions. Keyboard-accessible table is a complete alternative to the chart; support loading, empty, stale, unavailable, and partial states. Use restrained color for status/source and shape or labels for accessibility; tabular numbers and quiet hierarchy keep the decision prominent.

Requested plot: x = mean tokens per completed logical task, y = mean comparable cost per completed logical task, lower-left desirable, filtered by explicit class/persona and comparable evidence basis. Plot observed and projected as distinct visual treatments; never connect the two as if measured. A Pareto frontier here is mathematically valid for token and cost minimization only within the same cohort, accounting basis and quality eligibility; those dimensions are correlated and this frontier alone can favor a cheap failure. Show acceptance quality and sample size beside each point; indicate limited or incomparable cohorts and avoid presenting their frontier as a conclusive ranking. No mandatory arbitrary threshold or route veto. Offer a more decision-useful alternate view of cost per accepted result vs accepted tasks/hour, with acceptance rate, n and uncertainty visible. Unknown values remain unplotted and listed. Do not make automatically assigned winners or force a threshold before evidence exists.

## Increment boundaries for Architect to specify

1. **Assignment contract:** implement live hierarchical binding with shared defaults and overrides, persona policy and legacy treatment; enforce every new task's persona; snapshot exact binding per attempt; native dispatch/retry/recovery tests and Desktop observation. A future opt-in selector can use database evidence, prices and promotions; an optimizer is not required in this increment.
2. **Evidence foundation:** source-stamped native catalog and durable usage/route snapshots, deduplicated session accounting and explicit unknowns; verify restarts, failed attempts and changing preferences. Resolve Architect attribution before claiming full cost per accepted result.
3. **Read-only Models panel:** native catalog and assignments with truthful observed cohorts, quality/coverage and accessible table; define chart cohort and empty states. Validate actual Desktop interactions at relevant widths.
4. **External evidence and projections:** source adapter, exact mapping workflow, dated prices/benchmark metadata and explicit projection assumptions; test stale/missing data. Go allowance and OpenRouter estimates remain separate. Label comparability and sample coverage on Pareto overlays; never veto routes based on missing metrics.

Reviewed routing decisions: the task keeps its persona; shared defaults and overrides form a live hierarchical model/effort mapping resolved at dispatch. Future selection policies may use database evidence, prices, promotions and other user criteria. Keep the selected route and winning layer attributable per attempt. Three existing implementor personas remain the starting point; pricing basis and attributable overhead remain explicit in the displayed metrics.

## Primary sources

- OpenCode V2 models and selection: https://opencode.ai/v2/docs/models/ ; provider and custom route/variant configuration: https://opencode.ai/v2/docs/providers/ ; Go's separate subscription/allowances and model list: https://opencode.ai/v2/docs/console/go/ . Catalog availability and costs change; dated observations are not guarantees.
- OpenRouter documented catalog endpoint: https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties ; its API schema: https://openrouter.ai/openapi.json . Catalog prices are an external comparison, not Go billing, nor evidence of identical endpoint snapshots.
- Local authoritative pinned-host index `.agents/docs/opencode-api.md`; `src/runner/catalog.ts`, `src/runner/schema.ts`, `src/runner/runtime.ts`, `src/runner/native.ts`, `src/trajectory/native.ts`, README measurement and persona sections. Public benchmark and research source references are recorded in `.agents/docs/implementor-profiles.md` and `.agents/docs/research/implementors/`.
