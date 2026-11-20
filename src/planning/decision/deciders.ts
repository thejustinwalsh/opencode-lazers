import type { SystemOneInput, SystemOneQuestion } from "../../webgpu/system-one.ts"
import type { Answers, Decider } from "./procedure.ts"

/** The longest the local model may take on one small request; the procedure's budget is wider. */
export const LOCAL_REQUEST_TIMEOUT_MS = 10_000

type SystemOneReply =
  | { error: string }
  | {
      answers: Record<string, { type: string } & Record<string, unknown>>
      usage: { input_tokens: number }
    }

/**
 * The local model, through the `systemOne` RPC. It declines at once when no Desktop window is
 * attached or the "decisions" feature is off, instead of waiting for the broker's deadline.
 */
export function localDecider(
  broker: { attached(): boolean },
  featureOn: () => boolean,
  systemOne: (input: SystemOneInput, signal: AbortSignal) => Promise<SystemOneReply>,
  model = "d1-omni-2b",
): Decider {
  return {
    id: "local",
    model,
    available: () =>
      !featureOn()
        ? { ok: false, reason: "feature-off" }
        : !broker.attached()
          ? { ok: false, reason: "no-window" }
          : { ok: true },
    async ask(state, questions, signal) {
      const reply = await systemOne(
        { model: "d1-omni-2b", state, questions, timeoutMs: LOCAL_REQUEST_TIMEOUT_MS },
        signal,
      )
      if ("error" in reply) throw new Error(reply.error)
      const answers: Answers = {}
      for (const [name, answer] of Object.entries(reply.answers)) {
        if (answer.type === "noul") answers[name] = { type: "noul", noul: answer.noul as number }
        else if (answer.type === "choice")
          answers[name] = {
            type: "choice",
            choice: answer.choice as string,
            probabilities: answer.probabilities as Record<string, number>,
            confidence: answer.confidence as number,
          }
        else if (answer.type === "score")
          answers[name] = {
            type: "score",
            probabilities: answer.probabilities as Record<string, number>,
          }
      }
      return { answers, inputTokens: reply.usage.input_tokens }
    },
  }
}

type ExternalQuestion =
  | {
      type: "predicate"
      name: string
      instructions: string
      criteria?: { true?: string; false?: string }
    }
  | {
      type: "choice"
      name: string
      instructions: string
      choices: { value: string; description?: string }[]
    }
  | { type: "score"; name: string; instructions: string; levels: { label: string }[] }
type ExternalAnswer =
  | { type: "predicate"; name: string; probability: number }
  | {
      type: "choice"
      name: string
      choice: string | boolean
      probabilities: { value: string | boolean; probability: number }[]
      confidence: number
    }
  | {
      type: "score"
      name: string
      probabilities: { value: number; label: string; probability: number }[]
    }
  | { type: "error"; name: string; reason: string; message?: string }

/** The host's `generate.decisions`, narrowed to what the decider sends and reads. */
export type ExternalGenerate = (
  input: {
    model: { providerID: string; id: string }
    input: { type: "text"; text: string }[]
    questions: ExternalQuestion[]
  },
  signal: AbortSignal,
) => Promise<{ answers: ExternalAnswer[]; tokens?: { input?: number } }>

const isModelRefusal = (error: unknown) => {
  const tag = error && typeof error === "object" ? (error as { _tag?: unknown })._tag : undefined
  return tag === "UnsupportedModelError" || tag === "ModelNotFoundError"
}

function externalQuestion(name: string, question: SystemOneQuestion): ExternalQuestion {
  const instructions =
    typeof question.instructions === "string"
      ? question.instructions
      : JSON.stringify(question.instructions)
  if (question.type === "noul")
    return {
      type: "predicate",
      name,
      instructions,
      ...(question.criteria
        ? {
            criteria: {
              true: String(question.criteria.true),
              false: String(question.criteria.false),
            },
          }
        : {}),
    }
  if (question.type === "choice")
    return {
      type: "choice",
      name,
      instructions,
      choices: Object.entries(question.criteria).map(([value, description]) => ({
        value,
        ...(description ? { description: String(description) } : {}),
      })),
    }
  return {
    type: "score",
    name,
    instructions,
    levels: question.criteria.map((level) => ({ label: String(level) })),
  }
}

/**
 * A catalogue model through the host. A model the host refuses as a decision model makes the
 * decider unavailable for the rest of the process.
 */
export function externalDecider(
  generate: ExternalGenerate,
  model: { providerID: string; modelID: string },
): Decider {
  let refused = false
  return {
    id: "external",
    model: `${model.providerID}/${model.modelID}`,
    available: () => (refused ? { ok: false, reason: "no-model" } : { ok: true }),
    async ask(state, questions, signal) {
      let result: Awaited<ReturnType<ExternalGenerate>>
      try {
        result = await generate(
          {
            model: { providerID: model.providerID, id: model.modelID },
            input: [{ type: "text", text: state }],
            questions: Object.entries(questions).map(([name, q]) => externalQuestion(name, q)),
          },
          signal,
        )
      } catch (error) {
        if (isModelRefusal(error)) refused = true
        throw error
      }
      const answers: Answers = {}
      for (const answer of result.answers) {
        if (answer.type === "error") throw new Error(`${answer.reason}: ${answer.message ?? ""}`)
        if (answer.type === "predicate")
          answers[answer.name] = { type: "noul", noul: answer.probability }
        else if (answer.type === "score")
          answers[answer.name] = {
            type: "score",
            probabilities: Object.fromEntries(
              answer.probabilities.map((p) => [String(p.value), p.probability]),
            ),
          }
        else if (answer.type === "choice")
          answers[answer.name] = {
            type: "choice",
            choice: String(answer.choice),
            probabilities: Object.fromEntries(
              answer.probabilities.map((p) => [String(p.value), p.probability]),
            ),
            confidence: answer.confidence,
          }
      }
      return { answers, inputTokens: result.tokens?.input ?? 0 }
    },
  }
}

export type DecisionModelSetting =
  | { kind: "local" }
  | { kind: "external"; providerID: string; modelID: string }
  | { kind: "architect" }

/** `undefined` when no decision model is configured; the step then records `unavailable: no-model`. */
export function deciderFor(
  setting: DecisionModelSetting,
  parts: { local?: Decider; generate?: ExternalGenerate },
): Decider | undefined {
  if (setting.kind === "local") return parts.local
  if (setting.kind === "external" && parts.generate) return externalDecider(parts.generate, setting)
  return undefined
}
