import * as ort from "onnxruntime-web/webgpu"
import { Tokenizer } from "@huggingface/tokenizers"
import wasmURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url"
import mjsURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url"
import { DECISION_FILES } from "./manifest.ts"
import { cachedRange } from "./files-fetch.ts"
import {
  describe,
  probabilities,
  readAnswer,
  renderQuestion,
  SystemOneRequest,
} from "./system-one.ts"
import type { SystemOneInput, SystemOneOutput } from "./system-one.ts"
import { withResources } from "./resources.ts"
import type { TraceStage, InferenceTraceMark } from "./inference-trace.ts"
import { CleanupUncertainError } from "./lifecycle.ts"
import { isOrtWebGpuDeviceLoss } from "./decision-loss.ts"

type DecisionTrace = (stage: TraceStage, mark?: InferenceTraceMark) => Promise<void>

export const DECISION_CONTEXT_CAPACITY_TOKENS = 8_192

export async function loadDecisionRuntime(
  read: (id: string, offset: number, length: number) => Promise<string>,
  signal: AbortSignal,
  progress: (text: string) => void,
  lost: () => void,
  trace?: DecisionTrace,
) {
  const bytes = async (id: string) => {
    signal.throwIfAborted()
    const file = DECISION_FILES.find((file) => file.id === id)!
    const result = new Uint8Array(file.bytes)
    let offset = 0
    for await (const chunk of cachedRange(read, id, 0, file.bytes - 1, signal)) {
      signal.throwIfAborted()
      result.set(chunk, offset)
      offset += chunk.length
      progress(`Loading decision model · ${Math.floor((offset / file.bytes) * 100)}%`)
    }
    return result
  }
  const json = async (id: string) => JSON.parse(new TextDecoder().decode(await bytes(id)))
  const tokenizer = new Tokenizer(await json("tokenizer"), await json("tokenizerConfig"))
  const calibration: { default: number } = await json("calibration")
  probabilities([0, 0], calibration.default)
  signal.throwIfAborted()
  const special = [...tokenizer.get_added_tokens_decoder().values()]
    .filter((token) => token.special)
    .map((token) => token.content)
    .sort((a, b) => b.length - a.length)
  const plain = (text: string) => {
    for (const token of special) text = text.replaceAll(token, `${token[0]}\u200b${token.slice(1)}`)
    return text
  }
  const encode = (text: string) => tokenizer.encode(text, { add_special_tokens: false }).ids
  ort.env.wasm.numThreads = 1
  ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: mjsURL }
  const device = await navigator.gpu.requestAdapter().then((adapter) => {
    if (!adapter) throw new Error("WebGPU adapter unavailable for decisions")
    return adapter.requestDevice({
      requiredFeatures: ["shader-f16"],
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(
          adapter.limits.maxStorageBufferBindingSize,
          1_073_741_824,
        ),
      },
    })
  })
  let disposed = false
  let retired = false
  let lossNotified = false
  let session: ort.InferenceSession | undefined
  let disposal: Promise<void> | undefined
  const notifyLost = () => {
    retired = true
    if (disposed || lossNotified) return
    lossNotified = true
    lost()
  }
  const dispose = () => {
    if (disposal) return disposal
    disposed = true
    disposal = (async () => {
      let failure: unknown
      let failed = false
      try {
        await session?.release()
      } catch (error) {
        failure = error
        failed = true
      }
      try {
        device.destroy()
      } catch (error) {
        failure = failed
          ? new AggregateError([failure, error], "Decision model cleanup failed")
          : error
        failed = true
      }
      if (failed) throw failure
    })()
    return disposal
  }
  void device.lost.then(() => {
    notifyLost()
  })
  try {
    signal.throwIfAborted()
    await trace?.("session-create")
    session = await ort.InferenceSession.create(await bytes("decoder"), {
      executionProviders: [{ name: "webgpu", device }],
      externalData: [{ path: "decoder_q4f16.onnx_data", data: await bytes("weights") }],
      graphOptimizationLevel: "all",
    })
    await trace?.("session-ready")
    signal.throwIfAborted()
  } catch (error) {
    try {
      await dispose()
    } catch (cleanupError) {
      throw new CleanupUncertainError({ dispose }, cleanupError, error)
    }
    throw error
  }
  return {
    dispose,
    loseDevice: () => device.destroy(),
    async systemOne(
      input: SystemOneInput,
      signal: AbortSignal,
      trace?: DecisionTrace,
    ): Promise<SystemOneOutput> {
      if (disposed || retired)
        throw new Error(disposed ? "Decision model is disposed" : "Decision model is retired")
      signal.throwIfAborted()
      const request = SystemOneRequest.parse(input)
      const entries = Object.entries(request.questions)
      await trace?.("tokenize", { questionCount: entries.length })
      signal.throwIfAborted()
      const groups: number[][][] = []
      const suffixes = entries.map(([, question]) => {
        const labels = question.type === "choice" ? Object.keys(question.criteria) : []
        const codes = labels.every((label) => /^[A-Za-z]$/.test(label))
          ? labels
          : labels.map((_, i) => String.fromCharCode(65 + i))
        const ids = (forms: string[]) =>
          forms
            .map(encode)
            .filter((ids) => ids.length === 1)
            .map((ids) => ids[0]!)
        const table =
          question.type === "noul"
            ? [ids(["yes", "Yes", "YES"]), ids(["no", "No", "NO"])]
            : question.type === "score"
              ? question.criteria.map((_, i) => ids([String(i)]))
              : codes.map((code) => ids([code, ` ${code}`]))
        if (table.some((group) => !group.length))
          throw new Error("Tokenizer does not support a decision option")
        groups.push(table)
        return `${plain(renderQuestion(question, codes))}<|im_end|>\n<|im_start|>assistant\n<think></think>`
      })
      const prefix = `<|startoftext|><|im_start|>user\n${plain(describe(request.state) + "\n\n")}\nQUESTION:\n`
      const ids = encode(prefix + suffixes[0])
      const stateLength = ids.length - encode(suffixes[0]!).length
      const questionIDs: number[] = ids.map((_, i) => (i < stateLength ? -1 : 1))
      const slots = [ids.length - 1]
      for (let i = 1; i < suffixes.length; i++) {
        const own = encode(`QUESTION:\n${suffixes[i]}`)
        ids.push(...own)
        questionIDs.push(...own.map(() => i + 1))
        slots.push(ids.length - 1)
      }
      await trace?.("inputs-ready", {
        actualInputTokens: ids.length,
        contextCapacityTokens: DECISION_CONTEXT_CAPACITY_TOKENS,
        inputShape: [1, ids.length],
        questionCount: entries.length,
      })
      signal.throwIfAborted()
      if (ids.length > DECISION_CONTEXT_CAPACITY_TOKENS)
        throw Object.assign(
          new Error(
            `Decision context exceeds ${DECISION_CONTEXT_CAPACITY_TOKENS.toLocaleString("en-US")} tokens; input was not truncated`,
          ),
          {
            name: "ContextOverflowError",
            required: ids.length,
            capacity: DECISION_CONTEXT_CAPACITY_TOKENS,
          },
        )
      return withResources(async (own) => {
        const int64 = (values: number[], dims: number[]) =>
          own(new ort.Tensor("int64", BigInt64Array.from(values, BigInt), dims))
        const feeds = {
          input_ids: int64(ids, [1, ids.length]),
          attention_mask: int64(
            ids.map(() => 1),
            [1, ids.length],
          ),
          position_ids: int64(
            ids.map((_, i) => i),
            [1, ids.length],
          ),
          question_ids: int64(questionIDs, [1, ids.length]),
          slot_positions: int64(slots, [slots.length]),
          image_features: own(new ort.Tensor("float32", new Float32Array(), [0, 2048])),
          video_features: own(new ort.Tensor("float32", new Float32Array(), [0, 2048])),
          audio_features: own(new ort.Tensor("float32", new Float32Array(), [0, 2048])),
        }
        signal.throwIfAborted()
        await trace?.("run", { actualInputTokens: ids.length, inputShape: [1, ids.length] })
        signal.throwIfAborted()
        let outputs: Awaited<ReturnType<ort.InferenceSession["run"]>>
        try {
          outputs = await session!.run(feeds, ["logits"])
        } catch (error) {
          if (isOrtWebGpuDeviceLoss(error)) notifyLost()
          throw error
        }
        Object.values(outputs).forEach(own)
        await trace?.("readback", { outputShape: outputs.logits?.dims })
        signal.throwIfAborted()
        const tensor = outputs.logits
        if (
          !tensor ||
          tensor.type !== "float32" ||
          tensor.dims.length !== 2 ||
          tensor.dims[0] !== entries.length ||
          tensor.dims[1] !== 128000
        )
          throw new Error("Decision runtime returned unexpected logits dimensions")
        const logits = tensor.data as Float32Array
        const answers: SystemOneOutput["answers"] = Object.create(null)
        for (let i = 0; i < entries.length; i++) {
          const [name, q] = entries[i]!
          const scores = groups[i]!.map((group) =>
            Math.max(...group.map((id) => logits[i * 128000 + id]!)),
          )
          answers[name] = readAnswer(q, probabilities(scores, calibration.default))
        }
        return {
          model: "d1-omni-2b",
          answers,
          usage: { input_tokens: ids.length, output_tokens: 0 },
        }
      })
    },
  }
}
export type DecisionRuntime = Awaited<ReturnType<typeof loadDecisionRuntime>>
