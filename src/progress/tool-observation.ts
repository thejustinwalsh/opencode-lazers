import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Cause, Effect, Exit } from "effect"
import type { ProgressRecorder, ToolInvocation } from "./recorder.ts"

const originalExecution = Symbol.for("opencode-lazers.tool-observation.original")

/** One owner per native location; event subscriptions themselves are server-wide. */
export function toolObservationScope(
  ctx: Pick<Plugin.Context, "session" | "location">,
  projectID: string,
  directory: string,
) {
  const sessions = new Map<string, Promise<boolean>>()
  const sessionRevisions = new Map<string, number>()
  let revision = 0
  return {
    clear: () => {
      revision++
      sessions.clear()
      sessionRevisions.clear()
    },
    forget: (sessionID: string) => {
      sessionRevisions.set(sessionID, (sessionRevisions.get(sessionID) ?? 0) + 1)
      sessions.delete(sessionID)
    },
    owns: (sessionID: string, refresh = false): Promise<boolean> => {
      if (refresh) sessions.delete(sessionID)
      const cached = sessions.get(sessionID)
      if (cached) return cached
      const readRevision = revision
      const sessionRevision = sessionRevisions.get(sessionID) ?? 0
      const read: Promise<boolean> = Promise.resolve()
        .then(() => Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(sessionID) })))
        .then(
          (session) =>
            revision === readRevision &&
            (sessionRevisions.get(sessionID) ?? 0) === sessionRevision &&
            session.projectID === projectID &&
            session.location.directory === directory,
        )
        .catch(() => {
          if (sessions.get(sessionID) === read) sessions.delete(sessionID)
          return false
        })
      sessions.set(sessionID, read)
      return read
    },
  }
}

/** Observe only our callbacks. Do not replace native tools or alter their contracts. */
export function registerToolCallWrappers(
  ctx: Pick<Plugin.Context, "tool" | "session" | "location">,
  recorder: ProgressRecorder,
  projectID: string,
) {
  const scope = toolObservationScope(ctx, projectID, ctx.location.directory)
  return ctx.tool.transform((editor) => {
    for (const tool of editor.list()) {
      if (!tool.name.startsWith("lz-")) continue
      editor.update(tool.id, (entry) => {
        const previous: unknown = Reflect.get(entry.execute, originalExecution)
        const execute =
          typeof previous === "function" ? (previous as typeof entry.execute) : entry.execute
        entry.execute = function (input, context) {
          const run = () => execute.call(this, input, context)
          return Effect.gen(function* () {
            let invocation: ToolInvocation | undefined
            if (yield* Effect.promise(() => scope.owns(context.sessionID, true))) {
              try {
                invocation = recorder.beginToolInvocation({
                  tool: tool.name,
                  sessionID: context.sessionID,
                  agent: context.agent,
                  messageID: context.messageID,
                  callID: context.id,
                })
              } catch {
                // Observability cannot reject execution or retry an operation.
              }
            }
            return yield* Effect.suspend(run).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (!invocation) return
                  try {
                    recorder.endToolInvocation(
                      invocation,
                      Exit.isSuccess(exit)
                        ? { status: "completed" }
                        : {
                            status: "error",
                            error: Cause.hasInterruptsOnly(exit.cause)
                              ? { message: "Tool callback interrupted" }
                              : Cause.squash(exit.cause),
                          },
                    )
                  } catch {
                    // Keep the original result, failure, defect, or interruption.
                  }
                }),
              ),
            )
          })
        }
        Object.defineProperty(entry.execute, originalExecution, { value: execute })
      })
    }
  })
}
