import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import type { TaskReads } from "./read.ts"
import { Tasks } from "./contract.ts"
import type { TaskRuntime } from "../runner/runtime.ts"

export function registerTaskReads(
  ctx: Pick<Plugin.Context, "rpc" | "permission">,
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
                action: "lazers_start_task",
                resources: [input.taskID],
              }),
            )
            return runtime.startTask(input)
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.orDie),
    })
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        let published = reads.repository.version()
        let publishing = false
        let closed = false
        const publish = () => {
          if (closed || publishing) return
          const version = reads.repository.version()
          if (version === published) return
          publishing = true
          void Effect.runPromise(
            rpc.events.emit("changed", {
              projectDirectory: reads.repository.projectDirectory,
              version,
            }),
          )
            .then(
              () => {
                published = version
              },
              () => {},
            )
            .finally(() => {
              publishing = false
            })
        }
        const unsubscribe = reads.repository.subscribe(publish)
        // Each location owns a SQLite connection. A durable watermark catches other
        // instances/processes and repairs missed best-effort notifications.
        const timer = setInterval(publish, 1_000)
        return () => {
          closed = true
          clearInterval(timer)
          unsubscribe()
        }
      }),
      (close) => Effect.sync(close),
    )
  })
}
