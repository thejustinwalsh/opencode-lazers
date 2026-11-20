# Repomix with coding agents: practice and evidence

Research date: 2026-11-20. Not committed. Evidence labels: **Strong** (primary source with a clear measured setup), **Moderate** (primary source, small or indirect measurement), **Weak** (vendor, blog, or opinion), **Unverified** (search snippet only, not opened).

## 1. What the project documents

Sources: [Repomix README](https://github.com/yamadashy/repomix), [Repomix guide](https://repomix.com/guide/), [Repomix FAQ](https://repomix.com/guide/faq.md). No release date is shown on the README fetch; it reported 4,913 commits and 29.3k stars.

Stated purpose: "packs your entire repository into a single, AI-friendly file" for chat models (ChatGPT, Claude, Gemini). The guide lists planning, bug investigation, library security checks, and documentation generation as uses. It does not describe a one-pack-per-session pattern for agents.

| Feature              | Documented detail                                                                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Output styles        | `--style xml` (default), `markdown`, `json`, `plain`; `-o -` writes to stdout                                                                                                                                                                                                                                   |
| Selection            | `--include` (globs), `-i/--ignore`, `--stdin` (file list), `--no-gitignore`, `--include-full-directory-structure`                                                                                                                                                                                               |
| Compression          | `--compress`: Tree-sitter signatures; README calls it experimental. FAQ: useful "when the model needs an architectural overview more than exact line-by-line code"                                                                                                                                              |
| Per-file levels      | `output.patterns` config: full, compressed, or structure-only per glob; first match wins                                                                                                                                                                                                                        |
| Token counting       | `--token-count-tree [threshold]`, `--token-count-encoding` (default o200k_base), `--token-budget` (non-zero exit, for CI)                                                                                                                                                                                       |
| Split output         | `--split-output 1mb`; never splits a file across parts                                                                                                                                                                                                                                                          |
| Remote               | `--remote` URL or `user/repo`, `--remote-branch`; remote configs need `--remote-trust-config`                                                                                                                                                                                                                   |
| Git context          | `--include-logs` (default 50 commits, `--include-logs-count`), `--include-diffs`                                                                                                                                                                                                                                |
| Instruction text     | `--instruction-file-path` appended at end; `--header-text` at start. README cites Anthropic advice that long documents work better near the top, and puts the instruction at the end                                                                                                                            |
| MCP server           | `repomix --mcp` (FAQ: `npx -y repomix --mcp`). Tools: `pack_codebase`, `pack_remote_repository`, `attach_packed_output`, `read_repomix_output` (ID, line ranges), `grep_repomix_output` (JS RegExp). `file_system_read_file`/`_read_directory` only in `--sandbox` mode, which is application-level confinement |
| Claude Code          | Marketplace plugins `repomix-mcp`, `repomix-commands` (e.g. `/repomix-commands:pack-local`), `repomix-explorer` (analysis agent)                                                                                                                                                                                |
| Skills               | `--skill-generate` writes `.claude/skills/<name>/SKILL.md` plus references; `npx skills add yamadashy/repomix --skill repomix-explorer`                                                                                                                                                                         |
| Large repos (README) | Use `--token-count-tree` to find heavy files, narrow with include/ignore, `--compress` or `output.patterns`, `--split-output`, `--no-files` for structure only, and MCP grep/read "for incremental retrieval rather than loading everything at once"                                                            |
| Safety               | Secretlint pre-scan; FAQ: "treat this as a safety net, not a replacement for reviewing the output yourself"                                                                                                                                                                                                     |
| Repeatability        | FAQ suggests committing `repomix.config.json` so everyone generates the same output                                                                                                                                                                                                                             |

Gaps: the FAQ says nothing on staleness, regeneration, or caching. The docs do not say that a pack should sit in the system prompt or first message.

**Evidence: Strong for what the tool does; the docs are silent on how agents should use packs.**

## 2. How practitioners use it with agents

Sources are mostly blogs, listings, and comparison posts. Weak evidence.

- **Pack once, use as chat-style context.** Typical flow: `npx repomix`, then attach `repomix-output.xml` to a chat or first message. Weak. Source: [DEV guide](https://dev.to/amatisse/supercharge-your-ai-coding-workflow-with-repomix-a-developers-guide-54gh) (not opened).
- **Agent calls MCP tools mid-session.** The MCP design attaches a pack and then greps/reads it. Its benefit is incremental retrieval; the docs themselves say this is preferred for large codebases (see section 1). Moderate, as design intent.
- **Compressed map vs full pack.** Practitioners recommend `--compress` for architecture, full content for review. Source: [Repomix vs SigMap guide](https://manojmallick.github.io/sigmap/repomix.html) (vendor-adjacent, not opened). Weak.
- **Repo map in the system prompt (Aider-style).** A ranked outline of symbols, with the agent choosing which files to read. Opinion pieces call this the canonical pattern. Weak. Sources: [Aider repo map docs](https://aider.chat/docs/repomap.html), [Aider blog, 2023-10-22](https://aider.chat/2023/10/22/repomap.html).
- **Token-cost comparison.** One author reports a Repomix full XML dump of about 800k tokens on a 108k-line FastAPI repo, against 8k-15k for a repo map. Self-promoting comparison post. Weak. Source: [DEV comparison](https://dev.to/thegdsks/i-tested-4-codebase-to-ai-tools-on-fastapi-108k-lines-here-are-the-token-costs-4bmc) (search snippet only; not opened).
- **Committed overview files.** Repo-level `AGENTS.md`/`CLAUDE.md`, `llms.txt`, and architecture notes are common. An ablation found no measurable correctness change from context files (see section 3). Moderate.
- **Caching with a stable prefix.** Anthropic's pricing and caching docs support a stable cached prefix across turns. Whether subagents share it is not stated in the caching doc (section 3).
- **Planner with large context, executors with targeted instructions.** I found no measured source for this pattern; it appears as practitioner advice only. Unverified.

## 3. Outcome evidence

### 3a. Repository-specific

| Study                                                                                                                          | Setup                                                                                                       | Result                                                                                                                                                                                                                                                                              | Strength                                                          |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [Khatri, "Do Context Files Help Coding Agents?", arXiv 2607.27250, 2026-07-28](https://arxiv.org/abs/2607.27250)               | Claude Code and Codex; 3 repos; 17 tasks; 288 runs; gold tests; workshop paper                              | "Context strategy does not measurably move correctness on either agent." Equivalence bound about 10-15 pp. Failures were implementation skill, not missing repo knowledge                                                                                                           | Moderate (small sample)                                           |
| [Qin and Xie, Agent Retrieval Bench, arXiv 2607.24882, 2026-07-27](https://arxiv.org/abs/2607.24882)                           | 427 samples, 25 repos; retrieval only                                                                       | RepoMap best "budgeted context yield at 8K tokens"; no single family dominates; logged agent trajectories missed every gold file on 27-35% of samples; seed pilot: retrieval-derived starting context beat random context on F1 with less later exploration                         | Moderate (preprint; no end-to-end success numbers)                |
| [Deep Agentic Search, arXiv 2608.01507, 2026-08-02](https://arxiv.org/abs/2608.01507)                                          | SWE-QA (question answering, read-only); models not stated                                                   | Semantic search 65.2% vs deep agentic search 46.2%; semantic search cost less than half per correct answer; 41.8% of agentic failures at planner-to-subagent handoff, often silent                                                                                                  | Moderate (QA, not patching; journal under review)                 |
| [ReCUBE, arXiv 2603.25770, 2026-03-26](https://arxiv.org/abs/2603.25770)                                                       | Reconstruct masked file; 8 models; full context vs agentic exploration vs exploration plus dependency tools | Full-context GPT-5: 37.57% strict pass. Exploration helped more when context was tight; advantage shrank with capacity. Dependency tools add up to 7.56 pp                                                                                                                          | Moderate (unreviewed preprint)                                    |
| [Sam-Bodden, "What Context Does a Coding Agent Actually Need", arXiv 2607.09691, 2026-06-19](https://arxiv.org/abs/2607.09691) | SWE-bench Verified; localization given by oracle; multi-file N=70                                           | Compressed context matched whole files at about one-third the tokens (about 19K vs 94K per resolved issue). Natural-language summaries answered 4/45 vs 27/45 for source. UML skeletons no better than deletion (McNemar p=0.75). About 9% per-instance flip noise at temperature 0 | Moderate (single author; small N; oracle localization)            |
| [Coherence Collapse (TRAJEVAL), arXiv 2603.24631, 2026-03-25, rev. 2026-05-26](https://arxiv.org/abs/2603.24631)               | 16,758 trajectories; SWE-bench Verified                                                                     | 60-69% of failures on SWE-Agent and OpenHands reach and edit correct functions but still fail; main failure is overwriting correct code. Localization is not the main failure for capable models                                                                                    | Moderate (large sample; the abstract gives no step-share figures) |
| [Majgaonkar et al., arXiv 2511.00197, 2025-10-31](https://arxiv.org/abs/2511.00197)                                            | OpenHands, SWE-agent, Prometheus on SWE-bench                                                               | Fault localization identifies problematic files in 72-81% "even in failures" (ambiguous basis). Failed trajectories are longer and more variable                                                                                                                                    | Moderate (abstract only read)                                     |

Notes:

- My earlier search summaries gave a "read precision 4-5%" figure and a "35-40% miss the files" figure. The abstracts I opened do not contain them. Treat both as unverified.
- Agent Retrieval Bench and 2607.09691 both report that tighter, targeted context can beat whole-repo or open-ended search on cost. Neither measures end-to-end patch success on whole-repo packs.

### 3b. Wider literature

| Study                                                                                                              | Result                                                                                                                                                                                                                                                                         | Strength                                                                 |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [Aider repo map, 2023-10-22](https://aider.chat/2023/10/22/repomap.html)                                           | Tree-sitter ranked map, default 1k tokens (`--map-tokens`). Post reports no benchmark or token numbers; benefits are qualitative                                                                                                                                               | Weak (no measurement)                                                    |
| [Agentless, arXiv 2407.01489](https://arxiv.org/abs/2407.01489)                                                    | Hierarchical localization (files, then classes or functions, then edit locations), no free-form agent loop. Cost reported as $0.34 (v1, 27.3% on SWE-bench Lite) and $0.70 (later version, 32.0%). Third-party IssueExec comparison: $0.70 vs $1.14 OpenHands, $1.62 SWE-agent | Moderate (cost figures differ by version; I did not open the paper)      |
| [Liu et al., Lost in the Middle, arXiv 2307.03172, 2023-07-06 (rev. 2023-11-20)](https://arxiv.org/abs/2307.03172) | Performance drops when relevant information sits mid-context, even for long-context models                                                                                                                                                                                     | Strong (peer-reviewed-style measurement; abstract read only for numbers) |
| [Chroma, Context Rot, 2025-07-14](https://trychroma.com/research/context-rot)                                      | 18 LLMs. Reliability falls with input length even on trivial tasks; distractors lower accuracy; low-similarity needle-question pairs degrade faster; focused prompts (~300 tokens) beat full (~113k) on LongMemEval. Vendor report (Chroma sells a vector DB)                  | Moderate (open code; simple tasks; authors note limits)                  |
| Code-agent cost (CodeTracer, [arXiv 2604.11641](https://arxiv.org/abs/2604.11641))                                 | Search snippet only: SWE-Agent and OpenHands spend about 2x the tokens of MiniSWE-Agent for modest gains                                                                                                                                                                       | Unverified                                                               |

Exploration share of steps: I found no clean study giving the fraction of agent steps spent on localization. The closest measured data are section 3a's trajectory analyses, which give failure shares, not step shares.

### 3c. Prompt-caching economics

From [Anthropic prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and [pricing](https://docs.claude.com/en/docs/about-claude/pricing), fetched 2026-11-20. Strength: Strong (vendor documentation, current).

- Cache write: 1.25x base input (5-minute TTL), 2x (1-hour TTL).
- Cache read: 0.1x base input for most models; 0.05x for Opus 5.5 and Sonnet 5.5; 0.025x for Fable 5.1/5.2 and Mythos 5.1/5.2.
- Minimum cacheable prompt: 512 to 4,096 tokens, depending on model. Shorter prompts are not cached and no error is returned.
- Hierarchy: `tools` then `system` then `messages`. "Changes at each level invalidate that level and all subsequent levels." Modifying tool definitions "invalidates the entire cache." Toggling `speed: "fast"` invalidates system and message caches. Changing `tool_choice`, or adding or removing images anywhere, invalidates the cache.
- Mid-conversation: a `{"role": "system"}` message can be appended to `messages` so the cached prefix survives (not on Sonnet 5). Thinking-block handling also affects cache validity.
- Subagents: the page gives no guidance on subagent cache sharing. Unverified.

Consequence for packs: a pack in the static prefix is written once and read at 0.1x per turn. A pack returned by a tool call mid-conversation is an uncached message block; it is written once and then re-read as part of the message history on every later turn, and any compaction that drops it removes it.

Worked arithmetic (illustrative, not measured): a 200k-token pack, 50 turns, no cache, is 10M input tokens. With one 1.25x write and 49 reads at 0.1x, it is about 0.2M cache-write-equivalent plus 0.98M read-equivalent, about 1.2M input-price equivalents, or roughly 12% of the uncached cost. Exploration tokens that are re-read each turn compound the same way.

## 4. When it helps and when it hurts

| Condition                              | Favours a pack in context                                                                  | Favours agentic read/grep                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Repo size vs window                    | Pack fits comfortably (e.g. well under half the window)                                    | Pack exceeds window or pushes noise into it                                      |
| Task type                              | Cross-cutting change, architecture review, onboarding, questions needing whole-system view | Localized bug fix, known-file edit                                               |
| Model context length and cache pricing | Long window and cheap cache reads make a stable prefix cheap                               | Short window; cache misses on every edit                                         |
| Freshness                              | Pack rarely changes; code edits are rare                                                   | Frequent edits; pack goes stale                                                  |
| Agents sharing the prefix              | Several agents or sub-agents share one identical prefix                                    | Single short session                                                             |
| Compression level                      | Signatures or compressed content keep most information at 1/3 tokens (2607.09691)          | Compression drops behaviour the agent must read (summaries failed in 2607.09691) |
| Placement                              | Static system or first message, cached                                                     | Mid-session tool results, paid again each turn, dropped by compaction            |

Evidence strength for the table: Moderate at best. No study measures end-to-end success for whole-repo packs against agentic search on the same patching tasks.

## 5. Failure modes reported

- **Stale packs.** Snapshots do not update; the agent reasons about code that has changed. Source: third-party review (weak); the FAQ does not address staleness.
- **Token blowups.** Full XML of a large repo can reach hundreds of thousands of tokens (weak; single post). Repomix's own mitigations are include/ignore, token-count tree, and split output.
- **Agents ignoring the pack.** Not reported in primary sources I opened. Unverified.
- **Compressed outline misses behaviour.** Supported by 2607.09691 (summaries 4/45 vs source 27/45). Moderate.
- **Handoff failures.** 41.8% of failures in 2608.01507 at planner-to-subagent handoff, often silent. Moderate.
- **Distractors and long input.** Chroma (vendor, moderate) and Lost in the Middle (strong): accuracy falls with more related but irrelevant material and with mid-context placement.
- **Secrets.** Secretlint is a safety net; the FAQ says to review the output. Strong (vendor-stated).
- **Cache invalidation.** Any change to tool definitions or the system prefix invalidates the cache from that level down. Changing a pack placed in `system` rewrites the whole prefix. Strong (vendor-stated).
- **Noise.** 2607.09691 found about 9% per-instance outcome flip at temperature 0. Any single-run comparison of packs versus exploration sits inside this noise. Moderate.

## 6. Synthesis, best-supported first

1. **Keep the stable part of context stable, and cache it.** Cache reads at 0.1x make a fixed prefix cheap across turns. Strong (pricing) with a caveat: subagent cache sharing is undocumented here.
2. **Give the agent a map, not the whole repo.** Ranked signatures or a repo map at a few thousand to about 20k tokens, plus agent reads, match whole-file performance at lower cost on localized tasks (2607.09691, moderate; Agent Retrieval Bench, moderate).
3. **Use the pack for whole-system questions and onboarding.** Where the task needs global structure (ReCUBE, moderate), a compressed overview earns its tokens.
4. **Do not expect a context file to change correctness much.** 2607.27250 (moderate) found no measurable effect on correctness; failures were implementation skill.
5. **Keep retrieval tools available mid-task.** Grep/read over a pack or the repo covers the cases where the agent needs exact code (ReCUBE; Lost in the Middle).
6. **Regenerate on change, or use retrieval over the live repo, not a stale pack.** Repomix offers no staleness mechanism; this is an inference from the FAQ's silence.
7. **Avoid handoffs without shared context.** 2608.01507 (moderate) shows silent failures at planner-to-executor boundaries; pass the executor the specific context, not a summary.

### What would count as using it wrong

- Dumping the whole repo (hundreds of thousands of tokens) into every turn when the task is one localized bug.
- Placing a large pack mid-conversation as a tool result, then expecting it to remain cached or survive compaction.
- Regenerating a pack that changes on every edit inside the cached prefix, which invalidates every later read.
- Trusting a compressed outline for behaviour questions, where summaries did worst in 2607.09691.
- Judging the approach by one run; noise is about 9% per instance.
- Putting a pack into context without checking it for secrets.

## Could not reach

- Full text of 2607.09691, 2608.01507, 2607.27250, 2607.24882, 2603.24631, and 2511.00197 (abstract pages only). Any numbers above come from the abstracts or from the fetch summaries of them.
- Agentless full paper; cost figures are from search snippets and a third-party table.
- Repomix GitHub issues and discussions for staleness or token blowups; the search surfaced none that I could open.
- Repomix README past character 100,000; the MCP and plugin sections were in the read portion.
- Claude's docs on subagent prompt cache sharing.
- Practitioner posts on pack-in-system-prompt versus first-message placement, planner-executor setups, and committing packs; no first-person measured reports found.
