import { timedHooks } from "../diagnostics/stall-probe.ts"
import { isWorkerAgent } from "./worker-agent.ts"
import auditSource from "../auditor.md" with { type: "text" }
import { Model } from "@opencode/schema/model"
import { Schema } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import source from "../implementor.md" with { type: "text" }
import type { RunnerStore } from "./store.ts"
import { applyAgentRoute } from "../models/agent-route-apply.ts"
import type { AgentRouteReader } from "../models/agent-route-apply.ts"
import { stubSuperseded } from "./context-stubs.ts"
import type { ContextMessage } from "./context-stubs.ts"
import { StubHorizons } from "./context-horizon.ts"

/** The Auditor's model when native OpenCode configuration pins none. */
export const AUDITOR_DEFAULT_MODEL = {
  providerID: "opencode-go",
  id: "muse-spark-1.3-contributor",
} as const

export const delegationTool = (tool: string) =>
  /(?:^|[._/])subagent(?:$|[._/])/.test(tool) ||
  ["lz-research", "lz-submit-plan", "lz-plan-command", "lz-submit-task"].includes(tool)

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

export function registerWorker(ctx: Plugin.Context, store: RunnerStore, routes?: AgentRouteReader) {
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
            // lz-fallow-config stays read/suggest/dry-run for workers; only the set effect is denied.
            { action: "lz-fallow-config-set", resource: "*", effect: "deny" },
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

/**
 * The Architect's requests carry superseded notices and obsolete reads as one-line stubs, in the
 * request only: storage and the transcript are untouched. See `context-stubs.ts` for the rules and
 * `context-horizon.ts` for when they may change. Never throws: a failure leaves the messages as
 * they were and is logged once, because a throw here would fail the Architect's step and the
 * `context` hooks of other plugins.
 */
export function registerArchitectContextStubs(
  ctx: Pick<Plugin.Context, "session">,
  options: {
    cacheWindowMs?: number
    horizons?: StubHorizons
    log?: (message: string, fields: Record<string, unknown>) => void
  } = {},
) {
  const horizons = options.horizons ?? new StubHorizons(options.cacheWindowMs)
  const log =
    options.log ??
    ((message: string, fields: Record<string, unknown>) =>
      void Effect.runFork(Effect.logWarning(message, fields)))
  let logged = false
  return timedHooks(ctx.session, "session").hook("context", (context) =>
    Effect.sync(() => {
      if (String(context.agent) !== "architect") return
      try {
        const { horizon } = horizons.horizonFor(
          context.sessionID,
          context.messages as readonly ContextMessage[],
        )
        const stubbed = stubSuperseded(context.messages as readonly ContextMessage[], { horizon })
        if (stubbed.stubbed > 0)
          context.messages.splice(0, context.messages.length, ...(stubbed.messages as never[]))
      } catch (error) {
        if (logged) return
        logged = true
        log("LAZERS context stubs failed; the request is sent unchanged", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }),
  )
}
