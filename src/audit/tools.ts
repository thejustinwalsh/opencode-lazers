import {
  AuditScanOutput,
  AuditQueryOutput,
  AuditDetailOutput,
  AuditDecisionInput,
  AuditDecisionRecord,
  FallowCheckOutput,
  FallowConfigOutput,
  FallowConfigSetOutput,
  FallowConfigGuideOutput,
  FallowConfigAuditOffOutput,
  FallowConfigSuggestOutput,
  FallowDryRunOutput,
  FallowDeadCodeOutput,
  FallowDupesOutput,
  FallowHealthOutput,
  FallowHealthRunOutput,
} from "./contract.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { z } from "zod"
import { resolve } from "node:path"
import type { TaskRepository } from "../storage.ts"
import { AuditHistory } from "./history.ts"
import { fallowReport, importAudit } from "./report.ts"
import { fallowHealthRun, healthRunOutput } from "./health.ts"
import { defaultFallowAnalyzer } from "./wasm-analyzer.ts"
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
  filterByResolvedPaths,
  healthFunctions,
  page,
  resolveToolPaths,
  type DeadCodeFindingKind,
  type HealthSort,
} from "./fallow-tools-support.ts"
import { fallowReview, type FallowReviewResult } from "./review.ts"
import { resolvePreviewBaseCommit } from "./review-git.ts"
import { dryRunFallowConfig, suggestFallowConfig } from "./fallow-config-tools.ts"
import { missingConfigText } from "./fallow-gate.ts"
import { Delivery, runbook } from "../guidance/index.ts"
import { activeProfile } from "../projects/profile-store.ts"

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
  /** The base commit the runtime's audit of this session's attempt would use, when it is a worker's. */
  attemptBase?: (sessionID: string) => string | undefined,
) {
  const history = new AuditHistory(repository)
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "lz-fallow-report",
      description:
        "Run the full Fallow report and save it in audit history. Returns the run ID, report path and a summary per section.",
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
            Effect.flatMap(() =>
              Effect.promise(() =>
                repository.retryBusy(() => {
                  const output = history.decide(input, {
                    sessionID: call.sessionID,
                    agent: call.agent,
                  })
                  return { content: JSON.stringify(output), output }
                }),
              ),
            ),
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
      name: "lz-fallow-audit",
      description:
        "Fallow audit of your changed files against the task base. Returns a verdict and findings (errors, warnings, inherited) with file, line and fix.",
      input: z.strictObject(pathsInput),
      output: FallowCheckOutput,
      options: { codemode: true, permission: "lz-fallow-audit" },
      execute: (input, call) =>
        ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-fallow-audit",
            resources: [ctx.location.directory],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  const workspace = ctx.location.directory
                  const resolvedPaths = await resolveToolPaths(workspace, input.paths)
                  // A worker's own call measures from the attempt's chain base, exactly as the
                  // runtime's audit will; anyone else from the merge-base with the default branch.
                  const baseCommit =
                    attemptBase?.(call.sessionID) ?? (await resolvePreviewBaseCommit(workspace))
                  const result: FallowReviewResult = resolvedPaths.empty
                    ? { status: "clean" }
                    : await fallowReview({ workspace, baseCommit, artifact: "HEAD", repository })
                  const output = narrowReview(result, resolvedPaths)
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
        "List duplicate-code groups, largest first. Returns each group's size and instances with file and line range.",
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
                try: async () => {
                  const resolvedPaths = await resolveToolPaths(ctx.location.directory, input.paths)
                  if (resolvedPaths.empty) {
                    const output = { groups: [], total: 0, duplicationPct: 0, nextOffset: null }
                    return { content: JSON.stringify(output), output }
                  }
                  return withEffectiveConfig(ctx, repository, async (resolved) => {
                    const report = await defaultFallowAnalyzer.duplication({
                      root: ctx.location.directory,
                      configPath: resolved.configPath,
                      files: resolvedPaths.files,
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
                  })
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lz-fallow-health",
      description:
        "Fallow health of the whole repository, or its over-limit functions (view functions). Returns score, grade, penalties, worst findings and change since the baseline run.",
      input: z.strictObject({
        view: z
          .enum(["score", "functions"])
          .default("score")
          .describe("score runs the whole repository"),
        ...runOptions,
        read: z.uuid().optional().describe("return a stored run, no scan"),
        ...pathsInput,
        ...boundedPaging,
        sort: z.enum(["cognitive", "cyclomatic", "lines"]).default("cognitive"),
      }),
      output: z.union([FallowHealthRunOutput, FallowHealthOutput]),
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
                try: async (signal) => {
                  if (input.view === "score") {
                    const output = input.read
                      ? healthRunOutput(history, input.read, input.baselineRunID)
                      : await fallowHealthRun(
                          history,
                          {
                            requestID: input.requestID ?? call.id,
                            workspace: ctx.location.directory,
                            ...(input.taskID ? { taskID: input.taskID } : {}),
                            ...(input.phase ? { phase: input.phase } : {}),
                            ...(input.baselineRunID ? { baselineRunID: input.baselineRunID } : {}),
                          },
                          { sessionID: call.sessionID, agent: call.agent },
                          signal,
                        )
                    return { content: JSON.stringify(output), output }
                  }
                  const resolvedPaths = await resolveToolPaths(ctx.location.directory, input.paths)
                  if (resolvedPaths.empty) {
                    const output = {
                      functions: [],
                      total: 0,
                      thresholds: { cyclomatic: 20, cognitive: 15 },
                      nextOffset: null,
                    }
                    return { content: JSON.stringify(output), output }
                  }
                  return withEffectiveConfig(ctx, repository, async (resolved) => {
                    const report = await defaultFallowAnalyzer.complexity({
                      root: ctx.location.directory,
                      configPath: resolved.configPath,
                      files: resolvedPaths.files,
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
                  })
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lz-fallow-dead-code",
      description:
        "List unused files, exports, types and dependencies. Returns kind, file, line and name for each.",
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
                try: async () => {
                  const resolvedPaths = await resolveToolPaths(ctx.location.directory, input.paths)
                  if (resolvedPaths.empty) {
                    const output = { findings: [], total: 0, nextOffset: null }
                    return { content: JSON.stringify(output), output }
                  }
                  return withEffectiveConfig(ctx, repository, async (resolved) => {
                    const report = await defaultFallowAnalyzer.deadCode({
                      root: ctx.location.directory,
                      configPath: resolved.configPath,
                      files: resolvedPaths.files,
                    })
                    const kinds = input.kinds as DeadCodeFindingKind[] | undefined
                    const paged = page(deadCodeFindings(report, resolved.config, kinds), input)
                    const output = {
                      findings: paged.items,
                      total: paged.total,
                      nextOffset: paged.nextOffset,
                    }
                    return { content: JSON.stringify(output), output }
                  })
                },
                catch: (error) =>
                  error instanceof Tool.Error ? error : new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lz-fallow-config",
      description:
        "Show, suggest or dry-run this project's Fallow config. Returns the effective config, a proposed one with evidence, or finding counts per class. The first suggest of a session carries the config runbook; mode guide returns a runbook again (topic config, the default, or suppressions).",
      input: z.strictObject({
        mode: z.enum(["show", "suggest", "dry-run", "guide"]).default("show"),
        config: z.record(z.string(), z.unknown()).optional().describe("candidate for dry-run"),
        topic: z.enum(["config", "suppressions"]).optional().describe("runbook for guide mode"),
      }),
      output: z.union([
        FallowConfigOutput,
        FallowConfigSuggestOutput,
        FallowDryRunOutput,
        FallowConfigGuideOutput,
        FallowConfigAuditOffOutput,
      ]),
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
                try: async () => {
                  const project = repository.projectDirectory
                  const workspace = ctx.location.directory
                  if (input.mode === "guide") {
                    const topic = input.topic ?? "config"
                    const output = {
                      topic,
                      guidance: runbook(
                        topic === "config" ? "fallow-config" : "fallow-suppressions",
                      ),
                    }
                    return { content: JSON.stringify(output), output }
                  }
                  if (
                    (input.mode === "suggest" || input.mode === "dry-run") &&
                    activeProfile(repository, project)?.profile.audit === "off"
                  ) {
                    const output = {
                      refused: "PROFILE_AUDIT_OFF" as const,
                      guidance:
                        "This project's profile turns the audit off; change audit in the profile to use Fallow.",
                    }
                    return { content: JSON.stringify(output), output }
                  }
                  if (input.mode === "suggest") {
                    const delivery = new Delivery(call.sessionID)
                    const output = {
                      ...(await suggestFallowConfig(workspace, project, defaultFallowAnalyzer)),
                      guidance: delivery.once("fallow-config"),
                    }
                    delivery.commit()
                    return { content: JSON.stringify(output), output }
                  }
                  const found = await withEffectiveConfig(ctx, repository, async (r) => r).catch(
                    () => undefined,
                  )
                  if (input.mode === "dry-run") {
                    const candidate = input.config ?? found?.config ?? {}
                    const output = await dryRunFallowConfig(
                      workspace,
                      project,
                      candidate,
                      defaultFallowAnalyzer,
                    )
                    return { content: JSON.stringify(output), output }
                  }
                  const stored = getLatestFallowConfig(repository)
                  const output = found
                    ? {
                        resolved: true,
                        source: found.source,
                        sha256: found.sha256,
                        config: found.config,
                        ...(found.source === "lazers" && stored
                          ? {
                              setBy: {
                                agent: stored.agent,
                                sessionID: stored.sessionID,
                                at: stored.createdAt,
                                ...(stored.reason ? { reason: stored.reason } : {}),
                              },
                            }
                          : {}),
                        shadowedLazersConfig: found.source === "repo" && stored !== undefined,
                      }
                    : {
                        resolved: false,
                        config: null,
                        missing: [missingConfigText(project)],
                      }
                  return { content: JSON.stringify(output), output }
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lz-fallow-config-set",
      description:
        "Save a new Fallow config for this project, with a reason. Returns the stored config and its hash.",
      input: z.strictObject({ set: z.record(z.string(), z.unknown()), reason: text }),
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
                  const revision = await repository.retryBusy(() =>
                    setFallowConfig(
                      repository,
                      input.set,
                      { sessionID: call.sessionID, agent: call.agent },
                      input.reason,
                    ),
                  )
                  const output = {
                    sha256: revision.sha256,
                    config: revision.config,
                    createdAt: revision.createdAt,
                    reason: input.reason,
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

/** Filters a review to the paths the caller asked about, recounting the summary. */
function narrowReview(
  result: FallowReviewResult,
  resolvedPaths: Awaited<ReturnType<typeof resolveToolPaths>>,
): FallowReviewResult {
  const pkg = result.package
  if (!pkg || !resolvedPaths.files) return result
  const findings = filterByResolvedPaths(pkg.findings, resolvedPaths)
  const live = findings.filter((f) => f.attribution !== "inherited")
  const errors = live.filter((f) => f.severity === "error").length
  const warnings = live.length - errors
  return {
    ...result,
    status: errors + warnings === 0 ? "clean" : "findings",
    package: {
      ...pkg,
      findings,
      summary: { errors, warnings, inherited: findings.length - live.length },
    },
  }
}
