import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import source from "../implementor.md" with { type: "text" }
import type { RunnerStore } from "./store.ts"

export const delegationTool = (tool: string) =>
  /(?:^|[._/])subagent(?:$|[._/])/.test(tool) ||
  ["lazers_research", "lazers_submit_plan", "lazers_plan_command", "lazers_submit_task"].includes(
    tool,
  )

export function registerWorker(ctx: Plugin.Context, store: RunnerStore) {
  return Effect.gen(function* () {
    yield* ctx.agent.transform((editor) =>
      editor.update(Agent.ID.make("lazers-implementor"), (agent) => {
        agent.name = Agent.Name.make("LAZERS implementor")
        agent.description = "Runtime-managed task implementation"
        agent.mode = "subagent"
        agent.hidden = true
        agent.system = source.trim()
        // Add denials only. Normal host/user/project coding permissions remain authoritative.
        agent.permissions = [
          { action: "subagent", resource: "*", effect: "deny" },
          { action: "lazers_research", resource: "*", effect: "deny" },
          { action: "lazers_submit_plan", resource: "*", effect: "deny" },
          { action: "lazers_plan_command", resource: "*", effect: "deny" },
          { action: "lazers_submit_task", resource: "*", effect: "deny" },
        ]
        delete agent.model
        delete agent.steps
      }),
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
    yield* ctx.session.hook("context", (context) =>
      Effect.sync(() => {
        if (!attempt(context.sessionID)) return
        for (const tool of Object.keys(context.tools))
          if (delegationTool(tool)) delete context.tools[tool]
      }),
    )
    yield* ctx.tool.hook("execute.before", (call) =>
      Effect.suspend(() => {
        const owned = attempt(call.sessionID)
        if (!owned) {
          if (call.agent === "lazers-implementor")
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
    yield* ctx.session.hook("retry", (retry) =>
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
