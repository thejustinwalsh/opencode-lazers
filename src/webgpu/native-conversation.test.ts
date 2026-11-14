import { expect, test } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import {
  LIQUID_NATIVE_MODEL_ID,
  NATIVE_PROVIDER_ID,
  RUNNTIME_NATIVE_MODEL_ID,
  createNativeLanguageModel,
  nativeConversationModels,
  registerNativeConversationProvider,
} from "./native-conversation.ts"
import { MODEL_REVISION } from "./manifest.ts"
import type { InferenceResult } from "./rpc.ts"

const successful = (text: string, usage: { prompt: number | null; completion: number | null }) =>
  ({
    ok: true,
    text,
    error: "",
    promptTokens: usage.prompt,
    completionTokens: usage.completion,
    finishReason: "stop",
  }) satisfies InferenceResult

const options = (patch: Partial<LanguageModelV3CallOptions> = {}): LanguageModelV3CallOptions => ({
  prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  ...patch,
})

test("native provider exposes separately pinned Liquid and ruNNtime conversation models", () => {
  const models = nativeConversationModels()
  expect(models).toHaveLength(2)
  expect(models.map((model) => String(model.id))).toEqual([
    LIQUID_NATIVE_MODEL_ID,
    RUNNTIME_NATIVE_MODEL_ID,
  ])
  expect(models.map((model) => String(model.providerID))).toEqual([
    NATIVE_PROVIDER_ID,
    NATIVE_PROVIDER_ID,
  ])
  expect(models.map((model) => String(model.modelID))).toEqual([
    `LiquidAI/LFM3-Omni-2B-GGUF@${MODEL_REVISION}#liquid-Q4_K_M+Q8_0`,
    `LiquidAI/LFM3-Omni-2B-GGUF@${MODEL_REVISION}#runntime-Q4_K_M`,
  ])
  for (const model of models) {
    expect(model.capabilities).toEqual({
      tools: false,
      input: ["text"],
      output: ["text"],
      temperature: false,
    })
    expect(model.cost).toEqual([])
  }
})

test("supported sdk and language hooks register the selected native model", async () => {
  const models: ReturnType<typeof nativeConversationModels> = []
  const hooks: {
    name: string
    callback: (event: unknown) => Effect.Effect<void>
  }[] = []
  const ctx = {
    provider: {
      transform: (callback: (editor: unknown) => void) =>
        Effect.sync(() => {
          callback({
            add: ({ models: added }: { models: ReturnType<typeof nativeConversationModels> }) =>
              models.push(...added),
          })
          return { dispose: Effect.void }
        }),
    },
    aisdk: {
      hook: (name: string, callback: (event: never) => Effect.Effect<void>) =>
        Effect.sync(() => {
          hooks.push({ name, callback: callback as (event: unknown) => Effect.Effect<void> })
          return { dispose: Effect.void }
        }),
    },
  } as unknown as Pick<Plugin.Context, "provider" | "aisdk">
  const routes: string[] = []
  await Effect.runPromise(
    Effect.scoped(
      registerNativeConversationProvider(ctx, async ({ route }) => {
        routes.push(route)
        return successful("reply", { prompt: null, completion: null })
      }),
    ),
  )

  expect(hooks.map((hook) => hook.name)).toEqual(["sdk", "language"])
  const model = models[1]!
  const sdkEvent: {
    model: (typeof models)[number]
    options: Record<string, unknown>
    sdk?: unknown
  } = {
    model,
    options: {},
  }
  const sdkHook = hooks.find((hook) => hook.name === "sdk")!
  await Effect.runPromise(sdkHook.callback(sdkEvent))
  const languageEvent: {
    model: (typeof models)[number]
    options: Record<string, unknown>
    sdk: unknown
    language?: unknown
  } = { model, options: {}, sdk: sdkEvent.sdk }
  const languageHook = hooks.find((hook) => hook.name === "language")!
  await Effect.runPromise(languageHook.callback(languageEvent))

  const language = languageEvent.language as ReturnType<typeof createNativeLanguageModel>
  expect(language.provider).toBe(NATIVE_PROVIDER_ID)
  expect(language.modelId).toBe(model.modelID)
  await language.doGenerate(options())
  expect(routes).toEqual(["runntime"])
})

test("native conversation adapter preserves full ordered text history and streams host deltas", async () => {
  const calls: Parameters<NonNullable<Parameters<typeof createNativeLanguageModel>[2]>>[0][] = []
  const model = createNativeLanguageModel(RUNNTIME_NATIVE_MODEL_ID, "runntime", async (call) => {
    calls.push(call)
    call.onText?.("native ")
    call.onText?.("reply")
    return successful("native reply", { prompt: 9, completion: 2 })
  })
  const prompt = [
    { role: "system" as const, content: "system" },
    { role: "user" as const, content: [{ type: "text" as const, text: "first" }] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "previous reply" }] },
    { role: "user" as const, content: [{ type: "text" as const, text: "follow-up" }] },
  ]
  const { stream } = await model.doStream(options({ prompt }))
  const parts = await Array.fromAsync(stream)
  const messages = calls[0]!.messages
  expect(messages).toEqual([
    { role: "system", content: "system" },
    { role: "user", content: "first" },
    { role: "assistant", content: "previous reply" },
    { role: "user", content: "follow-up" },
  ])
  expect(calls[0]!.route).toBe("runntime")
  expect(
    parts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.type === "text-delta" && part.delta),
  ).toEqual(["native ", "reply"])
  expect(parts.filter((part) => part.type === "finish")).toHaveLength(1)
  const finish = parts.find((part) => part.type === "finish")
  expect(finish?.type === "finish" && finish.finishReason.unified).toBe("stop")
  expect(finish?.type === "finish" && finish.usage.inputTokens.total).toBe(9)
})

test("unknown usage stays unknown and unsupported capabilities fail explicitly", async () => {
  let calls = 0
  const model = createNativeLanguageModel(LIQUID_NATIVE_MODEL_ID, "liquid", async () => {
    calls++
    return successful("reply", { prompt: null, completion: null })
  })
  const result = await model.doGenerate(options())
  expect(result.usage.inputTokens.total).toBeUndefined()
  expect(result.usage.outputTokens.total).toBeUndefined()
  await expect(
    model.doGenerate(
      options({
        prompt: [
          { role: "user", content: [{ type: "file", data: "data", mediaType: "image/png" }] },
        ],
      }),
    ),
  ).rejects.toThrow("file message parts are not supported")
  await expect(model.doGenerate(options({ temperature: 0.2 }))).rejects.toThrow(
    "temperature is not supported",
  )
  await expect(
    model.doGenerate(options({ tools: [{ type: "function", name: "lookup", inputSchema: {} }] })),
  ).rejects.toThrow("tool calling is not supported")
  expect(calls).toBe(1)
})

test("cancelling the native readable stream aborts only its renderer request", async () => {
  const started = Promise.withResolvers<AbortSignal>()
  const model = createNativeLanguageModel(RUNNTIME_NATIVE_MODEL_ID, "runntime", ({ signal }) => {
    started.resolve(signal)
    return new Promise((resolve) =>
      signal.addEventListener(
        "abort",
        () =>
          resolve({
            ok: false,
            text: "",
            error: "cancelled",
            promptTokens: null,
            completionTokens: null,
          }),
        { once: true },
      ),
    )
  })
  const { stream } = await model.doStream(options())
  const signal = await started.promise
  await stream.cancel("user interrupted")
  expect(signal.aborted).toBe(true)
})

test("native generation errors fail the host stream without a finish event", async () => {
  const model = createNativeLanguageModel(RUNNTIME_NATIVE_MODEL_ID, "runntime", async () => ({
    ok: false,
    text: "",
    error: "simulated device loss",
    promptTokens: null,
    completionTokens: null,
  }))
  const { stream } = await model.doStream(options())
  await expect(Array.fromAsync(stream)).rejects.toThrow("simulated device loss")
})
