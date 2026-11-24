import { expect, test } from "bun:test"
import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { RpcClient } from "@opencode/client"
import { Effect } from "effect"
import { registerLocalInference } from "./server.ts"
import { GENERATION_RESULT_CONTRACT_REVISION, LocalInference, RendererInference } from "./rpc.ts"
import { defaultFeatures } from "./features.ts"
import { InferenceRelay } from "./relay/protocol.ts"
import { DesktopInferenceRelay } from "./relay/desktop.ts"
import type { OpenCodeClient } from "@opencode/client/promise"

test("saved switches enforce public RPC, cancel only disabled work, and remove native tools and review guidance", async () => {
  const data = new Map<string, unknown>()
  const tools = new Map<string, Parameters<ToolEditor["add"]>[0]>()
  const transforms: ((editor: ToolEditor) => void)[] = []
  const agents: ((editor: AgentEditor) => void)[] = []
  let architect = { system: "Ordinary Architect", permissions: [] as unknown[] }
  let worker!: RpcHandlers<typeof RendererInference>
  let publicApi!: RpcHandlers<typeof LocalInference>
  const reloadTools = () =>
    Effect.sync(() => {
      tools.clear()
      const editor: ToolEditor = {
        add: (tool: Parameters<ToolEditor["add"]>[0]) => tools.set(tool.name, tool),
        list: () => [],
        get: () => undefined,
        namespace: () => {},
        update: () => {},
        remove: (id) => {
          tools.delete(id)
        },
      }
      transforms.forEach((transform) => transform(editor))
    })
  const reloadAgents = () =>
    Effect.sync(() => {
      architect = { system: "Ordinary Architect", permissions: [] }
      const editor = {
        get: () => architect,
        update: (_: string, update: (value: typeof architect) => void) => update(architect),
      } as unknown as AgentEditor
      agents.forEach((transform) => transform(editor))
    })
  const ctx = {
    options: {},
    location: { project: { canonical: "/synthetic" } },
    storage: {
      get: (key: string) => Effect.succeed(data.get(key)),
      set: (key: string, value: unknown) =>
        Effect.sync(() => {
          data.set(key, value)
        }),
    },
    permission: { assert: () => Effect.void },
    provider: { transform: () => Effect.succeed({ dispose: Effect.void }) },
    aisdk: { hook: () => Effect.succeed({ dispose: Effect.void }) },
    tool: {
      transform: (callback: (editor: ToolEditor) => void) =>
        Effect.sync(() => {
          transforms.push(callback)
          return { dispose: Effect.void }
        }),
      reload: reloadTools,
    },
    agent: {
      transform: (callback: (editor: AgentEditor) => void) =>
        Effect.sync(() => {
          agents.push(callback)
          return { dispose: Effect.void }
        }),
      reload: reloadAgents,
    },
    rpc: {
      register: (definition: { id: string }, handlers: unknown) =>
        Effect.sync(() => {
          if (definition.id === RendererInference.id) worker = handlers as typeof worker
          else publicApi = handlers as typeof publicApi
          return { dispose: Effect.void, events: { emit: () => Effect.void } }
        }),
    },
  } as unknown as Parameters<typeof registerLocalInference>[0]
  const client = new Proxy(
    {},
    {
      get: (_, key) =>
        key === "then"
          ? undefined
          : (input: unknown) => {
              const handler = worker[key as keyof typeof worker] as (
                input: unknown,
                context: never,
              ) => Effect.Effect<unknown>
              return Effect.runPromise(handler(input, {} as never))
            },
    },
  ) as RpcClient<typeof RendererInference>
  const request = { prompt: "Synthetic", maxTokens: 16, timeoutMs: 1_000 }
  const system = {
    timeoutMs: 1_000,
    model: "d1-omni-2b" as const,
    state: "s",
    questions: { q: { type: "noul" as const, instructions: "Q?" } },
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerLocalInference(ctx, async () => client)
        yield* Effect.promise(async () => {
          expect((await Effect.runPromise(publicApi.ask(request, {} as never))).ok).toBe(false)
          expect((await Effect.runPromise(publicApi.speak(request, {} as never))).ok).toBe(false)
          expect(await Effect.runPromise(publicApi.systemOne(system, {} as never))).toHaveProperty(
            "error",
          )
          expect(await Effect.runPromise(publicApi.review(system, {} as never))).toHaveProperty(
            "error",
          )
          expect(
            (
              await Effect.runPromise(
                publicApi.transcribe(
                  { audioBase64: "AAA=", requestID: "test", timeoutMs: 1_000 },
                  {} as never,
                ),
              )
            ).ok,
          ).toBe(false)
          expect(await Effect.runPromise(worker.demand({}, {} as never))).toEqual({
            requested: false,
          })
          await Effect.runPromise(publicApi.configure({ enabled: true }, {} as never))
          expect(tools.has("lz-verify-task")).toBe(true)
          expect(architect.system).toContain(
            "For Architect self-review before lz-submit-task, call lz-verify-task",
          )
          expect(architect.system).toContain("This one tool owns structural validation")
          expect(architect.system).toContain("fixed System One questions")
          const oldReview = tools.get("lz-verify-task")!
          await Effect.runPromise(
            worker.attach(
              { owner: "renderer", contractRevision: GENERATION_RESULT_CONTRACT_REVISION },
              {} as never,
            ),
          )
          const first = Effect.runPromise(publicApi.ask(request, {} as never))
          await Promise.resolve()
          const current = (
            await Effect.runPromise(
              worker.poll({ owner: "renderer", available: true }, {} as never),
            )
          ).job!
          expect(current.feature).toBe("questions")
          const speech = Effect.runPromise(publicApi.speak(request, {} as never))
          await Promise.resolve()
          await Effect.runPromise(
            publicApi.configure({ questions: false, decisions: false }, {} as never),
          )
          expect((await first).error).toContain("turned off")
          expect(tools.size).toBe(0)
          expect(architect.system).toBe("Ordinary Architect")
          await expect(Effect.runPromise(oldReview.execute({}, {} as never))).rejects.toThrow(
            "turned off",
          )
          expect(
            await Effect.runPromise(
              worker.poll({ owner: "renderer", available: true }, {} as never),
            ),
          ).toEqual({ job: null, cancelID: current.id })
          await Effect.runPromise(
            worker.complete(
              {
                owner: "renderer",
                id: current.id,
                result: {
                  ok: false,
                  text: "",
                  error: "cancelled",
                  promptTokens: 0,
                  completionTokens: 0,
                },
              },
              {} as never,
            ),
          )
          const next = (
            await Effect.runPromise(
              worker.poll({ owner: "renderer", available: true }, {} as never),
            )
          ).job!
          expect(next.feature).toBe("readAloud")
          await Effect.runPromise(publicApi.configure({ enabled: false }, {} as never))
          expect((await speech).error).toContain("turned off")
          expect(data.get("webgpu.features")).toEqual({
            ...defaultFeatures(false),
            questions: false,
            decisions: false,
          })
          expect(await Effect.runPromise(worker.demand({}, {} as never))).toEqual({
            requested: false,
          })
        })
      }),
    ),
  )
})

test("a project-location public request reaches the default renderer through the live Desktop client", async () => {
  const data = new Map<string, unknown>([["webgpu.features", defaultFeatures(true)]])
  let publicApi!: RpcHandlers<typeof LocalInference>
  let relay!: RpcHandlers<typeof InferenceRelay>
  let emitEvent: ((event: unknown) => void) | undefined
  const defaultCalls: { method: string; location?: string }[] = []
  const features = defaultFeatures(true)
  const ctx = {
    options: {},
    location: { directory: "/project", project: { canonical: "/project" } },
    storage: {
      get: (key: string) => Effect.succeed(data.get(key)),
      set: (key: string, value: unknown) => Effect.sync(() => void data.set(key, value)),
    },
    permission: { assert: () => Effect.void },
    tool: {
      transform: () => Effect.succeed({ dispose: Effect.void }),
      reload: Effect.void,
    },
    agent: {
      transform: () => Effect.succeed({ dispose: Effect.void }),
      reload: Effect.void,
    },
    rpc: {
      register: (definition: { id: string }, handlers: unknown) =>
        Effect.sync(() => {
          if (definition.id === InferenceRelay.id) relay = handlers as typeof relay
          else if (definition.id === LocalInference.id) publicApi = handlers as typeof publicApi
          return {
            dispose: Effect.void,
            events: {
              emit: (name: string, payload: { requestID: string }) =>
                Effect.sync(() =>
                  emitEvent?.({
                    type: `rpc.${definition.id}.${name}`,
                    location: { directory: "/project" },
                    data: payload,
                  }),
                ),
            },
          }
        }),
    },
  } as unknown as Parameters<typeof registerLocalInference>[0]
  const client = {
    rpc: (definition: { id: string }) => {
      if (definition.id === InferenceRelay.id)
        return {
          discover: async (_input: unknown, options: { location?: { directory?: string } }) => {
            expect(options.location?.directory).toBe("/project")
            return Effect.runPromise(relay.discover({}, {} as never))
          },
          claim: (
            input: Parameters<typeof relay.claim>[0],
            options: { location?: { directory?: string } },
          ) => {
            expect(options.location?.directory).toBe("/project")
            return Effect.runPromise(relay.claim(input, {} as never))
          },
          begin: (
            input: Parameters<typeof relay.begin>[0],
            options: { location?: { directory?: string } },
          ) => {
            expect(options.location?.directory).toBe("/project")
            return Effect.runPromise(relay.begin(input, {} as never))
          },
          complete: (
            input: Parameters<typeof relay.complete>[0],
            options: { location?: { directory?: string } },
          ) => {
            expect(options.location?.directory).toBe("/project")
            return Effect.runPromise(relay.complete(input, {} as never))
          },
          recover: (input: Parameters<typeof relay.recover>[0]) =>
            Effect.runPromise(relay.recover(input, {} as never)),
          acknowledge: (input: Parameters<typeof relay.acknowledge>[0]) =>
            Effect.runPromise(relay.acknowledge(input, {} as never)),
        }
      if (definition.id === RendererInference.id)
        return {
          settings: async () => features,
          ask: async (_input: unknown, options: { location?: { directory?: string } }) => {
            defaultCalls.push({ method: "ask", location: options.location?.directory })
            return {
              ok: true,
              text: "default authority",
              error: "",
              promptTokens: 1,
              completionTokens: 2,
            }
          },
        }
      throw new Error(`Unexpected RPC: ${definition.id}`)
    },
    debug: { location: { list: async () => [{ directory: "/project" }] } },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) =>
        (async function* () {
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve()
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
          yield undefined
        })(),
    },
  } as unknown as OpenCodeClient
  const manager = new DesktopInferenceRelay(() => client, new AbortController().signal)

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerLocalInference(ctx)
        emitEvent = (event) => void manager.handleEvent(event)
        manager.start()
        yield* Effect.promise(async () => {
          const response = await Effect.runPromise(
            publicApi.ask(
              { prompt: "project request", maxTokens: 16, timeoutMs: 5_000 },
              {} as never,
            ),
          )
          expect(response).toMatchObject({ ok: true, text: "default authority" })
          expect(defaultCalls).toEqual([{ method: "ask", location: undefined }])
          await expect(Effect.runPromise(relay.discover({}, {} as never))).resolves.toEqual({
            requests: [],
          })
          await manager.close()
        })
      }),
    ),
  )
})
