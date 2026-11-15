import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import { Model, Provider } from "@opencode/plugin/effect"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import type { ChatRoute } from "./inference-route.ts"
import { MODEL_REPOSITORY, MODEL_REVISION } from "./manifest.ts"
import type { InferenceResult, NativeConversationMessage } from "./rpc.ts"

export const NATIVE_PROVIDER_ID = "lazers-local-webgpu"
export const NATIVE_PROVIDER_PACKAGE = `aisdk:${NATIVE_PROVIDER_ID}`
export const LIQUID_NATIVE_MODEL_ID = "lfm3-omni-2b-liquid-q4-k-m"
export const RUNNTIME_NATIVE_MODEL_ID = "lfm3-omni-2b-runntime-q4-k-m"

const providerID = Provider.ID.make(NATIVE_PROVIDER_ID)

const modelIdentity = {
  liquid: `${MODEL_REPOSITORY}@${MODEL_REVISION}#liquid-Q4_K_M+Q8_0`,
  runntime: `${MODEL_REPOSITORY}@${MODEL_REVISION}#runntime-Q4_K_M`,
} as const
const modelRoute = new Map<string, ChatRoute>([
  [modelIdentity.liquid, "liquid"],
  [modelIdentity.runntime, "runntime"],
])

export type NativeConversationCall = {
  route: ChatRoute
  messages: readonly NativeConversationMessage[]
  maxTokens: number
  signal: AbortSignal
  onText?: (text: string) => void
}

export type NativeConversationGenerate = (call: NativeConversationCall) => Promise<InferenceResult>

export function nativeConversationModels() {
  const liquid = Model.Info.default(providerID, Model.ID.make(LIQUID_NATIVE_MODEL_ID))
  const runntime = Model.Info.default(providerID, Model.ID.make(RUNNTIME_NATIVE_MODEL_ID))
  return [
    {
      ...liquid,
      modelID: Model.ID.make(modelIdentity.liquid),
      name: `LFM3 Omni 2B · Liquid Q4_K_M + projector Q8_0 · ${MODEL_REVISION.slice(0, 12)}`,
      type: "chat",
      family: Model.Family.make("lfm3-omni-2b"),
      capabilities: { tools: false, input: ["text"], output: ["text"], temperature: false },
      limit: { context: 4_096, output: 512 },
    },
    {
      ...runntime,
      modelID: Model.ID.make(modelIdentity.runntime),
      name: `LFM3 Omni 2B · ruNNtime Q4_K_M · ${MODEL_REVISION.slice(0, 12)}`,
      type: "chat",
      family: Model.Family.make("lfm3-omni-2b"),
      capabilities: { tools: false, input: ["text"], output: ["text"], temperature: false },
      limit: { context: 4_096, output: 512 },
    },
  ]
}

function unsupported(message: string): never {
  throw new Error(`Unsupported ruNNtime Omni conversation request: ${message}`)
}

function conversationMessages(prompt: LanguageModelV3Prompt): NativeConversationMessage[] {
  if (prompt.length < 1 || prompt.length > 128) unsupported("expected 1–128 text messages")
  const messages = prompt.map((message, index): NativeConversationMessage => {
    if (message.providerOptions && Object.keys(message.providerOptions).length > 0)
      unsupported(`provider options on message ${index + 1} are not supported`)
    if (message.role === "system") return { role: "system", content: message.content }
    if (message.role === "tool") unsupported("tool messages are not supported")
    const chunks: string[] = []
    for (const part of message.content) {
      if (part.type !== "text") unsupported(`${part.type} message parts are not supported`)
      if (part.providerOptions && Object.keys(part.providerOptions).length > 0)
        unsupported(`provider options on message ${index + 1} are not supported`)
      chunks.push(part.text)
    }
    return { role: message.role, content: chunks.join("") }
  })
  const length = messages.reduce((sum, message) => sum + message.content.length, 0)
  if (length < 1 || length > 64_000)
    unsupported("conversation text must contain 1–64,000 characters")
  return messages
}

function validateOptions(options: LanguageModelV3CallOptions) {
  if (options.temperature !== undefined) unsupported("temperature is not supported")
  if (options.topP !== undefined) unsupported("topP is not supported")
  if (options.topK !== undefined) unsupported("topK is not supported")
  if (options.presencePenalty !== undefined) unsupported("presencePenalty is not supported")
  if (options.frequencyPenalty !== undefined) unsupported("frequencyPenalty is not supported")
  if (options.seed !== undefined) unsupported("seed is not supported")
  if (options.stopSequences?.length) unsupported("stop sequences are not supported")
  if (options.tools?.length) unsupported("tool calling is not supported")
  if (options.toolChoice && options.toolChoice.type !== "auto")
    unsupported("tool choice is not supported")
  if (options.responseFormat?.type === "json") unsupported("JSON response format is not supported")
  if (options.includeRawChunks) unsupported("raw provider chunks are not supported")
  if (options.providerOptions && Object.keys(options.providerOptions).length > 0)
    unsupported("provider options are not supported")
  const maxTokens = options.maxOutputTokens ?? 128
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 512)
    unsupported("maxOutputTokens must be an integer between 1 and 512")
  return maxTokens
}

function usage(result: InferenceResult): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: result.promptTokens ?? undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: result.completionTokens ?? undefined,
      text: result.completionTokens ?? undefined,
      reasoning: undefined,
    },
  }
}

function finishReason(result: InferenceResult) {
  return { unified: result.finishReason ?? "other", raw: result.finishReason }
}

function successful(result: InferenceResult): InferenceResult {
  if (!result.ok) throw new Error(result.error || "Local Omni generation failed")
  return result
}

export function createNativeLanguageModel(
  modelID: string,
  route: ChatRoute,
  generate: NativeConversationGenerate,
): LanguageModelV3 {
  const invoke = async (options: LanguageModelV3CallOptions, onText?: (text: string) => void) => {
    const messages = conversationMessages(options.prompt)
    const maxTokens = validateOptions(options)
    const result = successful(
      await generate({
        route,
        messages,
        maxTokens,
        signal: options.abortSignal ?? new AbortController().signal,
        ...(onText ? { onText } : {}),
      }),
    )
    return { result, usage: usage(result) }
  }

  return {
    specificationVersion: "v3",
    provider: NATIVE_PROVIDER_ID,
    modelId: modelID,
    supportedUrls: {},
    async doGenerate(options) {
      const { result, usage } = await invoke(options)
      return {
        content: [{ type: "text", text: result.text }],
        finishReason: finishReason(result),
        usage,
        warnings: [],
      }
    },
    async doStream(options) {
      const messages = conversationMessages(options.prompt)
      const maxTokens = validateOptions(options)
      const abort = new AbortController()
      const signal = options.abortSignal
        ? AbortSignal.any([options.abortSignal, abort.signal])
        : abort.signal
      let closed = false
      let textStarted = false
      const stream = new ReadableStream<import("@ai-sdk/provider").LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          const enqueueText = (text: string) => {
            if (closed || signal.aborted || !text) return
            if (!textStarted) {
              textStarted = true
              controller.enqueue({ type: "text-start", id: "omni-response" })
            }
            controller.enqueue({ type: "text-delta", id: "omni-response", delta: text })
          }
          void generate({
            route,
            messages,
            maxTokens,
            signal,
            onText: enqueueText,
          })
            .then((output) => {
              successful(output)
              if (closed || signal.aborted) return
              if (!textStarted) controller.enqueue({ type: "text-start", id: "omni-response" })
              controller.enqueue({ type: "text-end", id: "omni-response" })
              controller.enqueue({
                type: "finish",
                finishReason: finishReason(output),
                usage: usage(output),
              })
              closed = true
              controller.close()
            })
            .catch((error: unknown) => {
              if (closed) return
              closed = true
              controller.error(error)
            })
        },
        cancel(reason) {
          closed = true
          abort.abort(reason)
        },
      })
      return { stream }
    },
  }
}

export function registerNativeConversationProvider(
  ctx: Pick<Plugin.Context, "provider" | "aisdk">,
  generate: NativeConversationGenerate,
) {
  return Effect.gen(function* () {
    yield* ctx.provider.transform((editor) => {
      editor.add({
        info: {
          id: providerID,
          name: "LAZERS Local WebGPU",
          activation: "enabled",
          package: NATIVE_PROVIDER_PACKAGE,
        },
        models: nativeConversationModels(),
      })
    })

    yield* ctx.aisdk.hook(
      "sdk",
      (event) =>
        Effect.sync(() => {
          event.sdk = {
            languageModel: (id: string) => {
              const route = modelRoute.get(id)
              if (!route) throw new Error(`Unknown LAZERS local model: ${id}`)
              return createNativeLanguageModel(id, route, generate)
            },
          }
        }),
      { providerID: NATIVE_PROVIDER_ID },
    )

    yield* ctx.aisdk.hook(
      "language",
      (event) =>
        Effect.sync(() => {
          const sdk = event.sdk as { languageModel: (id: string) => LanguageModelV3 }
          event.language = sdk.languageModel(event.model.modelID)
        }),
      { providerID: NATIVE_PROVIDER_ID },
    )
  })
}
