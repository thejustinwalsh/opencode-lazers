import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { Tool } from "@opencode/schema/tool"
import { z } from "zod"
import type { TaskReads } from "./read.ts"
import { Tasks } from "./contract.ts"
import type { TaskRuntime } from "../runner/runtime.ts"
import { databaseChanges } from "../database-events.ts"
import { TaskAdviceInput, recordTaskAdvice } from "./advice.ts"

export function registerTaskReads(
  ctx: Pick<Plugin.Context, "rpc" | "permission"> & Partial<Pick<Plugin.Context, "tool">>,
  reads: TaskReads,
  runtime: TaskRuntime,
) {
  return Effect.gen(function* () {
    const rpc = yield* ctx.rpc.register(Tasks, {
      query: (input) => Effect.sync(() => reads.query(input)),
      get: (input) => Effect.sync(() => reads.get(input)),
      start: (input) =>
        Effect.tryPromise({
          try: async () => {
            const actor = await runtime.host.session(input.sessionID)
            if (!actor || actor.archived || actor.projectID !== runtime.projectID || !actor.agent)
              throw new Error("Start requires a live session in this project")
            await Effect.runPromise(
              ctx.permission.assert({
                sessionID: Session.ID.make(actor.id),
                agent: Agent.ID.make(actor.agent),
                action: "lz-start-task",
                resources: [input.taskID],
              }),
            )
            return runtime.startTask(input)
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.orDie),
    })
    if (ctx.tool)
      yield* ctx.tool.transform((editor) => {
        editor.add({
          name: "lz-attach-task-advice",
          description:
            "Architect-only: attach concise findings and implementation advice to an existing task without changing its specification. Supply a requestID, the exact current advice expectedRevision (0 when absent), and the task specRevision. Reuse requestID only for exact retries; changed content conflicts. Advice history is bounded and retained. Optional source/mini-skill references are links only and are never fetched.",
          input: z.toJSONSchema(TaskAdviceInput, { io: "input" }),
          options: { codemode: true, permission: "lz-attach-task-advice" },
          execute: (input, context) =>
            ctx.permission
              .assert({
                sessionID: context.sessionID,
                agent: context.agent,
                action: "lz-attach-task-advice",
                resources: ["*"],
              })
              .pipe(
                Effect.flatMap(() =>
                  Effect.tryPromise({
                    try: async () => {
                      if (context.agent !== "architect")
                        throw new Tool.Error({
                          message: "Task advice attachment is restricted to Architect",
                        })
                      const receipt = recordTaskAdvice(reads.repository, input, {
                        sessionID: context.sessionID,
                        agent: String(context.agent),
                      })
                      return { content: JSON.stringify(receipt) }
                    },
                    catch: (error) =>
                      error instanceof Tool.Error
                        ? error
                        : new Tool.Error({
                            message: error instanceof Error ? error.message : String(error),
                          }),
                  }),
                ),
              ),
        })
      })
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        let published = reads.repository.version()
        let publishing = false
        let closed = false
        let pending = false
        let retry: ReturnType<typeof setTimeout> | undefined
        const retryPublish = () => {
          if (closed || retry) return
          retry = setTimeout(() => {
            retry = undefined
            publish()
          }, 1_000)
          retry.unref()
        }
        const publish = () => {
          if (closed) return
          if (publishing) {
            pending = true
            return
          }
          let version: number
          try {
            version = reads.repository.version()
          } catch {
            retryPublish()
            return
          }
          if (version === published) return
          publishing = true
          void Effect.runPromise(
            rpc.events.emit("changed", {
              projectDirectory: reads.repository.projectDirectory,
              version,
            }),
          )
            .then(() => {
              published = version
            }, retryPublish)
            .finally(() => {
              publishing = false
              if (pending) {
                pending = false
                publish()
              }
            })
        }
        const unwatch = databaseChanges.subscribe(reads.repository.path, publish, () => {})
        return () => {
          closed = true
          if (retry) clearTimeout(retry)
          unwatch()
        }
      }),
      (close) => Effect.sync(close),
    )
  })
}
