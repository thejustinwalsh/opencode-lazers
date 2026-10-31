import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import type { TaskReads } from "./read.ts"
import { Tasks } from "./contract.ts"

export function registerTaskReads(ctx: Pick<Plugin.Context, "rpc">, reads: TaskReads) {
  return Effect.gen(function* () {
    const rpc = yield* ctx.rpc.register(Tasks, {
      query: (input) => Effect.sync(() => reads.query(input)),
      get: (input) => Effect.sync(() => reads.get(input)),
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
