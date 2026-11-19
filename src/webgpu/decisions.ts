import { Schema } from "effect"
import type { SystemOneQuestion } from "./system-one.ts"
import type { z } from "zod"
import type { SystemOneAnswer } from "./system-one.ts"

const DecisionSpec = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("boolean") }),
  Schema.Struct({
    kind: Schema.Literal("choice"),
    choices: Schema.Array(Schema.String.check(Schema.isBetweenLength(1, 64))).check(
      Schema.isBetweenLength(2, 20),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("score"), minimum: Schema.Finite, maximum: Schema.Finite }),
])
export type Decision = typeof DecisionSpec.Type
export const DECISION_CONTEXT_MAX_LENGTH = 6_000
export const DecisionRequest = Schema.Struct({
  question: Schema.String.check(Schema.isBetweenLength(1, 1_000)),
  context: Schema.String.check(Schema.isMaxLength(DECISION_CONTEXT_MAX_LENGTH)),
  decision: DecisionSpec,
  timeoutMs: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1_000, maximum: 120_000 }),
  ),
})
export type DecisionInput = typeof DecisionRequest.Type
export const DecisionResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
  Schema.Struct({
    ok: Schema.Literal(true),
    kind: Schema.Literal("boolean"),
    value: Schema.Boolean,
  }),
  Schema.Struct({ ok: Schema.Literal(true), kind: Schema.Literal("choice"), value: Schema.String }),
  Schema.Struct({ ok: Schema.Literal(true), kind: Schema.Literal("score"), value: Schema.Finite }),
])
export type TypedDecision = typeof DecisionResult.Type

export function decisionQuestion(input: DecisionInput): SystemOneQuestion {
  if (!input.question.trim()) throw new Error("A decision question is required")
  const spec = input.decision
  if (spec.kind === "choice" && new Set(spec.choices).size !== spec.choices.length)
    throw new Error("Decision choices must be unique")
  if (spec.kind === "score" && spec.minimum >= spec.maximum)
    throw new Error("Score minimum must be less than maximum")
  if (spec.kind === "boolean") return { type: "noul", instructions: input.question }
  if (spec.kind === "choice")
    return {
      type: "choice",
      instructions: input.question,
      criteria: Object.fromEntries(spec.choices.map((name) => [name, name])),
    }
  return {
    type: "score",
    instructions: input.question,
    criteria: [`${spec.minimum}: minimum`, `${spec.maximum}: maximum`],
  }
}

export function adaptDecision(
  spec: Decision,
  answer: z.infer<typeof SystemOneAnswer>,
): TypedDecision {
  if (spec.kind === "boolean" && answer.type === "noul") {
    if (answer.noul >= 0.7) return { ok: true, kind: "boolean", value: true }
    if (answer.noul <= 0.3) return { ok: true, kind: "boolean", value: false }
    return { ok: false, error: `Unresolved yes/no probability: ${answer.noul}` }
  }
  if (spec.kind === "choice" && answer.type === "choice" && spec.choices.includes(answer.choice))
    return { ok: true, kind: "choice", value: answer.choice }
  if (
    spec.kind === "score" &&
    answer.type === "score" &&
    spec.minimum < spec.maximum &&
    answer.score >= 0 &&
    answer.score <= 1
  )
    return {
      ok: true,
      kind: "score",
      value: spec.minimum * (1 - answer.score) + spec.maximum * answer.score,
    }
  return { ok: false, error: "Decision result does not match its request" }
}
