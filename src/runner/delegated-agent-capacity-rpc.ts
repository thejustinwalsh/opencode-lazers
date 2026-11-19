import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { timedRpc } from "../diagnostics/stall-probe.ts"
import type { TaskRuntime } from "./runtime.ts"
import {
  DelegatedAgentSettingsConfigureInput,
  DelegatedAgentSettingsOutput,
  DelegatedAgentSettingsReadInput,
  DelegatedAgentSettingsWriteOutput,
  DelegatedAgentCapacityRPC,
} from "./delegated-agent-capacity-contract.ts"

function isSessionNotFound(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "SessionNotFoundError"
  )
}

async function authorize(
  ctx: Plugin.Context,
  runtime: TaskRuntime,
  sessionID: string,
  action: "lz-get-agent-capacity" | "lz-configure-agent-capacity",
  signal: AbortSignal,
) {
  const readSession = async () => {
    try {
      return await Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(sessionID) }), {
        signal,
      })
    } catch (error) {
      if (isSessionNotFound(error)) return null
      throw error
    }
  }
  const session = await readSession()
  if (
    !session ||
    String(session.id) !== sessionID ||
    session.projectID !== runtime.projectID ||
    session.time.archived !== undefined ||
    !session.agent
  )
    throw new Error("Delegated-agent settings scope is unavailable")
  await Effect.runPromise(
    ctx.permission.assert({
      sessionID: Session.ID.make(session.id),
      agent: Agent.ID.make(session.agent),
      action,
      resources: [runtime.store.repository.projectDirectory],
    }),
    { signal },
  )
  signal.throwIfAborted()
  const currentSession = await readSession()
  if (
    !currentSession ||
    String(currentSession.id) !== sessionID ||
    currentSession.projectID !== runtime.projectID ||
    currentSession.time.archived !== undefined ||
    currentSession.agent !== session.agent
  )
    throw new Error("Delegated-agent settings scope is unavailable")
}

export function registerDelegatedAgentCapacity(ctx: Plugin.Context, runtime: TaskRuntime) {
  return Effect.gen(function* () {
    yield* timedRpc(ctx.rpc).register(DelegatedAgentCapacityRPC, {
      read: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = DelegatedAgentSettingsReadInput.parse(input)
            await authorize(ctx, runtime, request.sessionID, "lz-get-agent-capacity", signal)
            signal.throwIfAborted()
            return DelegatedAgentSettingsOutput.parse(
              await runtime.delegatedAgentCapacity.settings(),
            )
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.orDie),
      configure: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = DelegatedAgentSettingsConfigureInput.parse(input)
            await authorize(ctx, runtime, request.sessionID, "lz-configure-agent-capacity", signal)
            signal.throwIfAborted()
            const result = await runtime.delegatedAgentCapacity.configure({
              expectedRevision: request.expectedRevision,
              limit: request.limit,
            })
            signal.throwIfAborted()
            return DelegatedAgentSettingsWriteOutput.parse(result)
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.orDie),
    })
  })
}
