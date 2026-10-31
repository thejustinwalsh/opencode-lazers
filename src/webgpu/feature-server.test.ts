import { expect, test } from "bun:test"
import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { RpcClient } from "@opencode/client"
import { Effect } from "effect"
import { registerLocalInference } from "./server.ts"
import { LocalInference, RendererInference } from "./rpc.ts"
import { defaultFeatures } from "./features.ts"

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
          expect(tools.has("lazers_verify_task")).toBe(true)
          expect(architect.system).toContain(
            "For Architect self-review before lazers_submit_task, call lazers_verify_task",
          )
          expect(architect.system).toContain("This one tool owns structural validation")
          expect(architect.system).toContain("fixed System One questions")
          const oldReview = tools.get("lazers_verify_task")!
          await Effect.runPromise(worker.attach({ owner: "renderer" }, {} as never))
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
