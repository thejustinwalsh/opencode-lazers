import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { z } from "zod"
import type { ProjectIndex } from "./index.ts"

const paths = z.array(z.string().min(1).max(1024)).max(20).default([])
const IndexInput = z.strictObject({ paths })
const RefreshInput = z.strictObject({})
const EvidenceInput = z
  .strictObject({
    paths,
    search: z.string().min(1).max(200).optional(),
    level: z.enum(["full", "outline", "structure"]).default("full"),
    startLine: z.int().min(1).max(1000000).optional(),
    endLine: z.int().min(1).max(1000000).optional(),
  })
  .refine(
    (input) => !input.startLine || !input.endLine || input.startLine <= input.endLine,
    "Line range must be ordered",
  )
const base = {
  snapshotID: z.string(),
  freshness: z.literal("as-of-refresh"),
  refreshedAt: z.int().positive(),
  encoding: z.literal("o200k_base"),
  truncated: z.boolean(),
}
const IndexOutput = z.strictObject({
  ...base,
  workspace: z.string(),
  repomix: z.literal("1.18.1"),
  totalFiles: z.int().nonnegative(),
  packedTokens: z.int().nonnegative(),
  files: z.array(z.strictObject({ path: z.string(), bytes: z.int().nonnegative() })).max(100),
})
const RefreshOutput = z.strictObject({
  ...base,
  workspace: z.string(),
  repomix: z.literal("1.18.1"),
  totalFiles: z.int().nonnegative(),
  packedTokens: z.int().nonnegative(),
})
const EvidenceOutput = z.strictObject({
  ...base,
  sources: z
    .array(
      z.strictObject({
        path: z.string(),
        revision: z.string().nullable(),
        startLine: z.int().positive(),
        endLine: z.int().nonnegative(),
        level: z.enum(["full", "outline", "structure"]),
        text: z.string(),
      }),
    )
    .max(50),
})

export function registerContextTools(ctx: Plugin.Context, index: ProjectIndex) {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "lazers_project_index",
      description:
        "Read the latest Architect-built workspace snapshot. Returns up to 100 permitted file paths and structural metrics; path selections reuse the same snapshot. Freshness is stated as-of its explicit refresh.",
      input: IndexInput,
      output: IndexOutput,
      options: { codemode: true, pinned: true, permission: "lazers_project_index" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lazers_project_index",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  const output = await index.manifest(
                    { sessionID: call.sessionID, agent: call.agent },
                    input.paths,
                  )
                  return { content: JSON.stringify(output), output }
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lazers_project_refresh",
      description:
        "Architect only: explicitly collect and atomically publish a fresh bounded Repomix workspace snapshot. Read/index tools never build or refresh implicitly.",
      input: RefreshInput,
      output: RefreshOutput,
      options: { codemode: true, pinned: true, permission: "lazers_project_refresh" },
      execute: (_input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lazers_project_refresh",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() => {
              if (call.agent !== "architect")
                return Effect.fail(
                  new Tool.Error({ message: "Only Architect may refresh the workspace index" }),
                )
              return Effect.tryPromise({
                try: async () => {
                  const snapshot = await index.refresh({
                    sessionID: call.sessionID,
                    agent: call.agent,
                  })
                  const output = {
                    snapshotID: snapshot.id,
                    freshness: "as-of-refresh" as const,
                    refreshedAt: snapshot.createdAt,
                    workspace: snapshot.workspace,
                    repomix: snapshot.repomix,
                    encoding: snapshot.encoding,
                    totalFiles: snapshot.files.length,
                    packedTokens: snapshot.tokens,
                    truncated: false,
                  }
                  return { content: JSON.stringify(output), output }
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              })
            }),
          ),
    })
    editor.add({
      name: "lazers_project_read",
      description:
        "Read selected source, Repomix outline, or file structure from the latest Architect-built snapshot, with source paths and line ranges. Filter paths/search and lines; these selections do not recollect or repack the workspace. Freshness is stated as-of its explicit refresh.",
      input: EvidenceInput,
      output: EvidenceOutput,
      options: { codemode: true, pinned: true, permission: "lazers_project_read" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lazers_project_read",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  const output = await index.evidence(
                    { sessionID: call.sessionID, agent: call.agent },
                    input,
                  )
                  return { content: JSON.stringify(output), output }
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
  })
}
