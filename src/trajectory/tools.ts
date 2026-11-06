import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { z } from "zod"
import type { RunnerStore } from "../runner/store.ts"
import type { TrajectoryHost } from "./native.ts"
import { inspectTrajectory } from "./read.ts"
import { privacyStats, safeError } from "./privacy.ts"
import { InspectTrajectoryInput } from "./schema.ts"
import { openReadOnlyTrajectoryStore } from "./store.ts"
import type { TaskValuationProvider } from "../models/task-valuation.ts"

type ToolContext = Pick<Plugin.Context, "permission" | "tool">

export function registerTrajectoryTools(
  ctx: ToolContext,
  store: RunnerStore,
  host: TrajectoryHost,
  projectID: string,
  taskValuationProvider?: TaskValuationProvider,
) {
  const path = store.repository.path
  const projectDirectory = store.repository.projectDirectory
  const cursorSecret = crypto.getRandomValues(new Uint8Array(32))
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "lz-inspect-trajectory",
      description:
        "Read a redacted, project-owned worker task/attempt trajectory and total effort, including failed retries. Provide exactly one taskID or attemptID; continue with the returned cursor and unchanged limit. Only visible safe content is included; context coverage, compaction, missing usage and unknown cost are explicit.",
      input: z.toJSONSchema(InspectTrajectoryInput, { io: "input" }),
      output: z.toJSONSchema(z.record(z.string(), z.unknown()), { io: "output" }),
      options: {
        codemode: true,
        pinned: true,
        permission: "lz-inspect-trajectory",
      },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-inspect-trajectory",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async (signal) => {
                  const parsed = InspectTrajectoryInput.parse(input)
                  const connection = openReadOnlyTrajectoryStore(path, projectDirectory)
                  try {
                    const report = await inspectTrajectory(
                      connection.store,
                      host,
                      projectID,
                      parsed,
                      cursorSecret,
                      { taskValuationProvider, signal },
                    )
                    return { content: JSON.stringify(report), output: report }
                  } finally {
                    connection.close()
                  }
                },
                catch: (error) => new Tool.Error({ message: safeError(error, privacyStats()) }),
              }),
            ),
          ),
    })
  })
}
