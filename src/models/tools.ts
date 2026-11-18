import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { isAgentSubject } from "./agent-ids.ts"
import { ModelMappingUpdateSchema } from "./mapping-schema.ts"
import {
  ModelMappingWriteOutputSchema,
  ModelSettingsInputSchema,
  ModelSettingsOutputSchema,
} from "./contract.ts"
import { ModelSettingsService } from "./service.ts"
import { TaskRepository } from "../storage.ts"

type ModelToolContext = Pick<Plugin.Context, "tool" | "permission"> & {
  /** Re-runs the agent transforms after an agent route changes. */
  agent?: Pick<Plugin.Context["agent"], "reload">
}

/** Register the Architect Code Mode surface against the same persisted mapping authority as RPC. */
export function registerModelTools(ctx: ModelToolContext, repository: TaskRepository) {
  const path = repository.path
  const projectDirectory = repository.projectDirectory
  const withRepository = <T>(run: (connection: TaskRepository) => T): T => {
    const connection = new TaskRepository(path, projectDirectory)
    try {
      return run(connection)
    } finally {
      connection.close()
    }
  }

  return ctx.tool.transform((editor) => {
    editor.add({
      name: "lz-get-model-settings",
      description:
        "Read the exact saved shared, project and optional task model routes for each worker persona, including revisions, inheritance resolution and provenance. Saved routes are not filtered or substituted using the live catalog.",
      input: ModelSettingsInputSchema,
      output: ModelSettingsOutputSchema,
      options: { codemode: true, pinned: true, permission: "lz-get-model-settings" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-get-model-settings",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  const output = withRepository((connection) =>
                    new ModelSettingsService(connection).settings(input),
                  )
                  return { content: JSON.stringify(output), output }
                },
                catch: (error) =>
                  new Tool.Error({
                    message: error instanceof Error ? error.message : String(error),
                  }),
              }),
            ),
          ),
    })

    editor.add({
      name: "lz-configure-models",
      description:
        "Architect-only exact route update for a shared, project or existing project-task persona mapping, or a shared or project route for an agent (architect, lazers-implementor, auditor). Supply the current expectedRevision; stale writes return a conflict with the current record and are never retried automatically. Use route null to remove an override and reveal inheritance.",
      input: ModelMappingUpdateSchema,
      output: ModelMappingWriteOutputSchema,
      options: { codemode: true, pinned: true, permission: "lz-configure-models" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-configure-models",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() => {
              if (call.agent !== "architect")
                return Effect.fail(
                  new Tool.Error({ message: "Model settings changes are restricted to Architect" }),
                )
              return Effect.tryPromise({
                try: async () => {
                  const output = withRepository((connection) =>
                    new ModelSettingsService(connection).configure(input),
                  )
                  if (ctx.agent && output.status === "updated" && isAgentSubject(input.persona))
                    await Effect.runPromise(ctx.agent.reload())
                  return { content: JSON.stringify(output), output }
                },
                catch: (error) =>
                  error instanceof Tool.Error
                    ? error
                    : new Tool.Error({
                        message: error instanceof Error ? error.message : String(error),
                      }),
              })
            }),
          ),
    })
  })
}
