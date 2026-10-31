import { z } from "zod"

const content = z.union([z.string(), z.record(z.string(), z.json()), z.array(z.json())])
const question = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("noul"),
    instructions: content,
    criteria: z.object({ true: content, false: content }).nullish(),
  }),
  z.strictObject({
    type: z.literal("choice"),
    instructions: content,
    criteria: z
      .record(z.string().min(1).max(64), content.nullable())
      .refine(
        (value) => Object.keys(value).length >= 2 && Object.keys(value).length <= 20,
        "Use 2–20 choices",
      ),
  }),
  z.strictObject({
    type: z.literal("score"),
    instructions: content,
    criteria: z.array(content).min(2).max(10),
  }),
])
export const SystemOneRequest = z
  .strictObject({
    model: z.literal("d1-omni-2b"),
    state: content,
    questions: z
      .record(z.string().min(1).max(100), question)
      .refine(
        (value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 16,
        "Use 1–16 questions",
      ),
    timeoutMs: z.int().min(1_000).max(120_000).default(60_000),
  })
  .refine(
    (value) => JSON.stringify(value).length <= 8_000,
    "Decision request exceeds 8,000 characters",
  )
export type SystemOneInput = z.input<typeof SystemOneRequest>
export type SystemOneQuestion = z.infer<typeof question>
const probability = z.number().min(0).max(1)
export const SystemOneAnswer = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("noul"), noul: probability }),
  z.strictObject({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), probability),
    confidence: probability,
  }),
  z.strictObject({
    type: z.literal("score"),
    score: z.number(),
    probabilities: z.record(z.string(), probability),
    legend: z.record(z.string(), z.string()),
    confidence: probability,
  }),
])
export const SystemOneSuccess = z.strictObject({
  model: z.literal("d1-omni-2b"),
  answers: z.record(z.string(), SystemOneAnswer),
  usage: z.strictObject({ input_tokens: z.int().min(0), output_tokens: z.literal(0) }),
})
export const SystemOneResult = z.union([SystemOneSuccess, z.strictObject({ error: z.string() })])
export type SystemOneOutput = z.infer<typeof SystemOneSuccess>

export type AnswersFor<Q extends Record<string, SystemOneQuestion>> = {
  [K in keyof Q]: Q[K] extends { type: "noul" }
    ? { type: "noul"; noul: number }
    : Q[K] extends { type: "choice"; criteria: infer C }
      ? {
          type: "choice"
          choice: Extract<keyof C, string>
          probabilities: Record<Extract<keyof C, string>, number>
          confidence: number
        }
      : {
          type: "score"
          score: number
          probabilities: Record<string, number>
          legend: Record<string, string>
          confidence: number
        }
}

/** SDK-style type inference over OpenCode RPC. Errors throw, never become a decision. */
export function systemOneClient(transport: {
  systemOne(
    input: SystemOneInput,
    options?: { signal?: AbortSignal },
  ): Promise<z.infer<typeof SystemOneResult>>
}) {
  return {
    async systemOne<const Q extends Record<string, SystemOneQuestion>>(
      input: Omit<SystemOneInput, "questions"> & { questions: Q },
      options?: { signal?: AbortSignal },
    ): Promise<Omit<SystemOneOutput, "answers"> & { answers: AnswersFor<Q> }> {
      const request = SystemOneRequest.parse(input)
      const result = await transport.systemOne(request, options)
      if ("error" in result) throw new Error(result.error)
      const output = validateSystemOne(request, result)
      return output as Omit<SystemOneOutput, "answers"> & { answers: AnswersFor<Q> }
    },
  }
}

/** Validate semantic correspondence as well as shape before any caller can use a decision. */
export function validateSystemOne(input: SystemOneInput, result: unknown): SystemOneOutput {
  const request = SystemOneRequest.parse(input)
  const output = SystemOneSuccess.parse(result)
  if (Object.keys(output.answers).length !== Object.keys(request.questions).length)
    throw new Error("Decision answer names do not match the request")
  for (const [name, q] of Object.entries(request.questions)) {
    const answer = output.answers[name]
    if (!Object.hasOwn(output.answers, name) || !answer || answer.type !== q.type)
      throw new Error("Decision answer type does not match the question")
    if (
      answer.type === "choice" &&
      q.type === "choice" &&
      !Object.hasOwn(q.criteria, answer.choice)
    )
      throw new Error("Decision chose an undeclared option")
    if (answer.type !== "noul") {
      const keys =
        q.type === "choice"
          ? Object.keys(q.criteria)
          : q.type === "score"
            ? q.criteria.map((_, i) => String(i))
            : []
      if (
        Object.keys(answer.probabilities).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(answer.probabilities, key)) ||
        Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) > 0.00001
      )
        throw new Error("Decision distribution does not match the question")
      const distribution = Object.values(answer.probabilities)
      const maximum = Math.max(...distribution)
      if (Math.abs(answer.confidence - maximum) > 0.00001)
        throw new Error("Decision confidence does not match its distribution")
      if (
        answer.type === "choice" &&
        Math.abs(answer.probabilities[answer.choice]! - maximum) > 0.00001
      )
        throw new Error("Decision choice does not match its distribution")
      if (answer.type === "score" && q.type === "score") {
        const expected = keys.reduce((sum, key, i) => sum + answer.probabilities[key]! * i, 0)
        if (
          Math.abs(answer.score - expected) > 0.00001 ||
          Object.keys(answer.legend).length !== keys.length ||
          keys.some((key, i) => answer.legend[key] !== describe(q.criteria[i]))
        )
          throw new Error("Decision score or legend does not match its rubric")
      }
    }
  }
  return output
}

/** Port of LiquidAI's prompt.py/api.py for the three core text primitives; not generated JSON. */
export function probabilities(scores: readonly number[], temperature: number): number[] {
  if (
    !scores.length ||
    scores.some((n) => !Number.isFinite(n)) ||
    !Number.isFinite(temperature) ||
    !(temperature > 0)
  )
    throw new Error("Invalid decision logits")
  const maximum = Math.max(...scores)
  const exps = scores.map((n) => Math.exp((n - maximum) / temperature))
  const sum = exps.reduce((a, b) => a + b, 0)
  return exps.map((n) => n / sum)
}

export function readAnswer(q: SystemOneQuestion, probs: number[]): z.infer<typeof SystemOneAnswer> {
  if (q.type === "noul") return { type: "noul", noul: probs[0]! }
  const best = probs.indexOf(Math.max(...probs))
  if (q.type === "choice") {
    const names = Object.keys(q.criteria)
    return {
      type: "choice",
      choice: names[best]!,
      confidence: probs[best]!,
      probabilities: Object.fromEntries(names.map((name, i) => [name, probs[i]!])),
    }
  }
  return {
    type: "score",
    score: probs.reduce((sum, p, i) => sum + p * i, 0),
    confidence: probs[best]!,
    probabilities: Object.fromEntries(probs.map((p, i) => [String(i), p])),
    legend: Object.fromEntries(q.criteria.map((text, i) => [String(i), describe(text)])),
  }
}

export const describe = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2)

export function renderQuestion(q: SystemOneQuestion, codes: readonly string[]): string {
  const text = describe(q.instructions)
  if (q.type === "noul")
    return `${text}${q.criteria ? `\nYes: ${describe(q.criteria.true)}\nNo: ${describe(q.criteria.false)}` : ""}\n\nReply with yes or no only.`
  if (q.type === "score")
    return `${text}\n\n${q.criteria.map((level, i) => `${i} ${describe(level)}`).join("\n")}\n\nReply with a single digit 0-${q.criteria.length - 1} only.`
  return `${text}\n\nOptions:\n${Object.entries(q.criteria)
    .map(
      ([name, description], i) =>
        `${codes[i]} ${description ? describe(description) : name.replaceAll("_", " ")}`,
    )
    .join("\n")}\n\nReply with the option code only.`
}
