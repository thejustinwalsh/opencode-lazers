import { expect, test } from "bun:test"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import type { RpcClient } from "@opencode/client"
import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { failed } from "./broker.ts"
import { forwardNativeConversation, registerLocalInference } from "./server.ts"
import { GENERATION_RESULT_CONTRACT_REVISION, LocalInference, RendererInference } from "./rpc.ts"
import type { InferenceJob, NativeConversationMessage, InferenceResult } from "./rpc.ts"
import { defaultFeatures } from "./features.ts"
import {
  NATIVE_PROVIDER_PACKAGE,
  RUNNTIME_NATIVE_MODEL_ID,
  createNativeLanguageModel,
  nativeConversationModels,
} from "./native-conversation.ts"

type ConversationEvent = { requestID: string; type: "ready" | "delta" | "end"; text?: string }
type PublishedEvent = {
  type: "rpc.lazers.webgpu-worker.nativeConversation"
  location: { directory: string }
  data: ConversationEvent
}

function eventHub(directory: string) {
  const subscribers = new Set<(event: PublishedEvent) => void>()
  return {
    publish(data: ConversationEvent) {
      for (const subscriber of subscribers)
        subscriber({
          type: "rpc.lazers.webgpu-worker.nativeConversation",
          location: { directory },
          data,
        })
    },
    subscribe(signal: AbortSignal): AsyncIterable<PublishedEvent> {
      const events: PublishedEvent[] = []
      const waiters: (() => void)[] = []
      let closed = false
      const wake = () => {
        for (const resolve of waiters.splice(0)) resolve()
      }
      const subscriber = (event: PublishedEvent) => {
        events.push(event)
        wake()
      }
      const close = () => {
        closed = true
        wake()
      }
      subscribers.add(subscriber)
      signal.addEventListener("abort", close, { once: true })
      if (signal.aborted) close()
      return {
        async *[Symbol.asyncIterator]() {
          try {
            while (!closed) {
              const event = events.shift()
              if (event) {
                yield event
                continue
              }
              await new Promise<void>((resolve) => waiters.push(resolve))
            }
          } finally {
            subscribers.delete(subscriber)
            signal.removeEventListener("abort", close)
            close()
          }
        },
      }
    },
  }
}

function server(directory: string) {
  const hub = eventHub(directory)
  const hooks: { name: string; callback: (event: unknown) => Effect.Effect<void> }[] = []
  let models: ReturnType<typeof nativeConversationModels> = []
  let providerPackage = ""
  let local!: RpcHandlers<typeof LocalInference>
  let renderer!: RpcHandlers<typeof RendererInference>
  const stored = new Map<string, unknown>([["webgpu.features", defaultFeatures(true)]])
  const ctx = {
    options: { webgpu: true },
    location: {
      directory,
      project: { directory, canonical: directory },
    },
    storage: {
      get: (key: string) => Effect.succeed(stored.get(key)),
      set: (key: string, value: unknown) => Effect.sync(() => stored.set(key, value)),
    },
    permission: { assert: () => Effect.void },
    provider: {
      transform: (callback: (editor: unknown) => void) =>
        Effect.sync(() => {
          callback({
            add: ({
              info,
              models: added,
            }: {
              info: { package?: string }
              models: typeof models
            }) => {
              providerPackage = info.package ?? ""
              models = added
            },
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
    tool: {
      transform: () => Effect.succeed({ dispose: Effect.void }),
      reload: () => Effect.void,
    },
    agent: {
      transform: () => Effect.succeed({ dispose: Effect.void }),
      reload: () => Effect.void,
    },
    rpc: {
      register: (definition: { id: string }, handlers: unknown) =>
        Effect.sync(() => {
          if (definition.id === RendererInference.id) renderer = handlers as typeof renderer
          else local = handlers as typeof local
          return {
            dispose: Effect.void,
            events: {
              emit: (_name: string, data: ConversationEvent) =>
                Effect.sync(() => hub.publish(data)),
            },
          }
        }),
    },
  } as unknown as Pick<
    Plugin.Context,
    | "rpc"
    | "tool"
    | "permission"
    | "agent"
    | "storage"
    | "location"
    | "options"
    | "provider"
    | "aisdk"
  >
  return {
    ctx,
    hub,
    hooks,
    models: () => models,
    providerPackage: () => providerPackage,
    local: () => local,
    renderer: () => renderer,
  }
}

function remoteClient(
  target: ReturnType<typeof server>,
  onNativeCall: () => void,
): RpcClient<typeof RendererInference> {
  const errorContext = {
    error: (type: string, message: string, data: unknown) => ({ type, message, data }),
  }
  return new Proxy(
    {},
    {
      get: (_, key) => {
        if (key === "then") return undefined
        if (key === "events")
          return {
            subscribe: (_name: string, options: { signal?: AbortSignal }) =>
              target.hub.subscribe(options.signal!),
          }
        return (input: unknown, options?: { signal?: AbortSignal }) => {
          if (key === "nativeConversation") onNativeCall()
          const handler = target.renderer()[
            key as keyof RpcHandlers<typeof RendererInference>
          ] as unknown as (input: unknown, context: unknown) => Effect.Effect<unknown>
          return Effect.runPromise(handler(input, errorContext), { signal: options?.signal })
        }
      },
    },
  ) as RpcClient<typeof RendererInference>
}

async function nativeLanguage(
  target: ReturnType<typeof server>,
  generate: Parameters<typeof createNativeLanguageModel>[2],
) {
  const model = target.models().find((item) => String(item.id) === RUNNTIME_NATIVE_MODEL_ID)!
  expect(target.providerPackage()).toBe(NATIVE_PROVIDER_PACKAGE)
  const sdkEvent: { model: typeof model; options: Record<string, unknown>; sdk?: unknown } = {
    model: { ...model, package: target.providerPackage() } as typeof model,
    options: {},
  }
  await Effect.runPromise(target.hooks.find((hook) => hook.name === "sdk")!.callback(sdkEvent))
  const languageEvent: {
    model: typeof model
    options: Record<string, unknown>
    sdk: unknown
    language?: unknown
  } = { model: sdkEvent.model, options: {}, sdk: sdkEvent.sdk }
  await Effect.runPromise(
    target.hooks.find((hook) => hook.name === "language")!.callback(languageEvent),
  )
  expect(languageEvent.language).toBeDefined()
  return createNativeLanguageModel(model.modelID, "runntime", generate)
}

const history: NativeConversationMessage[] = [
  { role: "system", content: "Follow the project rule." },
  { role: "user", content: "First question." },
  { role: "assistant", content: "Earlier answer." },
  { role: "user", content: "Continue from the earlier answer." },
]

const conversationOptions = (signal?: AbortSignal): LanguageModelV3CallOptions => ({
  prompt: [
    { role: "system", content: history[0]!.content },
    { role: "user", content: [{ type: "text", text: history[1]!.content }] },
    { role: "assistant", content: [{ type: "text", text: history[2]!.content }] },
    { role: "user", content: [{ type: "text", text: history[3]!.content }] },
  ],
  ...(signal ? { abortSignal: signal } : {}),
})

function collect(stream: ReadableStream<LanguageModelV3StreamPart>) {
  return Array.fromAsync(stream).then(
    (parts) => ({ parts }),
    (error: unknown) => ({ error }),
  )
}

async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 3_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await Bun.sleep(0)
  }
}

test("project native conversations stream through default authority across cancellation and ownership loss", async () => {
  const defaultLocation = server("/synthetic/default")
  const projectLocation = server("/synthetic/project-worktree")
  let remoteCalls = 0
  let defaultClient!: RpcClient<typeof RendererInference>
  const owner = "desktop-owner"
  const replacement = "replacement-owner"
  const errorContext = {
    error: (type: string, message: string, data: unknown) => ({ type, message, data }),
  }

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerLocalInference(defaultLocation.ctx, async () => defaultClient)
        defaultClient = remoteClient(defaultLocation, () => remoteCalls++)
        yield* registerLocalInference(projectLocation.ctx, async () => defaultClient)
        yield* Effect.promise(async () => {
          const renderer = defaultLocation.renderer()
          await Effect.runPromise(
            renderer.attach(
              { owner, contractRevision: GENERATION_RESULT_CONTRACT_REVISION },
              errorContext as never,
            ),
          )
          const language = await nativeLanguage(projectLocation, async (call) =>
            forwardNativeConversation(defaultClient, call),
          )
          const start = async (signal?: AbortSignal) => {
            const { stream } = await language.doStream(conversationOptions(signal))
            return collect(stream)
          }
          const poll = (whichOwner = owner) =>
            Effect.runPromise(
              renderer.poll({ owner: whichOwner, available: true }, errorContext as never),
            )
          const nextJob = async (whichOwner = owner): Promise<InferenceJob> => {
            const deadline = Date.now() + 3_000
            while (Date.now() < deadline) {
              const response = await poll(whichOwner)
              if (response.job) return response.job
              await Bun.sleep(0)
            }
            throw new Error("Native conversation did not reach the default renderer mailbox")
          }
          const delta = (id: string, text: string, whichOwner = owner) =>
            Effect.runPromise(
              renderer.delta({ owner: whichOwner, id, text }, errorContext as never),
            )
          const complete = (id: string, result: InferenceResult, whichOwner = owner) =>
            Effect.runPromise(
              renderer.complete({ owner: whichOwner, id, result }, errorContext as never),
            )
          const successful = (text: string): InferenceResult => ({
            ok: true,
            text,
            error: "",
            promptTokens: null,
            completionTokens: null,
            finishReason: "stop",
          })
          const assertStream = async (pending: ReturnType<typeof collect>, chunks: string[]) => {
            const outcome = await pending
            if ("error" in outcome) throw outcome.error
            expect(
              outcome.parts
                .filter((part) => part.type === "text-delta")
                .map((part) => (part.type === "text-delta" ? part.delta : "")),
            ).toEqual(chunks)
            expect(outcome.parts.filter((part) => part.type === "finish")).toHaveLength(1)
            return outcome.parts
          }

          const first = start()
          const firstJob = await nextJob()
          expect(firstJob.route).toBe("runntime")
          expect(firstJob.messages).toEqual(history)
          expect(
            await Effect.runPromise(projectLocation.renderer().demand({}, errorContext as never)),
          ).toEqual({
            requested: false,
          })
          expect(await Effect.runPromise(renderer.demand({}, errorContext as never))).toEqual({
            requested: true,
          })
          expect(await delta(firstJob.id, "ordered ")).toEqual({ accepted: true })
          expect(await delta(firstJob.id, "reply")).toEqual({ accepted: true })
          await complete(firstJob.id, successful("ordered reply"))
          await assertStream(first, ["ordered ", "reply"])

          const interrupted = new AbortController()
          const interruptedStream = start(interrupted.signal)
          const interruptedJob = await nextJob()
          const queuedCancellation = new AbortController()
          const cancelledQueuedStream = start(queuedCancellation.signal)
          const survivorStream = start()
          await until(() => remoteCalls >= 4, "queued cancellation and unrelated conversation")
          queuedCancellation.abort(new Error("queued request interrupted"))
          const cancelledQueuedResult = await cancelledQueuedStream
          expect(
            "error" in cancelledQueuedResult ? String(cancelledQueuedResult.error) : "",
          ).toMatch(/interrupt|cancel/i)
          await Bun.sleep(0)
          interrupted.abort(new Error("user interrupted"))
          expect(await poll()).toMatchObject({ job: null, cancelID: interruptedJob.id })
          await complete(interruptedJob.id, failed("Inference cancelled"))
          const survivorJob = await nextJob()
          expect(survivorJob.messages).toEqual(history)
          expect(await delta(interruptedJob.id, "late")).toEqual({ accepted: false })
          await complete(interruptedJob.id, successful("duplicate finish"))
          expect(await poll()).toEqual({ job: null, cancelID: null })
          await delta(survivorJob.id, "survived")
          await complete(survivorJob.id, successful("survived"))
          const interruptedResult = await interruptedStream
          expect("error" in interruptedResult ? String(interruptedResult.error) : "").toMatch(
            /cancel|interrupt/i,
          )
          await assertStream(survivorStream, ["survived"])

          const lostStream = start()
          const lostJob = await nextJob()
          const queuedStream = start()
          await until(() => remoteCalls >= 6, "work queued behind owned generation")
          await Bun.sleep(0)
          await Effect.runPromise(renderer.detach({ owner }, errorContext as never))
          const lostResult = await lostStream
          expect("error" in lostResult ? String(lostResult.error) : "").toMatch(
            /disconnect|renderer/i,
          )
          await expect(delta(lostJob.id, "late", owner)).rejects.toThrow()
          await expect(complete(lostJob.id, successful("late"), owner)).rejects.toThrow()
          await Effect.runPromise(
            renderer.attach(
              { owner: replacement, contractRevision: GENERATION_RESULT_CONTRACT_REVISION },
              errorContext as never,
            ),
          )
          const queuedJob = await nextJob(replacement)
          await delta(queuedJob.id, "owner ", replacement)
          await delta(queuedJob.id, "replaced", replacement)
          await complete(queuedJob.id, successful("owner replaced"), replacement)
          await assertStream(queuedStream, ["owner ", "replaced"])

          const freshStream = start()
          const freshJob = await nextJob(replacement)
          await delta(freshJob.id, "fresh request", replacement)
          await complete(freshJob.id, successful("fresh request"), replacement)
          await assertStream(freshStream, ["fresh request"])
        })
      }),
    ),
  )
}, 20_000)
