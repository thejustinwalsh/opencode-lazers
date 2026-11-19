import {
  AuditScanOutput,
  AuditQueryOutput,
  AuditDetailOutput,
  AuditDecisionInput,
  AuditDecisionRecord,
  FallowCheckOutput,
  FallowConfigOutput,
  FallowConfigSetOutput,
  FallowDeadCodeOutput,
  FallowDupesOutput,
  FallowHealthOutput,
} from "./contract.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { z } from "zod"
import { resolve } from "node:path"
import type { TaskRepository } from "../storage.ts"
import { AuditHistory } from "./history.ts"
import { fallowReport, importAudit } from "./report.ts"
import { nativeFallowAnalyzer } from "./analyzer.ts"
import {
  cleanupResolvedFallowConfig,
  getLatestFallowConfig,
  resolveCurrentFallowConfig,
  setFallowConfig,
  thresholdsFrom,
} from "./config.ts"
import {
  deadCodeFindings,
  detectEntryPoints,
  draftFallowConfig,
  dupesGroups,
  healthFunctions,
  page,
  type DeadCodeFindingKind,
  type HealthSort,
} from "./fallow-tools-support.ts"
import { fallowReview } from "./review.ts"
import { resolvePreviewBaseCommit } from "./review-git.ts"

const text = z.string().min(1)
const paging = { offset: z.int().nonnegative().default(0), limit: z.int().positive().default(50) }
const boundedPaging = {
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().max(25).default(10),
}
const runOptions = {
  requestID: text.optional(),
  taskID: text.optional(),
  phase: z.enum(["baseline", "follow-up", "inspection"]).optional(),
  baselineRunID: z.uuid().optional(),
}
const pathsInput = { paths: z.array(text).optional() }

async function withEffectiveConfig<T>(
  ctx: Pick<Plugin.Context, "location">,
  repository: TaskRepository,
  run: (resolved: Awaited<ReturnType<typeof resolveCurrentFallowConfig>>) => Promise<T>,
): Promise<T> {
  const resolved = await resolveCurrentFallowConfig({
    directory: ctx.location.directory,
    repository,
  })
  try {
    return await run(resolved)
  } finally {
    await cleanupResolvedFallowConfig(resolved)
  }
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
        "Run bundled Fallow and save durable task-associated audit history in LAZERS SQLite. Worker task/plan/attempt/session come from the runtime assignment. The first scan defaults to baseline; later scans link to it as follow-ups. Saves each analysis as it finishes, including errors. Returns runID, reportPath outside the worktree, timestamps and summaries. Use lz-get-audit to retrieve findings. Fallow findings are feedback, never a rejection; older findings are never counted. Optional local-model semantic analysis is not started.",
      input: z.strictObject(runOptions),
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
    editor.add({
      name: "lz-fallow-check",
      description:
        "Read-only preview of the Fallow review the runtime will run when this attempt finishes: changed files against the merge-base with the default branch (or HEAD~1). Findings are feedback, never a rejection. Older findings are not counted.",
      input: z.strictObject(pathsInput),
      output: FallowCheckOutput,
      options: { codemode: true, permission: "lz-fallow-check" },
      execute: (_input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-fallow-check",
            resources: [ctx.location.directory],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  const workspace = ctx.location.directory
                  const baseCommit = await resolvePreviewBaseCommit(workspace)
                  const result = await fallowReview({
                    workspace,
                    baseCommit,
                    artifact: "HEAD",
                    repository,
                  })
                  const output = {
                    status: result.status,
                    introduced: result.introduced,
                    concerns: result.concerns,
                    thresholds: result.thresholds,
                  }
                  return { content: JSON.stringify(output), output }
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lz-fallow-dupes",
      description:
        "Duplicate code groups from Fallow's duplication analysis, ranked worst first by token count and paged. No source fragments; each instance carries only file and line range.",
      input: z.strictObject({
        ...pathsInput,
        ...boundedPaging,
        mode: z.enum(["strict", "mild", "weak", "semantic"]).optional(),
        minTokens: z.int().positive().optional(),
        minLines: z.int().positive().optional(),
      }),
      output: FallowDupesOutput,
      options: { codemode: true, permission: "lz-fallow-dupes" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-fallow-dupes",
            resources: [ctx.location.directory],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () =>
                  withEffectiveConfig(ctx, repository, async (resolved) => {
                    const report = await nativeFallowAnalyzer.duplication({
                      root: ctx.location.directory,
                      configPath: resolved.configPath,
                      files: input.paths,
                    })
                    const groups = dupesGroups(report)
                    const paged = page(groups, input)
                    const output = {
                      groups: paged.items,
                      total: paged.total,
                      duplicationPct: report.stats.duplication_percentage,
                      nextOffset: paged.nextOffset,
                    }
                    return { content: JSON.stringify(output), output }
                  }),
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lz-fallow-health",
      description:
        "Functions over Fallow's complexity limits, ranked worst first by the requested metric and paged. No source fragments.",
      input: z.strictObject({
        ...pathsInput,
        ...boundedPaging,
        sort: z.enum(["cognitive", "cyclomatic", "lines"]).default("cognitive"),
      }),
      output: FallowHealthOutput,
      options: { codemode: true, permission: "lz-fallow-health" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-fallow-health",
            resources: [ctx.location.directory],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () =>
                  withEffectiveConfig(ctx, repository, async (resolved) => {
                    const report = await nativeFallowAnalyzer.complexity({
                      root: ctx.location.directory,
                      configPath: resolved.configPath,
                      files: input.paths,
                    })
                    const sort: HealthSort = input.sort
                    const paged = page(healthFunctions(report, sort), input)
                    const output = {
                      functions: paged.items,
                      total: paged.total,
                      thresholds: thresholdsFrom(resolved.config),
                      nextOffset: paged.nextOffset,
                    }
                    return { content: JSON.stringify(output), output }
                  }),
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lz-fallow-dead-code",
      description:
        "Dead-code candidates in this project: unused files, exports, types and dependencies, paged. Unused class members are left out unless the project's Fallow config turns that rule on. Disabled with no usable config; use lz-fallow-config to see what is missing.",
      input: z.strictObject({
        ...pathsInput,
        ...boundedPaging,
        kinds: z.array(z.enum(["file", "export", "type", "dependency", "member"])).optional(),
      }),
      output: FallowDeadCodeOutput,
      options: { codemode: true, permission: "lz-fallow-dead-code" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-fallow-dead-code",
            resources: [ctx.location.directory],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () =>
                  withEffectiveConfig(ctx, repository, async (resolved) => {
                    if (!resolved.deadCodeEnabled)
                      throw new Tool.Error({
                        message:
                          "dead-code-disabled: no usable Fallow config has entry points. Set one with lz-fallow-config.",
                      })
                    const report = await nativeFallowAnalyzer.deadCode({
                      root: ctx.location.directory,
                      configPath: resolved.configPath,
                      files: input.paths,
                    })
                    const kinds = input.kinds as DeadCodeFindingKind[] | undefined
                    const paged = page(deadCodeFindings(report, resolved.config, kinds), input)
                    const output = {
                      findings: paged.items,
                      total: paged.total,
                      nextOffset: paged.nextOffset,
                    }
                    return { content: JSON.stringify(output), output }
                  }),
                catch: (error) =>
                  error instanceof Tool.Error ? error : new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lz-fallow-config",
      description:
        "The effective Fallow config: a repository config file at the base commit, else the stored LAZERS project config, else defaults. draft=true proposes entry points and rules without storing anything. Stores nothing; use lz-fallow-config-set to change the LAZERS config.",
      input: z.strictObject({ draft: z.boolean().default(false) }),
      output: FallowConfigOutput,
      options: { codemode: true, permission: "lz-fallow-config" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-fallow-config",
            resources: [ctx.location.directory],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () =>
                  withEffectiveConfig(ctx, repository, async (resolved) => {
                    const stored = getLatestFallowConfig(repository)
                    const shadowedLazersConfig = resolved.source === "repo" && stored !== undefined
                    const missing =
                      resolved.source === "defaults"
                        ? ["No Fallow config: dead-code checks are off."]
                        : []
                    const draft = input.draft
                      ? draftFallowConfig(await detectEntryPoints(ctx.location.directory))
                      : undefined
                    const output = {
                      source: resolved.source,
                      sha256: resolved.sha256,
                      config: resolved.config,
                      deadCodeEnabled: resolved.deadCodeEnabled,
                      shadowedLazersConfig,
                      missing,
                      draft,
                    }
                    return { content: JSON.stringify(output), output }
                  }),
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lz-fallow-config-set",
      description:
        "Validates and stores a new append-only revision of the LAZERS project config (never a repository write). A repo config file still wins when the repository has one.",
      input: z.strictObject({ set: z.record(z.string(), z.unknown()) }),
      output: FallowConfigSetOutput,
      options: { codemode: true, permission: "lz-fallow-config-set" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-fallow-config-set",
            resources: [ctx.location.directory],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  const revision = setFallowConfig(repository, input.set, {
                    sessionID: call.sessionID,
                    agent: call.agent,
                  })
                  const output = {
                    sha256: revision.sha256,
                    config: revision.config,
                    createdAt: revision.createdAt,
                  }
                  return { content: JSON.stringify(output), output }
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
  })
}
