# UI implementor research for LAZERS

Research date: 2026-10-31. Scope: how to write tasks for affordable UI/frontend implementors, and what can be said about the OpenCode Go candidates. This report separates measured evaluations, vendor guidance, and practitioner anecdotes. It does not claim a universal best prompt or a model ranking that the sources do not establish.

## Findings that survive the evidence

UI work has two different acceptance dimensions: the page must look right, and it must behave right. VISTA explicitly finds that visual fidelity and functional correctness are only partially coupled. Its evaluator therefore combines DOM-grounded visual anchors, browser behavior checks, and an image-similarity signal. A green build or screenshot alone is insufficient. [VISTA](https://arxiv.org/abs/2605.26144)

The task should give the implementor a concrete target and a way to observe the result. Anthropic's coding-agent guidance recommends the same loop for frontend work: provide a mock or screenshot, give the agent a screenshot-capable browser tool, implement, capture the result, and iterate. It says two or three visual iterations commonly improve the first result, but this is vendor workflow guidance rather than a controlled comparison. [Anthropic Claude Code best practices](https://www.anthropic.com/research/claude-code-best-practices)

The target must describe states and interactions, not only a static image. GLM-5's CC-Bench-V2 frontend evaluation first checks that the project builds, then uses a Playwright-equipped GUI agent to click, type, take screenshots, inspect output, and grade individual checklist items. The benchmark covers landing pages, dashboards, data visualization, graphics, productivity tools, games, and forms across HTML, React and Vue. GLM-5 reports HTML instance success 38.9%, React 34.6%, and Vue 32.7%; check-item success is higher (76.3%, 71.0%, and 77.1%). These are vendor-reported results, and GLM-5 is not necessarily the same artifact as the OpenCode Go `GLM-5.3-Flash` route. [GLM-5 paper, frontend evaluation](https://arxiv.org/abs/2602.15763)

Static screenshot-to-code remains difficult. Design2Code reports that models lag at recalling visual elements and laying them out correctly. Text extracted from the reference image improved most models, while self-revision helped only some models. Its benchmark contains 484 real webpages plus an 80-example hard set, and its metrics separately measure element recall, text, position, color and visual similarity. It is a multimodal generation benchmark, not an agentic existing-repository benchmark, so transfer to LAZERS should be treated as a hypothesis. [Design2Code paper](https://aclanthology.org/2025.naacl-long.199/), [official dataset/evaluation code](https://github.com/jiahuigeng/Design2Code)

Task quality is also a specification problem. SWE-WebDevBench reports a specification bottleneck: platforms compress rich product requirements into oversimplified plans, while polished frontends can hide broken backends. It distinguishes app creation from modification, which matters for LAZERS because modifying an existing panel is harder than generating a blank page. The benchmark's initial results are descriptive of six platforms and require replication. [SWE-WebDevBench](https://arxiv.org/abs/2605.04637)

The practical consequence is narrow: write a compact observable contract, attach the relevant visual and code context, and make the visual/functional checks executable. Do not attempt to encode every CSS decision in the task.

## What to put in a UI task

Use five short sections. Empty sections are acceptable.

1. **Goal** — one sentence describing the user-visible change and its purpose.
2. **Done when** — the important states and interactions, expressed as observable outcomes. Include responsive or keyboard behavior only when it matters to this change.
3. **Reference** — screenshot/mock path, viewport, route, existing component, design tokens, or a nearby screen to preserve. Give the implementor enough context to see the target; do not paste a whole design system.
4. **Guidance** — at most a few repository-grounded pitfalls or reuse pointers. This is advice, not an implementation mandate, unless the contract says otherwise.
5. **Verification** — build/test command and a short browser checklist. For visual changes, require screenshots at named viewport(s) and compare the relevant anchors. For interaction, require clicks/keyboard actions and expected state changes.

Dependencies, assignment, workspace, model and trajectory metadata stay in the structured LAZERS record. They do not belong in the worker-facing prose.

The reference section should prefer a small set of high-signal artifacts:

- one or two representative screenshots, with viewport dimensions;
- the route or component to change and one nearby implementation to reuse;
- existing theme tokens and component primitives;
- the states that are visually different (empty, loading, error, selected, disabled, overflow, narrow viewport);
- a short interaction path for each important behavior.

Do not tell the implementor to recreate a screenshot pixel by pixel unless that is genuinely the acceptance contract. Do not name a component hierarchy, CSS class list, state library, or file-by-file edit plan unless compatibility makes it required. Those are choices the implementor can make after inspecting the repository.

## The UI mini-skill to attach selectively

This is the useful compound-engineering knowledge to carry with a task. It should be a short reusable skill, with only the relevant bullets attached:

> **UI implementation guidance**
>
> Start from the existing component and token primitives. Implement the smallest coherent change, then run the app at the stated viewport. Verify the named interaction states with browser actions and capture a screenshot of each state. Check keyboard focus, accessible names, overflow and narrow-width behavior when the task changes controls or layout. If the screenshot differs, fix the largest layout or typography mismatch first; do not add unrelated polish. Reuse existing patterns before introducing a new abstraction. Report the checks and any remaining mismatch.

The Architect may append two or three findings specific to the repository, for example: “The panel already uses `--surface-2` and `CommandButton`; do not introduce a second token set,” or “The move operation is asynchronous; await the session before taking the verification screenshot.” These are much more valuable than a generic front-end manifesto. If there are more than a few high-impact pitfalls, the task may be too broad and should be decomposed or given a stronger implementor.

## Minimal worker-facing template

```text
Goal
<user-visible change and why it matters>

Done when
- <observable behavior/state 1>
- <observable behavior/state 2>
- <responsive/accessibility condition, if material>

Reference
- Route/component: <path>
- Visual reference: <image path or existing screen>; viewport <width × height>
- Reuse: <existing component/token/example>

Guidance
- <one repository-grounded pitfall or useful pattern>
- <one more only if it prevents a likely failure>

Verification
- Run: <smallest relevant checks>
- Browser: <short action sequence and expected result>
- Capture: <named viewport/state screenshots when visual fidelity matters>
```

This is a contract and a starting point, not a script. The implementor still investigates the code, chooses the local implementation, and can explain a necessary deviation.

## LAZERS-like example

```text
Goal
Make the session-scoped Tasks panel let a user understand active work quickly without leaving the OpenCode session.

Done when
- The panel is an optional, closable extra-panel item scoped to the current session/project.
- It shows unfinished tasks grouped by state and hides completed tasks by default.
- Selecting a task shows its goal, waiting-on state, done-when conditions, and activity below the list; Details and Activity start collapsed.
- Markdown in task details renders correctly, and a long structured specification remains readable in a bounded scroll area.
- The layout remains usable at the panel width and respects the active OpenCode theme tokens.

Reference
- Start from the existing Tasks panel and its current theme primitives; preserve the Linear-like compact hierarchy.
- Verify at the panel's normal narrow width and one wider width. Use the existing task fixtures.

Guidance
- Reuse the panel/session state and OpenCode theme variables already present; do not add a global task store.
- Treat the task record as the source for state and waiting-on text; do not duplicate runner state in the UI.

Verification
- Run the focused UI tests and the repository quality checks.
- Open the panel, close and reopen it, select an unfinished task, expand Details and Activity, and verify Markdown, scrolling, and theme colors.
- Capture screenshots at the two widths and report any remaining visual mismatch.
```

The example states the product behavior and the checks while leaving component structure, CSS details, and test implementation open. If the Architect discovers that the existing panel cannot support session scoping without a runner/API change, that is a reason to split the work, not to append another page of constraints.

## Model and persona implications

The persona should be capability-based rather than vendor-based. A single **UI / Product Frontend Implementor** persona is enough:

- inspect existing UI, tokens and component patterns before editing;
- use browser/DOM tools and screenshots when available;
- preserve product behavior and accessibility;
- implement, run focused checks, inspect rendered states, and iterate;
- do not delegate to subagents; commit the coherent change and report checks.

Do not put a model name in this persona. Route models by measured capability and tool support. The same task should be usable by a strong model and an affordable one.

OpenCode Go's current catalog is a useful sampling pool, not a benchmark result. Its official docs list `GLM-5.3-Flash`, `GPT 6 Luna`, `Qwen3.8 Max`, `Qwen3.8 Flash`, `Qwen3.7 Plus`, and other coding models; the list can change. The Go service says it tests model/provider combinations for agentic coding, but it does not publish UI-specific scores. [OpenCode Go model list](https://dev.opencode.ai/v2/docs/console/go/), [Go pricing/usage table](https://dev.opencode.ai/v2/docs/console/go/)

Provisional candidates for UI dogfooding:

- **Qwen3.8 Flash**: OpenRouter describes it as multimodal with image input and coding/tool-use capability. That makes it a natural first candidate for screenshot-grounded UI tasks, subject to confirming that the OpenCode Go route actually exposes image input and browser tools. [OpenRouter model page](https://openrouter.ai/qwen/qwen3.8-flash/providers)
- **GLM-5.3-Flash**: officially present in the Go pool, but the public GLM-5 frontend numbers are for GLM-5 and cannot be substituted for 5.3 Flash. The GLM-5 study shows that fast models still need a build → browser interaction → screenshot/checklist loop; it also gives a useful reference point for what to measure. Treat 5.3 Flash as an empirical candidate, not a proven visual specialist.
- **GPT 6 Luna**: present in Go, but no public UI-specific result was located in this research. Test it on the same task family; do not infer UI quality from general coding scores.
- **Claude Sonnet**: a useful external reference for the visual loop. Anthropic documents screenshot iteration, and the GLM-5 paper used Claude Sonnet 4.5 as its GUI judge. That does not establish Sonnet as the cheapest implementor or make the judge independent of model bias.

DesignArena's live text-to-HTML preference leaderboard currently includes a large spread of proprietary and open models and reports separate categories such as UI components, dashboards and data visualization. It is useful for discovering candidates and task categories, but its pairwise harness, prompt, provider route and sample composition are not enough to select a LAZERS implementor by themselves. [DesignArena frontend leaderboard](https://www.designarena.ai/leaderboard/code)

Community reports are mixed. Some OpenCode/LocalLLaMA users report GLM models producing reliable functional code on large repositories, while others report weak vision/frontend work or large differences between providers and harnesses. Qwen users report strong structure-following on screenshot tasks and occasional repetition or context-loop failures. These are anecdotes with uncontrolled prompts, versions, quantization, and tool setup. Use them as hypotheses for tests, never as acceptance evidence. Examples: [GLM-5.3 Flash production report](https://www.reddit.com/r/ZaiGLM/comments/1wyesun/), [Qwen screenshot comparison](https://www.reddit.com/r/Qwen_AI/comments/1r72ddg/), [Qwen/OpenCode context report](https://www.reddit.com/r/LocalLLaMA/comments/1x5e5c/).

## Dogfood protocol for the UI persona

Use three small tasks with the same harness and fresh sessions:

1. **Static modification:** match a supplied reference screen while preserving an existing component system.
2. **Stateful interaction:** add a compact panel with selected, empty, loading, error and keyboard states.
3. **Existing-app repair:** fix a visual/interaction regression in a real route with a reproducible browser path.

For each model/route, record build success, focused test pass, behavior checklist pass, visual-anchor pass, accessibility checks, number of edit/verify iterations, wall time, input/output/reasoning tokens, and rework after review. Separate discovery, implementation, browser verification, and repair in the trajectory. Grade visual fidelity and functional correctness separately, following VISTA's warning that they diverge. A task is successful only when the required behavior and the relevant visual checks pass; a model's prose confidence is not evidence.

Run at least three trials per model/task before changing the persona. Keep the task constant while comparing models. If a model fails, classify the cause (missing visual context, wrong repository pattern, tool/harness failure, missed state, or code defect) before adding guidance. Add a mini-skill bullet only when the same failure recurs and the advice is repository-grounded.

## Limits and non-findings

No source reviewed establishes a “perfect” UI prompt, a universal token budget, or a stable ranking of Qwen3.8 Flash, GLM-5.3-Flash, GPT 6 Luna and Sonnet in OpenCode Go. Most published coding scores are sensitive to model revision, provider, harness, context, tool availability, judge, and temperature. The task schema should therefore encode observable goals and verification artifacts, while model routing and persona tuning remain empirical.
