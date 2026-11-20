import { trailingAssistants, type HostMessageClient } from "../core/host-messages.ts"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { AbsolutePath } from "@opencode/schema/schema"
import type { Plugin } from "@opencode/plugin/effect"
import { DateTime, Effect } from "effect"
import type { AgentRouteReader } from "../models/agent-route-apply.ts"
import type { ModelPolicy } from "../runner/schema.ts"
import { PLANNING_ROUTE_ID } from "./register.ts"

/** A native provider/model (and effort) reference, as `ModelPolicy` carries it. */
export type ModelRef = ModelPolicy

export type PlanningReply = {
  text: string
  /** The native finish reason of the last assistant message; `"length"` means truncated. */
  finish: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  model?: ModelRef
}

export type PlanningObservation =
  | { found: false }
  | {
      found: true
      updatedAt: number
      busyAt?: number
      idleAt?: number
      outcome?: "succeeded" | "failed" | "interrupted"
    }

/**
 * The small port the review executor uses to run a planning child session. Completion is read
 * from execution events (`busyAt` newer than the prompt, `idleAt` at or after `busyAt`), never
 * from `session.wait`, which can report idle before the prompt has run.
 */
export interface PlanningHost {
  /** Create a hidden child under `parentID`. An id that already exists is `"exists"`. */
  create(input: {
    id: string
    parentID: string
    agent: string
    model?: ModelRef
    directory: string
    title: string
  }): Promise<"created" | "exists">
  /**
   * Queue the prompt as message `messageID`. `directory` is the child's location, recorded for
   * the caller; the native prompt addresses the session by id.
   */
  prompt(input: {
    sessionID: string
    messageID: string
    text: string
    directory: string
  }): Promise<void>
  observe(sessionID: string): Promise<PlanningObservation>
  /** The final assistant text of the last execution, with token counts summed over its steps. */
  reply(sessionID: string): Promise<PlanningReply | undefined>
  interrupt(sessionID: string): Promise<void>
}

const isNotFound = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error._tag === "Session.NotFoundError" || error._tag === "SessionNotFoundError")

/**
 * The model the planning agents run on: the shared `lazers-planning` route, else the
 * Implementor's. Undefined means the registered agent's own route applies.
 */
export function planningModel(routes?: AgentRouteReader): ModelRef | undefined {
  return (routes?.(PLANNING_ROUTE_ID) ?? routes?.("lazers-implementor"))?.route
}

export function planningHost(
  ctx: Pick<Plugin.Context, "session">,
  messages: HostMessageClient,
): PlanningHost {
  const session = ctx.session
  const read = (sessionID: string) =>
    Effect.runPromise(
      session.get({ sessionID: Session.ID.make(sessionID) }).pipe(
        Effect.map((value) => ({ found: true as const, value })),
        Effect.catch((error) =>
          isNotFound(error) ? Effect.succeed({ found: false as const }) : Effect.fail(error),
        ),
      ),
    )
  return {
    async create(input) {
      const model = input.model
        ? {
            id: Model.ID.make(input.model.id),
            providerID: Provider.ID.make(input.model.providerID),
            ...(input.model.variant ? { variant: Model.VariantID.make(input.model.variant) } : {}),
          }
        : undefined
      try {
        await Effect.runPromise(
          session.create({
            id: Session.ID.make(input.id),
            parentID: Session.ID.make(input.parentID),
            agent: Agent.ID.make(input.agent),
            ...(model ? { model } : {}),
            location: { directory: AbsolutePath.make(input.directory) },
            title: input.title,
            metadata: { lazersPlanningRun: input.id },
          }),
        )
        return "created"
      } catch (error) {
        // The native API has no typed duplicate error: a failed create whose id now reads back
        // is the same session created earlier (ids are recorded before creation).
        if ((await read(input.id)).found) return "exists"
        throw error
      }
    },
    async prompt(input) {
      await Effect.runPromise(
        session.prompt({
          sessionID: Session.ID.make(input.sessionID),
          id: SessionMessage.ID.make(input.messageID),
          text: input.text,
        }),
      )
    },
    async observe(sessionID) {
      const observed = await read(sessionID)
      if (!observed.found) return { found: false }
      const { time, outcome } = observed.value
      return {
        found: true,
        updatedAt: DateTime.toEpochMillis(time.updated),
        ...(time.busy ? { busyAt: DateTime.toEpochMillis(time.busy) } : {}),
        ...(time.idle ? { idleAt: DateTime.toEpochMillis(time.idle) } : {}),
        ...(outcome ? { outcome } : {}),
      }
    },
    async reply(sessionID) {
      // The last execution's steps: every assistant message after the last user message,
      // read from the end of the conversation by page.
      const steps = await trailingAssistants(messages, sessionID)
      const last = [...steps].reverse().find((message) => message.content?.some(isText))
      if (!last) return undefined
      return {
        text: (last.content ?? [])
          .filter(isText)
          .map((part) => part.text)
          .join("\n"),
        finish: steps[steps.length - 1]?.finish ?? null,
        inputTokens: steps.reduce((sum, step) => sum + (step.tokens?.input ?? 0), 0),
        outputTokens: steps.reduce((sum, step) => sum + (step.tokens?.output ?? 0), 0),
        cacheReadTokens: steps.reduce((sum, step) => sum + (step.tokens?.cache.read ?? 0), 0),
        model: {
          providerID: last.model.providerID,
          id: last.model.id,
          ...(last.model.variant ? { variant: last.model.variant } : {}),
        },
      }
    },
    async interrupt(sessionID) {
      await Effect.runPromise(session.interrupt({ sessionID: Session.ID.make(sessionID) }))
    },
  }
}

const isText = (part: { type: string }): part is { type: "text"; text: string } =>
  part.type === "text"
