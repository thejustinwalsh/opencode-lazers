import {
  AuditScanOutput,
  AuditQueryOutput,
  AuditDetailOutput,
  AuditDecisionInput,
  AuditDecisionRecord,
} from "./contract.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { z } from "zod"
import { resolve } from "node:path"
import type { TaskRepository } from "../storage.ts"
import { AuditHistory } from "./history.ts"
import { fallowReport, importAudit } from "./report.ts"

const text = z.string().min(1)
const paging = { offset: z.int().nonnegative().default(0), limit: z.int().positive().default(50) }
const runOptions = {
  requestID: text.optional(),
  taskID: text.optional(),
  phase: z.enum(["baseline", "follow-up", "inspection"]).optional(),
  baselineRunID: z.uuid().optional(),
}
export function registerAuditTools(
  ctx: Pick<Plugin.Context, "tool" | "permission" | "location">,
  repository: TaskRepository,
) {
  const history = new AuditHistory(repository)
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "lz-fallow-report",
      description:
        "Run bundled Fallow and save durable task-associated audit history in LAZERS SQLite. Worker task/plan/attempt/session come from the runtime assignment. The first scan defaults to baseline; later scans link to it as follow-ups. Saves each analysis as it finishes, including errors. Returns runID, reportPath outside the worktree, timestamps and summaries. Use lz-get-audit to retrieve findings. Scores never gate acceptance. Optional local-model semantic analysis is not started.",
      input: z.strictObject({ ...runOptions, threads: z.int().positive().default(1) }),
      output: AuditScanOutput,
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
                  const output = await fallowReport(
                    history,
                    {
                      ...input,
                      requestID: input.requestID ?? call.id,
                      workspace: ctx.location.directory,
                    },
                    { sessionID: call.sessionID, agent: call.agent },
                    signal,
                  )
                  return { content: JSON.stringify(output), output }
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lz-query-audits",
      description:
        "List durable audit history for this project, optionally filtered by task ID/reference, attempt or plan. Includes run IDs, baseline links, timestamps, lifecycle and analysis summaries; never starts a scan.",
      input: z.strictObject({
        ...paging,
        taskID: text.optional(),
        attemptID: z.uuid().optional(),
        planID: z.uuid().optional(),
      }),
      output: AuditQueryOutput,
      options: { codemode: true, permission: "lz-query-audits" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-query-audits",
            resources: ["*"],
          })
          .pipe(
            Effect.map(() => {
              const output = history.list(input)
              return { content: JSON.stringify(output), output }
            }),
          ),
    })
    editor.add({
      name: "lz-get-audit",
      description:
        "Read a durable audit run and paged structured findings, optionally filtered by analysis or source path. Finding IDs remain stable within the run. Each finding includes its append-only decisions. includeReports=true returns full original Fallow JSON. export=true regenerates the JSON file from SQLite after file/worktree cleanup. A run marked collecting has only its saved results; do not assume its scanner is still alive.",
      input: z.strictObject({
        ...paging,
        runID: z.uuid(),
        analysis: text.optional(),
        path: text.optional(),
        includeReports: z.boolean().default(false),
        export: z.boolean().default(false),
      }),
      output: AuditDetailOutput,
      options: { codemode: true, permission: "lz-get-audit" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-get-audit",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  if (input.export) await history.export(input.runID)
                  const output = history.detail(input.runID, input)
                  return { content: JSON.stringify(output), output }
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lz-record-audit-finding",
      description:
        "Append a finding disposition and rationale without changing the original finding or previous decisions. May link a follow-up run. This records an Auditor/Architect assessment; it neither completes a task nor proves a fix.",
      input: AuditDecisionInput,
      output: AuditDecisionRecord,
      options: { codemode: true, permission: "lz-record-audit-finding" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-record-audit-finding",
            resources: ["*"],
          })
          .pipe(
            Effect.map(() => {
              const output = history.decide(input, { sessionID: call.sessionID, agent: call.agent })
              return { content: JSON.stringify(output), output }
            }),
          ),
    })
    editor.add({
      name: "lz-import-audit",
      description:
        "Preserve an existing saved Fallow JSON report in durable history. Supply its path, optional task ID/reference and phase; runtime workers are associated automatically. File metadata remains imported provenance rather than inferred ownership. Does not rerun Fallow or alter the original file.",
      input: z.strictObject({ ...runOptions, path: text }),
      output: AuditScanOutput,
      options: { codemode: true, permission: "lz-import-audit" },
      execute: (input, call) => {
        const path = resolve(ctx.location.directory, input.path)
        return ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "read",
            resources: [path],
          })
          .pipe(
            Effect.flatMap(() =>
              ctx.permission.assert({
                sessionID: call.sessionID,
                agent: call.agent,
                action: "lz-import-audit",
                resources: [ctx.location.directory],
              }),
            ),
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  const output = await importAudit(
                    history,
                    {
                      ...input,
                      path,
                      requestID: input.requestID ?? call.id,
                      workspace: ctx.location.directory,
                    },
                    { sessionID: call.sessionID, agent: call.agent },
                  )
                  return { content: JSON.stringify(output), output }
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          )
      },
    })
  })
}
