import { timedHooks } from "../diagnostics/stall-probe.ts"
import { isWorkerAgent } from "./worker-agent.ts"
import auditSource from "../auditor.md" with { type: "text" }
import { Model } from "@opencode/schema/model"
import { Schema } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Tool } from "@opencode/schema/tool"
import { Effect, Predicate } from "effect"
import source from "../implementor.md" with { type: "text" }
import type { RunnerStore } from "./store.ts"
import { applyAgentRoute } from "../models/agent-route-apply.ts"
import type { AgentRouteReader } from "../models/agent-route-apply.ts"
import type { DelegatedAgentCapacity } from "./delegated-agent-capacity.ts"
import { nativeChildLifecycle } from "./delegated-native-lifecycle.ts"

/** The Auditor's model when native OpenCode configuration pins none. */
export const AUDITOR_DEFAULT_MODEL = {
  providerID: "opencode-go",
  id: "muse-spark-1.3-contributor",
} as const

export const delegationTool = (tool: string) =>
  /(?:^|[._/])subagent(?:$|[._/])/.test(tool) ||
  ["lz-research", "lz-submit-plan", "lz-plan-command", "lz-submit-task"].includes(tool)

function knownPreChildFailure(message: string) {
  return (
    message.startsWith("Unknown agent:") ||
    message.startsWith("Invalid model ") ||
    message.startsWith("Model ") ||
    message.startsWith("Variant ") ||
    /^Agent .+ cannot run as a subagent$/.test(message) ||
    message.startsWith("Subagent depth limit reached") ||
    message.startsWith("Subagent denied:") ||
    message.startsWith("Parent session not found:") ||
    message.startsWith("Subagent session not found:")
  )
}

function nativeChildIDFromError(message: string) {
  return (
    message.match(/sessionID:\s*([^\s)]+)/)?.[1] ??
    message.match(/Failed to prompt subagent:\s*([^\s)]+)/)?.[1]
  )
}

/**
 * The Implementor and Auditor agents. Model precedence per agent: the LAZERS route (this
 * project's, else the shared one), then the native OpenCode configuration, then (Auditor only)
 * the plugin default. An Implementor attempt's persona route still wins at dispatch.
 */
/**
 * One agent's model. A LAZERS route (this project's, else the shared one) wins; otherwise the
 * native OpenCode configuration already on the agent stands; the Auditor alone has a plugin
 * default beneath that. Exported for tests.
 */
export function applyWorkerModel(
  id: string,
  agent: { model?: unknown },
  routes?: AgentRouteReader,
) {
  const set = routes?.(id)
  if (set) applyAgentRoute(agent, set.route)
  else if (id === "auditor")
    agent.model ??= Schema.decodeUnknownSync(Model.Ref)(AUDITOR_DEFAULT_MODEL)
}

export function registerWorker(
  ctx: Plugin.Context,
  store: RunnerStore,
  routes?: AgentRouteReader,
  capacity?: DelegatedAgentCapacity,
  wakeScheduler?: () => void,
) {
  return Effect.gen(function* () {
    yield* ctx.agent.transform((editor) =>
      ["lazers-implementor", "auditor"].forEach((id) =>
        editor.update(Agent.ID.make(id), (agent) => {
          agent.name = Agent.Name.make(id === "auditor" ? "Auditor" : "Implementor")
          agent.description =
            id === "auditor"
              ? "Simplifies code using Fallow; Architect reviews before integration"
              : "Runtime-managed task implementation"
          agent.mode = "subagent"
          agent.hidden = true
          agent.system = [source.trim(), ...(id === "auditor" ? [auditSource.trim()] : [])].join(
            "\n\n",
          )
          applyWorkerModel(id, agent, routes)
          // Preserve native defaults and configured rules before our delegation denials.
          const permissions: typeof agent.permissions = [
            ...Agent.Info.default(Agent.ID.make(id)).permissions,
            ...agent.permissions,
            { action: "subagent", resource: "*", effect: "deny" },
            { action: "lz-research", resource: "*", effect: "deny" },
            { action: "lz-submit-plan", resource: "*", effect: "deny" },
            { action: "lz-plan-command", resource: "*", effect: "deny" },
            { action: "lz-submit-task", resource: "*", effect: "deny" },
            // lz-fallow-config stays read/draft-only for workers; only the set effect is denied.
            { action: "lz-fallow-config-set", resource: "*", effect: "deny" },
            ...(id === "lazers-implementor"
              ? [{ action: "lz-fallow-check", resource: "*", effect: "deny" } as const]
              : []),
          ]
          agent.permissions = permissions.filter(
            (rule, index) =>
              !permissions
                .slice(index + 1)
                .some(
                  (later) =>
                    later.action === rule.action &&
                    later.resource === rule.resource &&
                    later.effect === rule.effect,
                ),
          )
          // Preserve the model/effort selected in native OpenCode configuration.
          delete agent.steps
        }),
      ),
    )
    const attempt = (sessionID: string) =>
      store.atomic((db) =>
        db
          .query<
            { id: string; task_id: string; tool_count: number; retry_count: number },
            [string]
          >(
            "SELECT id,task_id,tool_count,retry_count FROM runner_attempts WHERE session_id=? AND state IN ('preparing','running','verifying')",
          )
          .get(sessionID),
      )
    const nativeChildren = capacity
      ? yield* nativeChildLifecycle(ctx, capacity, wakeScheduler)
      : undefined
    yield* timedHooks(ctx.session, "session").hook("context", (context) =>
      Effect.sync(() => {
        if (!attempt(context.sessionID)) return
        for (const tool of Object.keys(context.tools))
          if (delegationTool(tool)) delete context.tools[tool]
      }),
    )
    yield* timedHooks(ctx.tool, "tool").hook("execute.before", (call) =>
      Effect.suspend(() => {
        const owned = attempt(call.sessionID)
        if (!owned) {
          if (isWorkerAgent(call.agent))
            return Effect.fail(
              new Tool.Error({ message: "Implementor requires an admitted runtime assignment" }),
            )
          if (
            capacity &&
            /(?:^|[._/])subagent(?:$|[._/])/.test(call.tool) &&
            typeof call.input === "object" &&
            call.input !== null &&
            "agent" in call.input &&
            typeof call.input.agent === "string" &&
            call.input.agent.toLowerCase() !== "architect" &&
            "description" in call.input &&
            typeof call.input.description === "string"
          )
            return Effect.tryPromise({
              try: async (signal) => {
                if (
                  String(call.agent).toLowerCase() !== "architect" &&
                  !(await capacity.isLazersNativeParent(call.sessionID))
                )
                  return
                const input = call.input as {
                  agent: string
                  description: string
                  sessionID?: string
                }
                const requestID = await capacity.ensureNativeQueued({
                  parentSessionID: call.sessionID,
                  toolCallID: call.id,
                  agent: input.agent,
                  description: input.description,
                  ...(input.sessionID ? { existingSessionID: input.sessionID } : {}),
                })
                await capacity.waitForNative(requestID, signal)
              },
              catch: (error) =>
                new Tool.Error({
                  message: error instanceof Error ? error.message : String(error),
                }),
            })
          return Effect.void
        }
        if (delegationTool(call.tool))
          return Effect.fail(
            new Tool.Error({ message: "Only the LAZERS runtime may dispatch agents" }),
          )
        store.atomic((db) =>
          db.query("UPDATE runner_attempts SET tool_count=tool_count+1 WHERE id=?").run(owned.id),
        )
        return Effect.void
      }),
    )
    if (capacity)
      yield* timedHooks(ctx.tool, "tool").hook("execute.after", (call) =>
        Effect.gen(function* () {
          try {
            const input = Predicate.isObject(call.input) ? call.input : undefined
            if (
              !/(?:^|[._/])subagent(?:$|[._/])/.test(call.tool) ||
              typeof input?.agent !== "string" ||
              input.agent.toLowerCase() === "architect"
            )
              return
            const request = yield* Effect.promise(() =>
              capacity.nativeRequest(call.sessionID, call.id),
            )
            if (!request) return
            const background = input.background === true
            const metadata =
              call.status === "completed" && Predicate.isObject(call.result.metadata)
                ? call.result.metadata
                : undefined
            const message = call.status === "error" ? call.error.message : ""
            const childID =
              (typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined) ??
              (typeof input.sessionID === "string" ? input.sessionID : undefined) ??
              nativeChildIDFromError(message)
            if (childID) {
              yield* Effect.promise(() => capacity.bindNativeChild(request.id, childID))
              if (call.status === "completed" && metadata?.status === "completed") {
                const released = yield* Effect.promise(() =>
                  capacity.releaseNativeRequest(request.id, request.request_key),
                )
                if (released) wakeScheduler?.()
              } else {
                if (nativeChildren) yield* nativeChildren.watch(childID)
              }
              return
            }
            if (
              (call.status === "completed" && !background) ||
              (call.status === "error" && knownPreChildFailure(message))
            ) {
              const released = yield* Effect.promise(() =>
                capacity.releaseNativeRequest(request.id, request.request_key),
              )
              if (released) wakeScheduler?.()
            }
          } catch {
            // Admission bookkeeping must not change a native tool's result.
          }
        }),
      )
    if (capacity)
      yield* timedHooks(ctx.session, "session").hook("experimental.idle", (idle) =>
        Effect.promise(async () => {
          try {
            for (const background of idle.background) {
              if (background.kind !== "subagent") continue
              const request = await capacity.nativeRequestForChild(
                background.sessionID,
                background.agent,
                background.description,
              )
              if (!request) continue
              await capacity.bindNativeChild(request.id, background.childSessionID)
            }
            if (nativeChildren) await Effect.runPromise(nativeChildren.watch(idle.sessionID))
          } catch {
            // An idle notification may outlive a removed native helper session.
          }
        }),
      )
    yield* timedHooks(ctx.session, "session").hook("retry", (retry) =>
      Effect.sync(() => {
        const owned = attempt(retry.sessionID)
        if (!owned) return
        store.atomic((db) =>
          db.query("UPDATE runner_attempts SET retry_count=retry_count+1 WHERE id=?").run(owned.id),
        )
      }),
    )
  })
}
