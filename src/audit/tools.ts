import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { z } from "zod"
import { fallowReport } from "./report.ts"

export function registerAuditTools(ctx: Pick<Plugin.Context, "tool" | "permission" | "location">) {
  return ctx.tool.transform((editor) =>
    editor.add({
      name: "lz-fallow-report",
      description:
        "Run bundled Fallow static analysis of this workspace and save the full JSON report under design/audits. Returns the report path and summaries for dead code/dependencies, duplication, complexity/CSS health, architecture and feature flags. Findings are refactoring candidates, not acceptance gates. Read relevant findings and source before editing. One analysis thread by default; threads can be selected for a larger machine. Optional model-based similar-code analysis is not started.",
      input: z.strictObject({ threads: z.int().positive().default(1) }),
      output: z.strictObject({
        reportPath: z.string(),
        startedAt: z.number(),
        finishedAt: z.number(),
        analyses: z.array(
          z.strictObject({
            name: z.string(),
            summary: z.unknown().optional(),
            error: z.string().optional(),
          }),
        ),
      }),
      options: { codemode: true, permission: "lz-fallow-report" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-fallow-report",
            resources: [ctx.location.directory],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async (signal) => {
                  const output = await fallowReport(ctx.location.directory, input.threads, signal)
                  return { content: JSON.stringify(output), output }
                },
                catch: (error) =>
                  new Tool.Error({
                    message: error instanceof Error ? error.message : String(error),
                  }),
              }),
            ),
          ),
    }),
  )
}
