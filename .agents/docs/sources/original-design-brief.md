<!-- Source: https://chatgpt.com/share/6ae566ed-4b30-83ea-9d5d-23d85c7c4ae4
Fetched: 2026-10-31T08:53:45.684769+00:00
Raw HTML SHA-256: e90cdcfb9109caedaddc34a7b61ca2fe15b05d119f1a11657b0b820bdcd98d87
Source message ID: 04974d94-2d5d-4b86-93a5-0349b71fedb0
Readable Markdown formatting normalized; exact source message text is retained in agent-harness-solutions.json.
Extracted source text; historical API/model claims elsewhere in the source transcript require current verification. User's subsequent decisions take precedence.
-->

# Workhorse — The Original Mission

> **Build a production-grade agentic software engineering system that reliably completes scoped development work with minimal human intervention, predictable quality, and the lowest practical cost in tokens, time, and money.**

The goal was never to build a smarter orchestrator, collect more skills, or create another elaborate agent framework.

**The goal was to get back to telling an agent what to build, letting it cook, and receiving completed, working software.**

Everything else exists to make that possible.

## 1. The problem we set out to solve

You described a regression in your everyday coding workflow: newer frontier agents consuming 2–3× the tokens, taking up to 6× longer, repeatedly verifying trivial changes, failing to activate relevant skills, and leaving scoped features unfinished.

Your original workflow was relatively simple: provide a plan, establish strict quality tooling, and let the agent execute independently.

We want to recover that experience without sacrificing the capabilities of newer models.

That gives us five fundamental requirements.

| Requirement        | What success means                                              |
| ------------------ | --------------------------------------------------------------- |
| **Completion**     | Agents finish the requested feature, not merely make progress   |
| **Autonomy**       | You don't need to supervise individual implementation decisions |
| **Efficiency**     | Minimal wasted reasoning, tool calls, context, and verification |
| **Quality**        | Existing engineering standards remain enforced                  |
| **Predictability** | Tasks have bounded cost, duration, and failure behavior         |

Notice that none of these requires multi-agent orchestration.

Multi-agent execution is a possible optimization, not a foundational requirement.

## 2. The system's operating philosophy

We arrived at one central architectural principle:

**Use intelligence to understand and implement work. Use deterministic software to control how work is executed.**

<box border radius="xl" padding={3} gap={2}>
  <box background="surface-secondary" radius="lg" padding={3} align="center" gap={1}>
    **Your intent**
    <caption>What you want built and what success looks like</caption>
  </box>
  <row justify="center"><icon name="arrow-down"/></row>
  <box border radius="lg" padding={3} align="center" gap={1}>
    **Understand and specify**
    <caption>Clarify only what's necessary • inspect repo • define acceptance</caption>
  </box>
  <row justify="center"><icon name="arrow-down"/></row>
  <box border radius="lg" padding={3} align="center" gap={1}>
    **Compile executable work**
    <caption>Tasks • dependencies • affected scope • required capabilities</caption>
  </box>
  <row justify="center"><icon name="arrow-down"/></row>
  <box border radius="lg" padding={3} align="center" gap={1}>
    **Execute with appropriate workers**
    <caption>Model selection • skills • parallelism • budgets</caption>
  </box>
  <row justify="center"><icon name="arrow-down"/></row>
  <box border radius="lg" padding={3} align="center" gap={1}>
    **Verify and deliver**
    <caption>Acceptance • evidence • bounded repair • completed change</caption>
  </box>
</box>

The key is that this pipeline should be almost invisible for simple tasks.

A one-file bug fix shouldn't produce a five-stage ceremony, multiple agents, and a lengthy review process.

A complex cross-package feature may legitimately require decomposition, parallel workers, and integration.

**The system must scale its process to the complexity of the work.**

## 3. What we actually need to define

Before writing plugins, we need to establish six contracts.

### Contract 1 — Task specification

What information must be present before execution can begin?

The system should turn your request into a clear definition of done, identifying assumptions, constraints, affected behavior, and verification requirements.

It should ask questions only when the answer changes what must be built.

**Deliverable:** A task specification schema and clarification policy.

### Contract 2 — Work decomposition

When should one task become multiple tasks?

The architect should inspect the relevant repository areas, identify dependencies, and determine which work can be done independently.

It should avoid splitting work merely because multiple files or technologies are involved.

**Deliverable:** A task graph schema with rules for decomposition, dependency detection, and write-scope conflicts.

### Contract 3 — Execution policy

How does the system decide what runs, where, and with which resources?

We need explicit rules for selecting agents, models, skills, tools, context, concurrency, and execution budgets.

The model can provide information for those decisions, but the scheduler should enforce them.

**Deliverable:** A deterministic execution-policy engine.

### Contract 4 — Verification and completion

What evidence proves that work is finished?

We need to distinguish implementation progress, passing tests, acceptance criteria, and actual completion.

Verification should occur at useful boundaries, not reflexively after every edit.

Failed verification should produce actionable repair instructions, with bounded retries.

**Deliverable:** A verification policy, acceptance evaluator, and terminal task states.

### Contract 5 — Context and memory

What information should each worker receive, retain, and reuse?

We need to minimize redundant repository exploration, preserve relevant architectural knowledge, and exploit provider caching when possible.

Memory should reduce work, not create another mandatory research phase.

**Deliverable:** A context assembly policy and measured caching strategy.

### Contract 6 — Measurement and learning

How do we know the system is improving?

We need traces, token usage, cost, latency, retries, tool-call patterns, acceptance outcomes, and human intervention metrics.

Without this, we'll end up optimizing based on which model feels better rather than which configuration produces more completed work.

**Deliverable:** A benchmark suite and execution telemetry.

---

## 4. The most important architectural constraints

These are the principles I would make non-negotiable.

<box gap={3}>
  <row align="start" gap={2}>
    <icon name="check-circle" color="success"/>
    <box flex="1" gap={1}>
      **One default entry point**

      You interact with one agent. It understands the request, determines whether clarification is needed, and prepares the work. You shouldn't manually select a collection of specialist agents.
    </box>

  </row>
  <row align="start" gap={2}>
    <icon name="check-circle" color="success"/>
    <box flex="1" gap={1}>
      **No permanent thinking supervisor**

      Once work is specified, deterministic scheduling takes over. The architect returns only when new reasoning is necessary.
    </box>

  </row>
  <row align="start" gap={2}>
    <icon name="check-circle" color="success"/>
    <box flex="1" gap={1}>
      **No mandatory multi-agent execution**

      A single worker is the default. Additional workers must offer measurable benefits.
    </box>

  </row>
  <row align="start" gap={2}>
    <icon name="check-circle" color="success"/>
    <box flex="1" gap={1}>
      **No probabilistic enforcement of required policy**

      Essential skills, permissions, budgets, and verification are selected and enforced by software, not by hoping the agent remembers instructions.
    </box>

  </row>
  <row align="start" gap={2}>
    <icon name="check-circle" color="success"/>
    <box flex="1" gap={1}>
      **No unbounded loops**

      Repeated investigation, verification, repair, and replanning need explicit limits and escalation conditions.
    </box>

  </row>
  <row align="start" gap={2}>
    <icon name="check-circle" color="success"/>
    <box flex="1" gap={1}>
      **No optimization without evidence**

      Hashline, persistent memory, Compound Engineering, additional agents, and model routing must earn their place through measured improvement.
    </box>

  </row>
</box>

## 5. What we decided to build versus adopt

OpenCode V2 is our chosen foundation, including its desktop interface, custom agents, plugin hooks, sessions, and model integrations.

We don't want to recreate those capabilities.

| Adopt                         | Build ourselves                           |
| ----------------------------- | ----------------------------------------- |
| OpenCode agent runtime        | Task compiler and task IR                 |
| Native Desktop interface      | Workhorse task-control UI                 |
| Existing session management   | Execution state machine                   |
| Model/provider integration    | Model selection and budget policy         |
| Native skills and tools       | Deterministic skill policy                |
| Existing Git/worktree support | Dependency and integration scheduler      |
| Existing tool execution       | Verification scheduling and deduplication |
| Plugin persistence and events | Durable execution records and metrics     |

OpenRouter provides the model marketplace, but model selection must be based on measured completion efficiency, not just advertised pricing or intelligence.

We should keep the workhorse-specific logic portable enough that we aren't forced to fork OpenCode.

## 6. How we know we've succeeded

I would define success against your previous productive workflow rather than an arbitrary industry benchmark.

<box border radius="xl" padding={3} gap={3}>
  <text weight="medium">Initial engineering targets</text>
  <caption>Proposed targets to validate against baseline measurements, not existing performance claims.</caption>
  <grid columns={2} gap={3}>
    {#each [{v:"≥90%",l:"Scoped-task completion"},{v:"≤1",l:"Human intervention per task"},{v:"≤1",l:"Repair cycles by default"},{v:"≥2×",l:"Accepted work per dollar"}] as m}
      <grid-item>
        <box background="surface-secondary" radius="lg" padding={3} gap={1}>
          <title size="xl" tabularNums>{m.v}</title>
          <caption>{m.l}</caption>
        </box>
      </grid-item>
    {/each}
  </grid>
</box>

I'd also measure accepted work per hour, unnecessary verification calls, prompt-cache effectiveness, and the percentage of tasks that terminate without a complete implementation.

Those measurements tell us whether we're actually recovering the productivity you lost.

## 7. What we should do first

I would **not start by building the scheduler or desktop dashboard**.

I'd start by writing the contracts that make the system testable:

1. **Task IR:** What constitutes a complete, executable task?
2. **Execution state machine:** How does work move from specification through acceptance, failure, and recovery?
3. **Policy schema:** How are models, skills, tools, budgets, and verification selected?
4. **Acceptance protocol:** What must be true before the system declares success?
5. **Evaluation corpus:** Which real tasks will prove that this is better than stock OpenCode?

Then build the smallest vertical slice that exercises all five: one request, one task, one worker, one verification boundary, one accepted change, and complete cost/time accounting.

Only after that should we add parallelism, model routing, memory, hashline, or compound engineering.

---

## The mission, distilled

> **Workhorse exists to turn developer intent into accepted software changes with the least necessary reasoning, orchestration, human intervention, and compute.**
>
> It should know when to think, when to execute, when to verify, when to stop, and when to ask for help.
>
> Its success is measured in completed engineering work—not tokens generated, agents dispatched, or tools invoked.

That's the foundation I'd use to evaluate every feature we consider adding.
