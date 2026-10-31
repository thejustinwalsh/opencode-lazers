import { expect, test } from "bun:test"
import { adaptDecision, decisionQuestion } from "./decisions.ts"
import {
  probabilities,
  readAnswer,
  renderQuestion,
  SystemOneRequest,
  validateSystemOne,
  systemOneClient,
} from "./system-one.ts"

test("d1 probabilities use pinned temperature and preserve ambiguous nouls", () => {
  const p = probabilities([4, 0], 2)
  expect(p[0]).toBeCloseTo(0.880797, 5)
  expect(p.reduce((a, b) => a + b)).toBeCloseTo(1)
  expect(() => probabilities([NaN, 0], 1)).toThrow()
  expect(() => probabilities([1, 0], Infinity)).toThrow()
  expect(adaptDecision({ kind: "boolean" }, { type: "noul", noul: 0.5 }).ok).toBe(false)
  expect(adaptDecision({ kind: "boolean" }, { type: "noul", noul: 0.95 })).toEqual({
    ok: true,
    kind: "boolean",
    value: true,
  })
  expect(adaptDecision({ kind: "boolean" }, { type: "noul", noul: 0.05 })).toEqual({
    ok: true,
    kind: "boolean",
    value: false,
  })
  const midpoint = adaptDecision(
    { kind: "score", minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE },
    {
      type: "score",
      score: 0.5,
      probabilities: { "0": 0.5, "1": 0.5 },
      legend: { "0": "low", "1": "high" },
      confidence: 0.5,
    },
  )
  expect(midpoint).toEqual({ ok: true, kind: "score", value: 0 })
})

test("typed and server callers reject plausible but mismatched decision payloads", async () => {
  const request = {
    model: "d1-omni-2b" as const,
    state: { status: "open" },
    questions: {
      route: {
        type: "choice" as const,
        instructions: "Route?",
        criteria: { a: "Open", b: "Closed" },
      },
      score: { type: "score" as const, instructions: "Level?", criteria: ["Low", "High"] },
    },
  }
  const output = {
    model: "d1-omni-2b" as const,
    answers: {
      route: readAnswer(request.questions.route, [0.8, 0.2]),
      score: readAnswer(request.questions.score, [0.4, 0.6]),
    },
    usage: { input_tokens: 12, output_tokens: 0 as const },
  }
  expect(validateSystemOne(request, output)).toEqual(output)
  const invalid = [
    { ...output, answers: { ...output.answers, route: { type: "noul", noul: 1 } } },
    { ...output, answers: { ...output.answers, route: { ...output.answers.route, choice: "b" } } },
    {
      ...output,
      answers: { ...output.answers, route: { ...output.answers.route, confidence: 1 } },
    },
    { ...output, answers: { ...output.answers, score: { ...output.answers.score, score: 9 } } },
    {
      ...output,
      answers: {
        ...output.answers,
        score: { ...output.answers.score, legend: { "0": "Invented", "1": "High" } },
      },
    },
    { ...output, answers: { ...output.answers, other: output.answers.route } },
  ]
  for (const result of invalid) expect(() => validateSystemOne(request, result)).toThrow()
  const client = systemOneClient({ systemOne: async () => ({ ...output, answers: {} }) })
  await expect(client.systemOne(request)).rejects.toThrow("names")
})

test("System One preserves named options, rubric positions, and actual distributions", () => {
  const choice = {
    type: "choice" as const,
    instructions: "Which team?",
    criteria: { billing: "Charges", technical: "Bugs" },
  }
  expect(renderQuestion(choice, ["A", "B"])).toBe(
    "Which team?\n\nOptions:\nA Charges\nB Bugs\n\nReply with the option code only.",
  )
  expect(readAnswer(choice, [0.1, 0.9])).toEqual({
    type: "choice",
    choice: "technical",
    confidence: 0.9,
    probabilities: { billing: 0.1, technical: 0.9 },
  })
  const score = readAnswer(
    { type: "score", instructions: "Urgency?", criteria: ["Can wait", "Today", "Now"] },
    [0.1, 0.6, 0.3],
  )
  expect(score.type === "score" && score.score).toBeCloseTo(1.2)
  expect(score.type === "score" && score.legend).toEqual({
    "0": "Can wait",
    "1": "Today",
    "2": "Now",
  })
})

test("unsupported primitives, empty question maps, and invalid convenience schemas fail explicitly", () => {
  expect(
    SystemOneRequest.safeParse({ model: "d1-omni-2b", state: "s", questions: {} }).success,
  ).toBe(false)
  expect(
    SystemOneRequest.safeParse({
      model: "jev-latest",
      state: "s",
      questions: { q: { type: "noul", instructions: "Q?" } },
    }).success,
  ).toBe(false)
  expect(
    SystemOneRequest.safeParse({
      model: "d1-omni-2b",
      state: "s",
      questions: { q: { type: "box", instructions: "Q?" } },
    }).success,
  ).toBe(false)
  for (const decision of [
    { kind: "choice" as const, choices: ["a", "a"] },
    { kind: "score" as const, minimum: 5, maximum: 1 },
  ])
    expect(() =>
      decisionQuestion({ question: "Q?", context: "s", timeoutMs: 1000, decision }),
    ).toThrow()
})
