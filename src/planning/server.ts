import { Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { timedHooks } from "../diagnostics/stall-probe.ts"
import type { InferenceBroker } from "../webgpu/broker.ts"
import { defaultFeatures, FeatureSettings, featureEnabled } from "../webgpu/features.ts"
import { LocalInference } from "../webgpu/rpc.ts"
import { globalSettings } from "../projects/settings.ts"
import { SystemOneRequest, type SystemOneInput } from "../webgpu/system-one.ts"
import type { TaskRepository } from "../storage.ts"
import { deciderFor, localDecider, type ExternalGenerate } from "./decision/deciders.ts"
import { PlanningDecisions } from "./decision/step.ts"
import { PlanningStore } from "./store.ts"

/**
 * The decision service of one project. Settings choose the model (the local D1 behind the
 * broker, an external catalogue model, or none, so the Architect classifies) and the slicer; both
 * are read at each ask. The local "decisions" feature is read from storage the way the local
 * inference server reads it, so a switched-off feature is recorded as `feature-off`.
 */
export function createPlanningDecisions(
  ctx: Pick<Plugin.Context, "rpc" | "storage" | "options" | "experimental">,
  repository: TaskRepository,
  broker: Pick<InferenceBroker, "attached">,
  projectID: string,
): PlanningDecisions {
  const decisionsOn = async () => {
    const stored = await Effect.runPromise(ctx.storage.get("webgpu.features"))
    const parsed = FeatureSettings.safeParse(stored)
    const features = parsed.success
      ? parsed.data
      : defaultFeatures(stored === undefined && ctx.options.webgpu === true)
    return featureEnabled(features, "decisions")
  }
  const systemOne = (input: SystemOneInput, signal: AbortSignal) =>
    Effect.runPromise(ctx.rpc(LocalInference).systemOne(SystemOneRequest.parse(input)), {
      signal,
    }) as never
  const generate: ExternalGenerate = (input, signal) =>
    Effect.runPromise(ctx.experimental.generate.decisions(input as never), { signal }) as never
  return new PlanningDecisions({
    store: new PlanningStore(repository),
    projectKey: projectID,
    constants: () => ({ strategy: globalSettings(repository).decisionSlicer }),
    decider: async () => {
      const setting = globalSettings(repository).decisionModel
      const on = setting.kind === "local" ? await decisionsOn() : true
      return deciderFor(setting, {
        local: localDecider(broker, () => on, systemOne),
        generate,
      })
    },
  })
}

type ContentPart = { type: string; text?: string }
type ContextMessage = { id?: string; role: string; content: unknown }

/** The user message's own text, for the fallback match when the host leaves a message id unset. */
function textOf(message: ContextMessage): string {
  return Array.isArray(message.content)
    ? (message.content as ContentPart[])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("")
    : typeof message.content === "string"
      ? message.content
      : ""
}

/**
 * Delivers the decision note as one text part on the user message it is about, in the model
 * request only: storage and the transcript are untouched. Never throws.
 */
export function registerPlanningDecisionHooks(
  ctx: Pick<Plugin.Context, "session">,
  decisions: PlanningDecisions,
) {
  return timedHooks(ctx.session, "session").hook("context", (context) =>
    Effect.promise(async () => {
      try {
        if (String(context.agent) !== "architect") return
        const known = decisions.messagesFor(String(context.sessionID))
        if (!known.length) return
        for (const message of context.messages as unknown as ContextMessage[]) {
          if (message.role !== "user") continue
          // Match by message id; a message without one matches the recorded ask text instead.
          const match = known.find(
            (decision) =>
              (message.id !== undefined && message.id === decision.messageId) ||
              (message.id === undefined && textOf(message) === decision.askText),
          )
          if (!match) continue
          const note = await decisions.noteFor(String(context.sessionID), match.messageId)
          if (!note || !Array.isArray(message.content)) continue
          ;(message.content as ContentPart[]).push({ type: "text", text: note })
        }
      } catch {
        // The note is advisory; the request goes out unchanged.
      }
    }),
  )
}
