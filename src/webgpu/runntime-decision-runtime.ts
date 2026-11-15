import { loadRunntimeDecision, type ModelFileRead } from "./runntime-adapter.ts"
import { describe, SystemOneRequest, validateSystemOne } from "./system-one.ts"
import type { SystemOneInput } from "./system-one.ts"
import type { TraceStage, InferenceTraceMark } from "./inference-trace.ts"

type DecisionTrace = (stage: TraceStage, mark?: InferenceTraceMark) => Promise<void>

export async function loadDecisionRuntime(
  read: ModelFileRead,
  signal: AbortSignal,
  progress: (text: string) => void,
  lost: () => void,
  trace?: DecisionTrace,
) {
  await trace?.("session-create")
  const model = await loadRunntimeDecision({
    read,
    signal,
    onProgress: (_name, done, total) =>
      progress(`Loading ruNNtime d1 · ${Math.floor((done / total) * 100)}%`),
  })
  let disposing = false
  void model.lost.then(() => {
    if (!disposing) lost()
  })
  try {
    await trace?.("session-ready")
    signal.throwIfAborted()
  } catch (error) {
    disposing = true
    await model.dispose()
    throw error
  }
  return {
    dispose: () => {
      disposing = true
      return model.dispose()
    },
    loseDevice: model.loseDevice,
    async systemOne(input: SystemOneInput, signal: AbortSignal, trace?: DecisionTrace) {
      const request = SystemOneRequest.parse(input)
      const questions: Parameters<typeof model.engine.systemOne>[1] = {}
      const legends: Record<string, Record<string, string>> = {}
      for (const [name, question] of Object.entries(request.questions)) {
        const instructions = describe(question.instructions)
        if (question.type === "noul") {
          questions[name] = {
            type: question.type,
            instructions,
            ...(question.criteria
              ? {
                  criteria: {
                    true: describe(question.criteria.true),
                    false: describe(question.criteria.false),
                  },
                }
              : {}),
          }
        } else if (question.type === "choice") {
          questions[name] = {
            type: question.type,
            instructions,
            criteria: Object.fromEntries(
              Object.entries(question.criteria).map(([key, value]) => [
                key,
                value === null ? key.replaceAll("_", " ") : describe(value),
              ]),
            ),
          }
        } else {
          const criteria = question.criteria.map(describe)
          questions[name] = { type: question.type, instructions, criteria }
          legends[name] = Object.fromEntries(criteria.map((label, i) => [String(i), label]))
        }
      }
      await trace?.("generate", { questionCount: Object.keys(questions).length })
      const result = await model.engine.systemOne(describe(request.state), questions, { signal })
      return validateSystemOne(request, {
        model: request.model,
        answers: Object.fromEntries(
          Object.entries(result.answers).map(([name, answer]) => [
            name,
            answer.type === "score" ? { ...answer, legend: legends[name] } : answer,
          ]),
        ),
        usage: { input_tokens: result.inputTokens, output_tokens: 0 },
      })
    },
  }
}

export type DecisionRuntime = Awaited<ReturnType<typeof loadDecisionRuntime>>
