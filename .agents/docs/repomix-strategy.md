# Repomix in LAZERS

**Decision:** use Repomix's library as the shared repository-context layer for Architect, investigation and implementation. Build/reuse an index in code, select evidence in code, and deliver a focused ContextPacket. Reduce repeated discovery, model-visible content and unnecessary questions while preserving exact implementation/test evidence.

Reviewed 2026-10-31: **all 26 canonical English guide pages** in the website sitemap, including advanced/integration, development, privacy and community pages. [Coverage and page hashes](evidence/010-repomix/docs-coverage.json). Translated duplicates and linked third-party websites are outside this coverage. The [original brief](sources/original-design-brief.md) and [source transcript](sources/agent-harness-solutions.json) are now retained locally with provenance.

Architect publishes a reusable Repomix snapshot. Workers receive a focused source bundle with their complete task through `lz-get-task`; no separate manifest/read sequence is required to start. Specialist dispatch remains part of the native scheduler workflow.

## Where the savings come from

The runtime owns inventory, ignore handling, file selection, content identity, token accounting, packet assembly and reuse. Models supply task/research intent and relevant-area hints; they do not manually repack a repository, repeatedly rediscover its structure, or choose arbitrary output locations. File filtering is a deterministic operation, not another LLM assignment.

A local probe used Repomix **1.18.1** on the current plugin. It collected permitted source/tests and counted `o200k_base` tokens, then selected seven files around submission and optionally extracted their structural outline:

| Content                                              | Files | Content tokens | Intended use                                 |
| ---------------------------------------------------- | ----: | -------------: | -------------------------------------------- |
| Plugin source, tests and root guidance/configuration |    68 |         80,702 | Comparison baseline; not the default prompt  |
| Selected submission implementations and tests        |     7 |          6,807 | Exact relevant source                        |
| Structural outline of those selected files           |     7 |          1,081 | Navigation; implementation bodies are absent |

Selection removed **91.6%** of this baseline's content tokens. Compression removed a further **84.1%** from the selected files. Giving both outline and all selected originals would be approximately 7,888 content tokens before wrappers, rather than 80,702. Prefer only the originals actually needed after navigation. These figures exclude system/tool schemas, instructions, conversation history, specialist reasoning and verification. They measure content size, not equivalent task quality or total cost.

The pinned Bun binary/revision ran the complete local probe in approximately **541ms**, including a 63ms dynamic import and 59ms selected-file compression. This single warmed-machine observation is not a cold-install, large-repository or production-host benchmark. [Exact inputs, hashes and result](evidence/010-repomix/context-probe.json); [reproducible probe](evidence/010-repomix/context-probe.ts).

The repository-discovery savings extend beyond compression: prepare a useful packet once instead of repeating path searches and individual reads for Architect and each worker. One bounded retrieval can contain multiple related excerpts. Measure the actual reduction against native traces; do not equate seven files with seven unavoidable tool calls.

## Mechanical context pipeline

1. **Inventory the actual workspace.** Index permitted tracked, dirty and untracked source, tests and relevant documentation. Record workspace identity, ignores, tool/config version, coverage and token sizes. Use ordinary cache metadata; do not require file hashes as evidence.
2. **Navigate cheaply.** Return a bounded map, subsystem/token summaries and opaque snapshot identity. The complete stored pack stays outside model context. Literal search and original-file ranges resolve focused questions; later native symbol/reference information can complement this where available.
3. **Select one packet.** Use Architect's relevant-area hints and the admitted task's context references, dependency interfaces, tests and repository rules. The task fetch selects cited ranges and compressed outlines, includes snapshot provenance, and lists source deferred from its initial response. Missing optional source never rejects the task.
4. **Cite and reuse.** Cite original paths and line ranges. Cache expensive collection/analysis and refresh changed files as ordinary cache maintenance. Permission checks remain per consumer. Owned workers reuse their Architect publication across worktrees; source provenance identifies the snapshot workspace. Concurrent edits do not invalidate a task's right to be submitted.
5. **Deliver in one fetch.** Dispatch gives the worker its task identity and `lz-get-task` instruction. That tool returns the complete readable task, current advice, skill names/descriptions and focused cached source. Normal source reads, search, shell, LSP and Code Mode remain available. Skill bodies are loaded only when useful.
6. **Return deltas.** Repair receives the failing check, exact artifact/diff, affected evidence and prior usage. Refresh invalidated source instead of replaying the entire exploration transcript.

Architect should establish repository facts before asking avoidable questions. Intent, authorization and product decisions still use structured questions. Retrieving an existing task, greeting the agent or making a simple well-grounded request must not trigger a mandatory research swarm. Do not require source hashes or evidence receipts for submission. Keep JSON schema validation and Architect self-review through `lz-verify-task`, including the System One gut check. Passing tests and observed feature behavior establish completion.

Keep agent definitions to role, decision boundary and evidence/report shape. Tool descriptions expose the small typed operations; runtime code owns filtering recipes, counters, freshness, permissions and error handling. Do not paste the Repomix manual or a procedural checklist into every agent prompt. Confined Code Mode can batch/query permitted tools and return selected results where verified; implementors retain normal Code Mode, while Architect still cannot bypass mutation or dispatch authority.

## Filtering and output choices

| Control                           | LAZERS use                                                                                                         | Why                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Include/ignore and explicit files | Select the relevant implementation, interfaces, tests and guidance; respect project ignore data and access policy  | Avoid delivering unrelated modules, binaries, generated data and historical transcript bulk |
| Per-file inclusion levels         | Full content for behavior/tests; compressed outline for surrounding interfaces; structure-only for unrelated areas | Spend context where the task needs detail                                                   |
| Token counts/tree                 | Compute file/subsystem weight before selection; count final packet including wrappers                              | Choose useful content under a real context reservation                                      |
| JSON                              | Internal manifest and packet metadata                                                                              | Parse without model reasoning or fragile text scraping                                      |
| Markdown/source blocks            | Human-readable focused evidence with original citations                                                            | Fit native tools, task context and inspector rendering                                      |
| XML                               | Optional interoperable packed artifact                                                                             | Useful structure; benchmark rather than assume universal model superiority                  |
| Line numbers                      | Number original-source excerpts after selection                                                                    | Preserve actionable citations; transformed-pack lines are different coordinates             |
| Comments                          | Preserve contracts, rationale, warnings and test intent by default                                                 | Blind stripping can remove requirements and cause repairs                                   |
| Git diffs/logs                    | Add only for a question that needs change/history evidence                                                         | Ordinary planning does not need repeated logs or a second full copy of source               |
| Ordering                          | Stable path/content ordering; disable change-frequency sorting for reusable prefixes                               | Avoid needless packet/prefix changes                                                        |
| Splitting                         | Storage/transport fallback with explicit ranges                                                                    | Splitting a pack does not make sending every part cheaper                                   |

Repomix supports first-match per-file rules and structure-only/full/compressed levels. Keep our data-selection policy explicit rather than executing repository configuration. [Configuration](https://repomix.com/guide/configuration), [output formats](https://repomix.com/guide/output), [usage](https://repomix.com/guide/usage).

Tree-sitter compression is useful for orientation. It removes bodies and control-flow detail; original code/tests remain necessary for behavioral claims and implementation. Parser failures or unsupported files must not be counted as successful compression. Original and transformed line coordinates stay distinguishable. [Compression](https://repomix.com/guide/code-compress), [comment handling](https://repomix.com/guide/comment-removal).

## Roles and dispatch

| Role              | Responsibility                                                                                          | Capabilities and authority                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Architect         | Understand intent, reconcile evidence, define tasks, request research/execution, decide repairs/replans | Read/context/research/task commands; runtime owns admission and transitions                                               |
| Code Investigator | Answer one bounded repository question with implementation/test citations and unknowns                  | Internal read-only subagent, shared context tools; no implementation or delegation                                        |
| Web Researcher    | Answer one current external question with opened primary sources, dates/versions and uncertainty        | Internal public research tools; no repository upload, implementation or delegation                                        |
| Implementor       | Complete an admitted task and report artifact, changed paths, evidence and issues                       | Normal host coding tools, Code Mode, shell, editing and available LSP/diagnostics under user/project policy; no subagents |
| Scheduler/runtime | Admit resources, assemble context, dispatch, observe, verify, recover and deliver                       | Deterministic authority; no reasoning call for routine progress                                                           |

Research profiles are hidden subagent roles, not extra primary agents humans must select. Hiding is presentation; dispatch also validates the Architect caller and allowed role. Architect requests a specialist with a bounded question, context references and policy. The runtime resolves the approved agent/model/variant and skills/tools **before** creating the native child. Implementation dispatch uses the same admission/host boundary with its task plan. There is no unrestricted subagent escape or second research scheduler.

Defaults inherit the initiating authorized subscription selection unless explicit approved role policy selects otherwise. Record the actual resolved model/variant; an unset field alone does not prove inheritance. Different specialist models are future policy inputs, not hard-coded personas. Optimize total accepted work per dollar/hour, including retries and verification. A missing model or required capability produces a concrete blocked result. Track trajectories and usage; do not invent execution budgets.

Implementor write scope is enforced against the actual artifact by runtime, not by restricting reads to that directory or depriving the worker of useful tools. Keep normal project/user denials. Block worker delegation on native and LAZERS dispatch paths, including Code Mode access; prompt wording alone is insufficient. Broad shell access is not an OS sandbox. Pinned OpenCode has no standalone plugin LSP domain, so preserve and verify actual native diagnostic/symbol capabilities rather than inventing an API.

## Local reuse and provider caching

These are different savings. Local reuse avoids repeat collection, compression, analysis and discovery. Provider caching can discount repeated prompt prefixes when the model/provider actually supports and reports it. Cached local files do not imply a shared provider cache or free context.

Keep stable role instructions, tool schemas, repository rules and unchanged subsystem material in deterministic order. Place volatile request/session/build-time metadata outside a stable prefix. Avoid regenerating timestamps or reordering files in reusable content. The scheduler may favor context affinity among ready tasks only when dependencies, scope conflicts and measured benefit allow it.

Measure weighted cost, not token count alone: a larger cached input can sometimes cost less than a smaller uncached one. For prices quoted per million tokens:

```text
equivalent API cost =
  (uncached input × input price
   + cached input × cached-input price
   + output × output price) / 1,000,000
  + applicable request/tool charges

cost per accepted task = total cost of all attempts / accepted tasks
```

Use dated OpenRouter metadata for the exact comparable model/provider route when estimating. Do not silently substitute a similarly named model, omit failed attempts, treat missing cache usage/pricing as zero, or confuse subscription charges with API-equivalent estimates. Report local indexing time/memory separately. No paid OpenRouter inference is needed for this research.

## Features we adopt selectively

- **Library, not a new daemon.** Use pinned public core exports with plugin-owned configuration and lazy loading. `mergeConfigs`, collection, security scanning and initialized token counting worked locally. Keep server dependencies out of the Solid GUI bundle. Compression adds parser/WASM packaging requirements. [Library](https://repomix.com/guide/development/using-repomix-as-a-library).
- **MCP/Explorer patterns.** Adopt map → search → focused read, opaque output identities and progressive disclosure. Our native tools provide this inside the one plugin. Installing another MCP server or copying a CLI-oriented skill into every prompt adds no automatic savings. [MCP](https://repomix.com/guide/mcp-server), [Explorer](https://repomix.com/guide/repomix-explorer-skill).
- **Generated references/skills.** Version-pinned library/doc reference packs can reduce repeated external research. Generated repository references are evidence, not automatically trusted instructions or required skills. Keep lightweight descriptors separate from large reference content and load only what applies. Preserve source/version and deterministic skill delivery. [Skills generation](https://repomix.com/guide/agent-skills-generation).
- **Remote repositories.** Later, use explicit approved repository/revision and scoped docs/source selection for external implementation research; reuse the resulting reference. Keep remote configuration trust off. Do not introduce automatic cloning or unrelated project access in the first local-index increment. [Remote processing](https://repomix.com/guide/remote-repository-processing).
- **Watch/CI.** On-demand validated reuse comes first. A future debounced invalidation hint may be useful; repacking on every edit is not inherently efficient. CI packs must name the candidate revision and pinned tool/action version. Neither an event nor a passing pack certifies freshness or accepted work. [Watch](https://repomix.com/guide/watch-mode), [Actions](https://repomix.com/guide/github-actions).

## Access, bounds and source integrity

Local library processing keeps repository material on the machine until selected content is sent through the already authorized model path. Never upload the repository to the hosted packing form or send source text as web-search queries. Keep sensitive paths excluded and Secretlint enabled; scanning is a heuristic, not the read-access boundary. Respect per-caller read policy even on cache hits. [Privacy](https://repomix.com/guide/privacy), [security](https://repomix.com/guide/security).

Supply validated configuration, not executable project/global config, processors or arbitrary external instruction files. Confine real paths and artifact identities to the trusted workspace. Cache outside the repository with bounded size/age, no partially published artifacts and no cross-worktree identity confusion. Cap traversal, source bytes, build time, final packet bytes/tokens and cache growth before work can expand. Repomix's token-budget option reports overflow after output generation, so it is not sufficient admission control. [CLI limits](https://repomix.com/guide/command-line-options).

## How we prove the win

Use fixed source revisions and representative requests: a small change, an ambiguous request answered by repository evidence, a cross-module change, a version-sensitive external question, and a repair after source changes. Compare native OpenCode discovery, focused full-source packets, and map/outline plus targeted originals on the same model/variant. Run repeated trials, include failures and preserve equal acceptance/verification.

Record delivered/repeated input tokens, output/reasoning/cache usage where reported, exploration and duplicate-read calls, packet/build/reuse time, total latency, cost estimates, unnecessary questions, repairs and accepted outcomes. Separately check source/test relevance and whether a smaller packet omitted a requirement. Keep an optimization when it improves accepted work per dollar/hour without reducing completion or quality. Compression percentage, dispatched-agent count and invocation of a tool are supporting measurements, not the success metric.

Implementation order: shared index/focused retrieval and freshness → worker packet composition → common admitted specialist/task dispatch → native comparative trials and refinement. Keep one worker as default, avoid a permanent reasoning supervisor and do not claim production indexing or cost savings from these planning artifacts.
