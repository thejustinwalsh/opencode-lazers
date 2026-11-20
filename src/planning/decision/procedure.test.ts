import { expect, test } from "bun:test"
import type { PlanningAgentId } from "../contract.ts"
import { AGENT_ORDER } from "./tree.ts"
import { OBSERVATIONS, observationQuestion } from "./observations.ts"
import { stateLimit } from "./constants.ts"
import { decide, type Answers, type Decider, type DecisionOutcome } from "./procedure.ts"

const fence = "```"
const fixture = [
  "## Goal",
  "Add a plan view.",
  "## Steps",
  "- store drafts",
  "- render breakdown",
  `${fence}ts`,
  "const a = 1. b = 2",
  fence,
  "Last paragraph one. Two. Three. Four. Five.",
].join("\n")

type Script = {
  size?: [number, number, number]
  agents?: number[]
  followUp?: number
  obs?: Record<string, number>
  breadth?: [number, number, number]
}
const FLAT = [0.5, 0.5, 0.5, 0.5, 0.5]

function harness(
  script: (state: string) => Script,
  options: { available?: ReturnType<Decider["available"]>; fail?: Error } = {},
) {
  let now = 0
  const seen: { state: string; questions: string[] }[] = []
  const decider: Decider = {
    id: "local",
    model: "stub",
    available: () => options.available ?? { ok: true },
    async ask(state, questions) {
      seen.push({ state, questions: Object.keys(questions) })
      now += 400
      if (options.fail) throw options.fail
      const s = script(state)
      const answers: Answers = {}
      for (const name of Object.keys(questions)) {
        if (name === "size") {
          const p = s.size ?? [0.1, 0.8, 0.1]
          answers.size = {
            type: "choice",
            choice: "x",
            probabilities: { "one task": p[0], "a few tasks": p[1], "a large effort": p[2] },
            confidence: Math.max(...p),
          }
        } else if (name === "breadth") {
          const p = s.breadth ?? [0.8, 0.15, 0.05]
          answers.breadth = {
            type: "score",
            probabilities: { "0": p[0], "1": p[1], "2": p[2] },
          }
        } else if (OBSERVATIONS.some((o) => o.id === name)) {
          answers[name] = { type: "noul", noul: s.obs?.[name] ?? 0.1 }
        } else if (name === "agents") {
          const p = s.agents ?? FLAT
          answers.agents = {
            type: "choice",
            choice: "x",
            probabilities: Object.fromEntries(AGENT_ORDER.map((id, i) => [id, p[i]!])),
            confidence: 0.5,
          }
        } else if (name.startsWith("agent:")) {
          const id = name.slice(6) as PlanningAgentId
          answers[name] = {
            type: "noul",
            noul: (s.agents ?? FLAT)[AGENT_ORDER.indexOf(id)]!,
          }
        } else answers[name] = { type: "noul", noul: s.followUp ?? 0.2 }
      }
      return { answers, inputTokens: Math.ceil(state.length / 3) }
    },
  }
  const run = (ask: string, constants: Parameters<typeof decide>[1]["constants"] = {}) =>
    decide(ask, {
      decider,
      clock: () => now,
      // The old per-agent forms, which these tests cover; the observation form has its own tests.
      constants: { agentForm: "yesno", ...constants },
      signal: new AbortController().signal,
    })
  /** The default form: observations. */
  const runObservations = (
    ask: string,
    constants: Parameters<typeof decide>[1]["constants"] = {},
  ) =>
    decide(ask, {
      decider,
      clock: () => now,
      constants,
      signal: new AbortController().signal,
    })
  return { run, runObservations, seen }
}

const decided = (outcome: DecisionOutcome) => {
  if (outcome.status !== "decided") throw new Error(`not decided: ${outcome.status}`)
  return outcome
}

test("the default asks one small question per request over windows of four sentences", () => {
  const ask = "A one. B two. C three. D four. E five. F six. G seven."
  const { run, seen } = harness(() => ({}))
  return run(ask).then((outcome) => {
    const result = decided(outcome)
    expect(result.nodes.map((n) => n.outcome)).toEqual(["pre-sliced", "pre-sliced"])
    expect(seen).toHaveLength(12)
    expect(seen.every((call) => call.questions.length === 1)).toBe(true)
    expect(seen[0]!.state).toBe("A one. B two. C three. D four.")
    expect(seen[6]!.state).toBe("D four. E five. F six. G seven.")
    expect(result.selected).toEqual([...AGENT_ORDER])
    expect(result.size).toBe("a few tasks")
    expect(result.modelMs).toBe(12 * 400)
  })
})

test("no request carries more state than the input bound allows", async () => {
  const ask = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} says a thing.`).join(" ")
  const { run, seen } = harness(() => ({}))
  decided(await run(ask))
  expect(seen.length).toBeGreaterThan(6)
  expect(Math.max(...seen.map((c) => c.state.length))).toBeLessThanOrEqual(stateLimit().maxChars)
})

test("batching sends one request per piece when enabled", async () => {
  const { run, seen } = harness(() => ({}))
  decided(await run("Fix it. Then this.", { batch: true }))
  expect(seen).toHaveLength(1)
  expect(seen[0]!.questions).toHaveLength(6)
})

test("a threshold selects by combined score; the default cuts nothing", async () => {
  const scripted = (state: string): Script =>
    state.startsWith("A")
      ? { agents: [0.1, 0.9, 0.5, 0.2, 0.3] }
      : { agents: [0.6, 0.1, 0.5, 0.2, 0.3] }
  const ask = "A one. B two. C three. D four. E five. F six. G seven."
  const cut = decided(await harness(scripted).run(ask, { agentThreshold: 0.55 }))
  expect(cut.selected).toEqual(["comprehension", "grounding"])
  expect(cut.scores.comprehension).toMatchObject({ score: 0.6, nodeID: "1" })
  expect(decided(await harness(scripted).run(ask)).selected).toHaveLength(5)
})

test("a simple ask stops at its root with the answers recorded", async () => {
  const { run } = harness(() => ({ size: [0.8, 0.15, 0.05] }))
  const result = decided(await run("Fix the typo in README.", { strategy: "whole" }))
  expect(result.nodes).toHaveLength(1)
  expect(result.nodes[0]).toMatchObject({ id: "0", outcome: "simple" })
  expect(result.size).toBe("one task")
})

test("the 5-way choice form is one agents question", async () => {
  const { run, seen } = harness(() => ({ agents: [0.05, 0.45, 0.38, 0.06, 0.06] }))
  const result = decided(
    await run("Fix the typo in README.", { strategy: "whole", agentForm: "choice", batch: true }),
  )
  expect(seen[0]!.questions).toEqual(["size", "agents"])
  expect(result.scores.grounding.score).toBe(0.45)
})

test("uncertainty splits a flat root along the document's structure", async () => {
  const script = (state: string): Script => {
    if (state === fixture) return { size: [0.05, 0.8, 0.15] }
    if (state.startsWith("## Goal")) return { agents: [0.05, 0.9, 0.7, 0.07, 0.07] }
    return { agents: [0.06, 0.06, 0.06, 0.95, 0.12] }
  }
  const { run, seen } = harness(script)
  const result = decided(await run(fixture, { strategy: "uncertainty", batch: true }))
  expect(result.nodes.map((n) => [n.id, n.outcome])).toEqual([
    ["0", "expanded"],
    ["0.0", "confident"],
    ["0.1", "confident"],
  ])
  // Root: one batch plus the existing-code follow-up; children ask agents only.
  expect(result.nodes[1]!.calls[0]!.questions).not.toContain("size")
  expect(seen).toHaveLength(4)
  expect(result.scores.grounding).toMatchObject({ score: 0.9, nodeID: "0.0" })
  expect(result.scores.critic).toMatchObject({ score: 0.95, nodeID: "0.1" })
  expect(result.scores.comprehension.nodeID).toBe("0.1")
})

test("a follow-up raises an agent's floor", async () => {
  const { run } = harness(() => ({
    size: [0.05, 0.15, 0.8],
    agents: [0.3, 0.3, 0.3, 0.05, 0.9],
    followUp: 0.85,
  }))
  const result = decided(await run("One. Two.", { strategy: "whole", batch: true }))
  expect(result.nodes[0]!.calls.map((c) => c.questions)).toEqual([
    [
      "size",
      "agent:comprehension",
      "agent:grounding",
      "agent:readiness",
      "agent:critic",
      "agent:zoom-out",
    ],
    ["followup:stored-data"],
  ])
  expect(result.scores.critic.score).toBe(0.22)
})

test("a beam expands the worst pieces and prunes the rest", async () => {
  const para = (n: string) =>
    `${n} one is here. ${n} two is here. ${n} three is here. `.repeat(3).trim()
  const ask = [para("A"), para("B"), para("C")].join("\n\n")
  const { run } = harness(() => ({}))
  const result = decided(
    await run(ask, {
      strategy: "uncertainty",
      batch: true,
      charsPerToken: 10,
      maxInputTokens: 150,
      questionReserveTokens: 100,
      beamWidth: 1,
      maxDepth: 1,
    }),
  )
  const roots = result.nodes.filter((n) => n.depth === 0).map((n) => n.outcome)
  expect(roots.filter((o) => o === "expanded")).toHaveLength(1)
  expect(roots.filter((o) => o === "pruned")).toHaveLength(roots.length - 1)
  expect(result.nodes.some((n) => n.outcome === "depth-stop")).toBe(true)
  expect(result.stopped).toBe("depth-bound")
})

test("the model-time budget leaves later pieces unscored", async () => {
  const { run } = harness(() => ({ size: [0.05, 0.8, 0.15] }))
  const result = decided(
    await run(fixture, { strategy: "uncertainty", batch: true, budgetMs: 1_300 }),
  )
  expect(result.stopped).toBe("budget")
  expect(result.nodes.map((n) => n.outcome)).toContain("budget-stop")
  const unscored = harness(() => ({}))
  const none = await unscored.run("One. Two.", { budgetMs: 1_000 })
  expect(none).toMatchObject({ status: "unavailable", reason: "budget" })
  expect(unscored.seen).toHaveLength(2)
})

test("no window: unavailable, no call, no model time", async () => {
  const { run, seen } = harness(() => ({}), { available: { ok: false, reason: "no-window" } })
  expect(await run("Anything.")).toEqual({
    status: "unavailable",
    reason: "no-window",
    nodes: [],
    modelMs: 0,
  })
  expect(seen).toHaveLength(0)
})

test("a decider error fails soft; an engine refusal marks the piece oversize", async () => {
  const failing = await harness(() => ({}), { fail: new Error("boom") }).run("One. Two.")
  expect(failing).toMatchObject({ status: "unavailable", reason: "error", error: "boom" })
  const refused = await harness(() => ({}), {
    fail: new Error("D1 prompt exceeds its 16384-token context"),
  }).run("One. Two.")
  expect(refused).toMatchObject({ status: "unavailable", reason: "over-limit" })
  expect(refused.nodes[0]!.outcome).toBe("skipped-oversize")
})

test("the procedure is deterministic", async () => {
  const run = () => harness(() => ({})).run(fixture, { strategy: "uncertainty" })
  expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()))
})

test("observations: one yes/no per request, with criteria, under the input bound, then a breadth score", async () => {
  const { runObservations, seen } = harness(() => ({}))
  const result = decided(await runObservations("Fix the typo in README. It is wrong."))
  expect(seen).toHaveLength(OBSERVATIONS.length + 1)
  expect(seen.map((call) => call.questions)).toEqual([
    ...OBSERVATIONS.map((o) => [o.id]),
    ["breadth"],
  ])
  const limit = stateLimit().maxChars
  for (const observation of OBSERVATIONS) {
    const question = observationQuestion(observation)
    expect(question).toMatchObject({
      type: "noul",
      criteria: { true: expect.any(String), false: expect.any(String) },
    })
    // State at the limit plus the question, at the assumed characters per token.
    expect((limit + JSON.stringify(question).length) / 3).toBeLessThanOrEqual(400)
  }
  expect(result.sizeReliable).toBe(false)
})

test("the rule table maps observation scores to bands: max over pieces, then the rule, no guard", async () => {
  const scripted = (state: string): Script => ({
    obs: state.startsWith("A")
      ? { names_code: 0.91, open_choice: 0.52, wording_only: 0.95, stored_data: 0.2 }
      : { names_code: 0.4, stored_data: 0.1, adds_new: 0.75, may_exist: 0.25 },
  })
  const ask = "A one. B two. C three. D four. E five. F six. G seven."
  const { runObservations } = harness(scripted)
  const result = decided(await runObservations(ask, { budgetMs: 1e9 }))
  expect(result.observations!.names_code).toEqual({ score: 0.91, nodeID: "0" })
  expect(result.observations!.adds_new).toEqual({ score: 0.75, nodeID: "1" })
  const bands = Object.fromEntries(AGENT_ORDER.map((id) => [id, result.scores[id].band]))
  // wording_only is 0.95 and still does not zero anything.
  expect(bands).toEqual({
    comprehension: "no",
    grounding: "yes",
    readiness: "architect",
    critic: "no",
    "zoom-out": "yes",
  })
  expect(result.scores.grounding).toMatchObject({ score: 0.91, from: "names_code" })
  expect(result.selected).toEqual([...AGENT_ORDER])
})

test("many pieces make comprehension a yes by themselves; size is recorded from changes and pieces", async () => {
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} says a thing.`).join(" ")
  const { runObservations } = harness(() => ({ breadth: [0.05, 0.2, 0.75] }))
  const result = decided(await runObservations(long, { budgetMs: 1e9 }))
  expect(result.nodes.filter((n) => n.depth === 0).length).toBeGreaterThanOrEqual(8)
  expect(result.scores.comprehension).toMatchObject({ score: 1, band: "yes", from: "pieces" })
  expect(result.size).toBe("a large effort")
})

test("the observation form fails soft like the others", async () => {
  const { runObservations } = harness(() => ({}))
  const gone = await decide("Anything.", {
    decider: {
      id: "local",
      model: "x",
      available: () => ({ ok: false, reason: "no-window" }),
      ask: async () => ({ answers: {}, inputTokens: 0 }),
    },
    clock: () => 0,
    signal: new AbortController().signal,
  })
  expect(gone).toMatchObject({ status: "unavailable", reason: "no-window" })
  void runObservations
})
