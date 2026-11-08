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
import {
  quarantinedSession,
  beginSourceGuard,
  sourceQuarantineToolError,
  type SourceGuardRegistration,
} from "./source-quarantine.ts"

export const delegationTool = (tool: string) =>
  /(?:^|[._/])subagent(?:$|[._/])/.test(tool) ||
  ["lz-research", "lz-submit-plan", "lz-plan-command", "lz-submit-task"].includes(tool)

export function registerWorker(
  ctx: Plugin.Context,
  store: RunnerStore,
  reserved?: SourceGuardRegistration,
) {
  return Effect.gen(function* () {
    const guard =
      reserved ??
      (yield* Effect.acquireRelease(
        Effect.sync(() =>
          beginSourceGuard({
            directory: ctx.location.directory,
            projectDirectory: store.repository.projectDirectory,
          }),
        ),
        (registration) => Effect.sync(() => registration.dispose()),
      ))
    yield* ctx.agent.transform((editor) =>
      ["lazers-implementor", "auditor"].forEach((id) =>
        editor.update(Agent.ID.make(id), (agent) => {
          agent.name = Agent.Name.make(id === "auditor" ? "Auditor" : "LAZERS implementor")
          agent.description =
            id === "auditor"
              ? "Simplifies code using Fallow; Architect reviews before integration"
              : "Runtime-managed task implementation"
          agent.mode = "subagent"
          agent.hidden = true
          agent.system = [source.trim(), ...(id === "auditor" ? [auditSource.trim()] : [])].join(
            "\n\n",
          )
          if (id === "auditor")
            agent.model ??= Schema.decodeUnknownSync(Model.Ref)({
              providerID: "opencode-go",
              id: "muse-spark-1.3-contributor",
            })
          // Add denials only. Normal host/user/project coding permissions remain authoritative.
          agent.permissions = [
            { action: "subagent", resource: "*", effect: "deny" },
            { action: "lz-research", resource: "*", effect: "deny" },
            { action: "lz-submit-plan", resource: "*", effect: "deny" },
            { action: "lz-plan-command", resource: "*", effect: "deny" },
            { action: "lz-submit-task", resource: "*", effect: "deny" },
          ]
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
    yield* ctx.session.hook("context", (context) =>
      Effect.sync(() => {
        if (!attempt(context.sessionID)) return
        for (const tool of Object.keys(context.tools))
          if (delegationTool(tool)) delete context.tools[tool]
      }),
    )
    yield* ctx.tool.hook("execute.before", (call) =>
      Effect.suspend(() => {
        const quarantineError = sourceQuarantineToolError(store, call.sessionID, call.tool)
        if (quarantineError) return Effect.fail(new Tool.Error({ message: quarantineError }))
        const owned = attempt(call.sessionID)
        if (!owned) {
          if (isWorkerAgent(call.agent) && !quarantinedSession(store, call.sessionID))
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
    yield* ctx.permission.hook("evaluate", (request) =>
      Effect.sync(() => {
        // Code Mode fetch is an extension, so it does not enter the tool hook.
        if (request.action === "webfetch" && quarantinedSession(store, request.sessionID)) {
          request.effect = "deny"
          request.message = "Retained source is quarantined; use task and handoff tools."
        }
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
    // The installed capability releases before the hook registrations above.
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        guard.install(store)
        return guard
      }),
      (registration) => Effect.sync(() => registration.dispose()),
    )
    return guard
  })
}
