import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { join } from "node:path"
import { z } from "zod"
import type { ProjectIndex } from "./index.ts"

export function nativeContextPermission(
  ctx: Plugin.Context,
): ConstructorParameters<typeof ProjectIndex>[3] {
  return async (path, principal, workspace) => {
    try {
      principal.signal?.throwIfAborted()
      await Effect.runPromise(
        ctx.permission.assert({
          sessionID: Session.ID.make(principal.sessionID),
          agent: Agent.ID.make(principal.agent),
          action: "read",
          resources: [join(workspace, path)],
        }),
        { signal: principal.signal },
      )
      return true
    } catch {
      principal.signal?.throwIfAborted()
      return false
    }
  }
}

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
  totalFiles: z
    .int()
    .nonnegative()
    .describe(
      "With paths specified, the number of authorized matching files before the 100-file response limit; without paths, the number of all authorized files.",
    ),
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
  workspace: z.string(),
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
      name: "lz-project-index",
      description:
        "Read the Architect-selected workspace snapshot for this owned implementor, or this workspace's snapshot when no owned publication is available. Returns up to 100 currently permitted matching file paths and structural metrics. With paths specified, totalFiles counts authorized matches before the 100-file response limit; without paths, it counts all currently permitted files. The response identifies the source workspace and is as-of-refresh, not a live view of the worker tree.",
      input: IndexInput,
      output: IndexOutput,
      options: { codemode: true, pinned: true, permission: "lz-project-index" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-project-index",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async (signal) => {
                  const output = await index.manifest(
                    { sessionID: call.sessionID, agent: call.agent, signal },
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
      name: "lz-project-refresh",
      description:
        "Architect only: explicitly collect and atomically publish a fresh bounded Repomix workspace snapshot. Read/index tools never build or refresh implicitly.",
      input: RefreshInput,
      output: RefreshOutput,
      options: { codemode: true, pinned: true, permission: "lz-project-refresh" },
      execute: (_input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-project-refresh",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() => {
              if (call.agent !== "architect")
                return Effect.fail(
                  new Tool.Error({ message: "Only Architect may refresh the workspace index" }),
                )
              return Effect.tryPromise({
                try: async (signal) => {
                  const snapshot = await index.refresh({
                    sessionID: call.sessionID,
                    agent: call.agent,
                    signal,
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
      name: "lz-project-read",
      description:
        "Read selected source, Repomix outline, or file structure from the Architect-selected publication for this owned implementor, or this workspace's snapshot when none is available. The response identifies the source workspace and is as-of-refresh, not a live view of the worker tree. Filter paths/search and lines; selections never recollect or repack the workspace.",
      input: EvidenceInput,
      output: EvidenceOutput,
      options: { codemode: true, pinned: true, permission: "lz-project-read" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-project-read",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async (signal) => {
                  const output = await index.evidence(
                    { sessionID: call.sessionID, agent: call.agent, signal },
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
