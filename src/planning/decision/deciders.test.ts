import { expect, test } from "bun:test"
import { agentChoiceQuestion } from "./tree.ts"
import { deciderFor, externalDecider, localDecider } from "./deciders.ts"

const signal = new AbortController().signal

test("the local decider declines at once without a window, and never calls the model", async () => {
  let calls = 0
  const decider = localDecider(
    { attached: () => false },
    () => true,
    async () => {
      calls++
      return { error: "unreachable" }
    },
  )
  expect(decider.available()).toEqual({ ok: false, reason: "no-window" })
  expect(calls).toBe(0)
  const off = localDecider(
    { attached: () => true },
    () => false,
    async () => ({ error: "" }),
  )
  expect(off.available()).toEqual({ ok: false, reason: "feature-off" })
})

test("the local decider maps System One answers and reports input tokens", async () => {
  const decider = localDecider(
    { attached: () => true },
    () => true,
    async (input) => {
      expect(input.timeoutMs).toBe(10_000)
      return {
        answers: {
          a: { type: "noul", noul: 0.7 },
          b: { type: "choice", choice: "x", probabilities: { x: 1 }, confidence: 1 },
        },
        usage: { input_tokens: 95 },
      }
    },
  )
  expect(decider.available()).toEqual({ ok: true })
  const reply = await decider.ask("state", {}, signal)
  expect(reply.inputTokens).toBe(95)
  expect(reply.answers.a).toEqual({ type: "noul", noul: 0.7 })
})

test("the external mapping keeps a 5-way choice's keys and probabilities", async () => {
  let sent: unknown
  const decider = externalDecider(
    async (input) => {
      sent = input
      return {
        answers: [
          {
            type: "choice",
            name: "agents",
            choice: "critic",
            probabilities: ["comprehension", "grounding", "readiness", "critic", "zoom-out"].map(
              (value) => ({ value, probability: 0.2 }),
            ),
            confidence: 0.2,
          },
        ],
        tokens: { input: 80 },
      }
    },
    { providerID: "openrouter", modelID: "m" },
  )
  const reply = await decider.ask("state", { agents: agentChoiceQuestion() }, signal)
  const question = (sent as { questions: { choices: { value: string }[] }[] }).questions[0]!
  expect(question.choices.map((c) => c.value)).toHaveLength(5)
  const answer = reply.answers.agents as { probabilities: Record<string, number> }
  expect(Object.keys(answer.probabilities)).toHaveLength(5)
  expect(Object.values(answer.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  expect(reply.inputTokens).toBe(80)
})

test("a model the host refuses makes the external decider unavailable", async () => {
  const refusal = Object.assign(new Error("no"), { _tag: "UnsupportedModelError" })
  const decider = externalDecider(
    async () => {
      throw refusal
    },
    { providerID: "p", modelID: "m" },
  )
  expect(decider.available()).toEqual({ ok: true })
  await expect(decider.ask("s", {}, signal)).rejects.toThrow()
  expect(decider.available()).toEqual({ ok: false, reason: "no-model" })
})

test("deciderFor returns nothing for the architect setting", () => {
  expect(deciderFor({ kind: "architect" }, {})).toBeUndefined()
  expect(deciderFor({ kind: "external", providerID: "p", modelID: "m" }, {})).toBeUndefined()
})
