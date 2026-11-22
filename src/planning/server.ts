import type { HostMessageClient } from "../core/host-messages.ts"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect } from "effect"
import { pointer, runbook } from "../guidance/index.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { timedHooks, timedRpc } from "../diagnostics/stall-probe.ts"
import type { InferenceBroker } from "../webgpu/broker.ts"
import { defaultFeatures, FeatureSettings, featureEnabled } from "../webgpu/features.ts"
import { LocalInference } from "../webgpu/rpc.ts"
import { globalSettings } from "../projects/settings.ts"
import { SystemOneRequest, type SystemOneInput } from "../webgpu/system-one.ts"
import type { TaskRepository } from "../storage.ts"
import { deciderFor, localDecider, type ExternalGenerate } from "./decision/deciders.ts"
import { PlanningDecisions } from "./decision/step.ts"
import { currentRepoMap } from "../context/repo-map-store.ts"
import type { AgentRouteReader } from "../models/agent-route-apply.ts"
import { sharedScheduler } from "../runner/scheduler-coordinator.ts"
import { mapPathsOf } from "./checks.ts"
import { planningHost, planningModel } from "./host.ts"
import { PlanningReviews } from "./reviews.ts"
import { PlanningRpc } from "./rpc-contract.ts"
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
    // The drafting runbook rides the first note of a session, a pointer after. A brainstorm is
    // the Architect's own call, so it is not delivered here: the drafting runbook says when to
    // recommend one and `lz-plan-draft` `guide` returns it.
    runbook: (first) => (first ? runbook("planning-draft") : pointer("planning-draft")),
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

/**
 * `lz.planning`: what a plan link needs to know the plan is this project's. The Plan panel reads
 * plans through the `planning.list` and `planning.detail` streams.
 */
export function registerPlanningRpc(
  ctx: Pick<Plugin.Context, "rpc">,
  repository: TaskRepository,
  projectID: string,
) {
  const store = new PlanningStore(repository)
  return timedRpc(ctx.rpc).register(PlanningRpc, {
    resolve: (input) =>
      Effect.sync(() => {
        const row = store.planning(input.planningID)
        return row && row.projectKey === projectID
          ? ({
              status: "found",
              planningID: row.id,
              projectKey: row.projectKey,
              projectDirectory: row.projectDirectory,
            } as const)
          : ({ status: "not_found" } as const)
      }),
  })
}

/** The review executor of one project, over the native session API and the repository map. */
export function createPlanningReviews(
  ctx: Pick<Plugin.Context, "session">,
  repository: TaskRepository,
  routes: AgentRouteReader | undefined,
  messages: HostMessageClient,
): PlanningReviews {
  return new PlanningReviews({
    store: new PlanningStore(repository),
    host: planningHost(ctx, messages),
    now: Date.now,
    mapFor: async (directory) => {
      const map = await currentRepoMap(repository, directory, repository.projectDirectory)
      return { text: map.text, hash: map.hash, tokens: map.tokens, paths: mapPathsOf(map.text) }
    },
    notify: async (sessionID, id, text) => {
      await Effect.runPromise(
        ctx.session.synthetic({
          sessionID: Session.ID.make(sessionID),
          id: SessionMessage.ID.make(id),
          text,
          resume: true,
          delivery: "queue",
          description: "LAZERS planning review",
        }),
      )
    },
    title: (agent, revision) => `Planning ${agent} r${revision}`,
    model: () => planningModel(routes),
  })
}

/**
 * One participant per project that advances open reviews no caller is waiting on, so a review
 * cut short by a restart settles and is reported without the Architect doing anything.
 */
export function registerPlanningReviewTicks(reviews: PlanningReviews, projectDirectory: string) {
  return Effect.acquireRelease(
    Effect.sync(() =>
      sharedScheduler.register(JSON.stringify(["planning", projectDirectory]), {
        intervalMs: 1_000,
        run: () => reviews.tick(),
        onError: () => undefined,
      }),
    ),
    (registration) => Effect.promise(() => registration.dispose()),
  )
}

/**
 * The text of one message of a session, for checking an Architect's quote of the conversation.
 * One point read by message ID; the conversation is never read.
 */
export function sessionMessageText(
  readMessage: (sessionID: string, messageID: string) => Promise<{ text: string } | undefined>,
) {
  return async (sessionID: string, messageID: string): Promise<string | undefined> =>
    (await readMessage(sessionID, messageID))?.text
}
