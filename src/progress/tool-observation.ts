import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Cause, Effect, Exit } from "effect"
import type { ProgressRecorder, ToolInvocation } from "./recorder.ts"

const originalExecution = Symbol.for("opencode-lazers.tool-observation.original")

type ScopeEntry = { read: Promise<boolean>; valid: { current: boolean } }
type ObservationScope = {
  clear(): void
  forget(sessionID: string): void
  owns(sessionID: string, refresh?: boolean): Promise<boolean>
}

/**
 * Warm ownership answers per scope. An entry is a session id, a settled promise and a flag,
 * roughly 300 bytes, so 4_096 entries stay near 1.2 MB. Eviction costs one `session.get`.
 */
const SCOPE_ENTRIES = 4_096

const scopesKey = Symbol.for("opencode-lazers.tool-observation-scopes.v1")
const scopeHost = globalThis as typeof globalThis & { [scopesKey]?: Set<WeakRef<ObservationScope>> }
const liveScopes: Set<WeakRef<ObservationScope>> = (scopeHost[scopesKey] ??= new Set())

/** A session ended or moved: every live scope in the process drops what it knows about it. */
export function endObservedSession(sessionID: string) {
  for (const ref of liveScopes) {
    const scope = ref.deref()
    if (scope) scope.forget(sessionID)
    else liveScopes.delete(ref)
  }
}

/** One owner per native location; event subscriptions themselves are server-wide. */
export function toolObservationScope(
  ctx: Pick<Plugin.Context, "session" | "location">,
  projectID: string,
  directory: string,
) {
  const sessions = new Map<string, ScopeEntry>()
  let revision = 0
  const read = (sessionID: string, valid: { current: boolean }, readRevision: number) => {
    const result: Promise<boolean> = Promise.resolve()
      .then(() => Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(sessionID) })))
      .then(
        (session) =>
          revision === readRevision &&
          valid.current &&
          session.projectID === projectID &&
          session.location.directory === directory,
      )
    return result
  }
  const scope: ObservationScope = {
    clear: () => {
      revision++
      for (const entry of sessions.values()) entry.valid.current = false
      sessions.clear()
    },
    forget: (sessionID: string) => {
      const entry = sessions.get(sessionID)
      if (!entry) return
      entry.valid.current = false
      sessions.delete(sessionID)
    },
    owns: (sessionID: string, refresh = false): Promise<boolean> => {
      // A refreshing caller wants a fresh answer for this call only; nothing is retained.
      if (refresh) return read(sessionID, { current: true }, revision).catch(() => false)
      const cached = sessions.get(sessionID)
      if (cached) {
        sessions.delete(sessionID)
        sessions.set(sessionID, cached)
        return cached.read
      }
      const valid = { current: true }
      const result: Promise<boolean> = read(sessionID, valid, revision).catch(() => {
        if (sessions.get(sessionID)?.read === result) sessions.delete(sessionID)
        return false
      })
      sessions.set(sessionID, { read: result, valid })
      while (sessions.size > SCOPE_ENTRIES) {
        const oldest = sessions.keys().next().value
        if (oldest === undefined) break
        sessions.delete(oldest)
      }
      return result
    },
  }
  liveScopes.add(new WeakRef(scope))
  return scope
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
