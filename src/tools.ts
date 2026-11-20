import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { z } from "zod"
import { activeProfile } from "./projects/profile-store.ts"
import { Tool } from "@opencode/schema/tool"
import { TaskRepository } from "./storage.ts"
import {
  startingRevision as observeStartingRevision,
  submitTask,
  taskSubmissionSummary,
} from "./submission.ts"
import { TaskSubmissionSchema } from "./task.ts"
import {
  AgentGetInput,
  GetInstructionsOutput,
  GetOutput,
  AgentQueryInput,
  AgentQueryOutput,
} from "./tasks/contract.ts"
import { enrollScheduleConnection } from "./tasks/schedule/hook.ts"
import { queryTaskPage } from "./tasks/stream-query.ts"
import { TaskReads } from "./tasks/read.ts"
import { taskInstructions } from "./tasks/instructions.ts"
import type { ProjectIndex } from "./context/index.ts"
import {
  freezePlanMap,
  planOfSession,
  recordMapDelivery,
  repoMapBlock,
} from "./context/repo-map-store.ts"
import type { RepoMap } from "./context/repo-map.ts"
import { isWorkerAgent } from "./runner/worker-agent.ts"
import { TaskDispositionInput } from "./task-disposition.ts"
import { TaskClassificationToolInput } from "./task-classification.ts"
import { tolerantJsonSchema } from "./legacy-fields.ts"
import { declareInput } from "./tool-input.ts"
import { guardedWrite, observeRevision } from "./tasks/observed-revisions.ts"
import {
  TaskCorrectionToolInput,
  TaskCorrectionInspectionInput,
  TaskCorrectionInspection,
} from "./task-correction.ts"
import { openReadOnlyTaskCorrections } from "./tasks/corrections.ts"
import { verificationTimeoutDefaults } from "./runner/verification-timeout.ts"
import type { VerificationTimeoutDefaults } from "./runner/verification-timeout.ts"

const listInput = z.strictObject({ limit: z.int().min(1).max(100) })

function result<T>(
  run: () => T | Promise<T>,
  structured = false,
  render: (output: T) => string = JSON.stringify,
) {
  return Effect.promise(async () => {
    try {
      const output = await run()
      return structured ? { content: render(output), output } : { content: JSON.stringify(output) }
    } catch (error) {
      return {
        content: JSON.stringify({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      }
    }
  })
}

/** What `lz-submit-task` and `lz-plan-task` share: the same checks, the same write, the same receipt. */
export type TaskSubmitDeps = {
  location: Pick<Plugin.Context["location"], "directory" | "project">
  withRepository: <T>(run: (connection: TaskRepository) => T) => Promise<T>
  timeoutDefaults: VerificationTimeoutDefaults
  /** Refuses submission while the Fallow review is on and the project has no Fallow config. */
  fallowGate?: () => Promise<unknown>
}

export async function submitTaskReceipt(
  deps: TaskSubmitDeps,
  input: unknown,
  sessionID: string,
): Promise<unknown> {
  const { location, withRepository, timeoutDefaults, fallowGate } = deps
  const context = { sessionID }
  const ctx = { location }
  const parsed = TaskSubmissionSchema.parse(input)
  const refused = await fallowGate?.()
  if (refused) return refused
  // Observed before the transaction: Git must not run inside it.
  // A failure is deferred to the provenance callback: replayed receipts never need it.
  const startingRevision = await observeStartingRevision(ctx.location.directory).then(
    (revision) => ({ revision }),
    (error: unknown) => ({ error }),
  )
  const receipt = await withRepository((connection) => {
    const submitted = submitTask(
      connection,
      parsed,
      () => ({
        projectID: ctx.location.project.id,
        projectDirectory: ctx.location.project.canonical,
        workspaceDirectory: ctx.location.directory,
        sessionID: context.sessionID,
        startingRevision: (() => {
          if ("error" in startingRevision) throw startingRevision.error
          return startingRevision.revision
        })(),
      }),
      timeoutDefaults,
    )
    if (submitted.status !== "submitted") return submitted
    const detail = new TaskReads(connection).get({ taskID: submitted.taskID })
    if (detail.status !== "found") return submitted
    // The submitting session wrote this task, so it has seen its records.
    observeRevision(
      connection,
      context.sessionID,
      submitted.taskID,
      "classification",
      detail.classification.revision,
    )
    return taskSubmissionSummary(
      submitted,
      detail.task,
      detail.execution?.state ?? detail.task.status,
    )
  })
  return receipt
}

/**
 * One connection per execution, with the work retried while another process holds the write lock
 * (`retryBusy`): every handler that uses it is request-keyed or reads/upserts, so repeating it is
 * safe, and the wait yields the event loop instead of failing after the synchronous budget. The
 * host may retain an admitted tool callback while a plugin reload closes its setup-scoped
 * connection, so each execution owns its connection; a write is never retried just because an old
 * connection was disposed.
 */
export function repositoryRunner(repository: Pick<TaskRepository, "path" | "projectDirectory">) {
  const { path, projectDirectory } = repository
  return async function withRepository<T>(run: (connection: TaskRepository) => T): Promise<T> {
    const connection = new TaskRepository(path, projectDirectory)
    try {
      // This connection writes too: its transactions drain the schedule queue like the core's.
      try {
        connection.read((db) => enrollScheduleConnection(db))
      } catch {
        // The projection schema is not installed in this database yet.
      }
      return await connection.retryBusy(() => run(connection))
    } finally {
      connection.close()
    }
  }
}

/** The submit path as one function: used by `lz-submit-task` and by tasking a stored plan. */
export function taskSubmitter(
  ctx: Pick<TaskToolContext, "location">,
  repository: Pick<TaskRepository, "path" | "projectDirectory">,
  timeoutDefaults: VerificationTimeoutDefaults,
  fallowGate?: () => Promise<unknown>,
) {
  const withRepository = repositoryRunner(repository)
  return (input: unknown, sessionID: string) =>
    submitTaskReceipt(
      { location: ctx.location, withRepository, timeoutDefaults, fallowGate },
      input,
      sessionID,
    )
}

type TaskToolContext = {
  location: Plugin.Context["location"]
  permission: Pick<Plugin.Context["permission"], "assert">
  tool: Pick<Plugin.Context["tool"], "transform">
}

export function registerTaskTools(
  ctx: TaskToolContext,
  repository: TaskRepository,
  index?: Pick<ProjectIndex, "taskContext">,
  timeoutDefaults: VerificationTimeoutDefaults = verificationTimeoutDefaults(),
  /** Refuses submission while the Fallow review is on and the project has no Fallow config. */
  fallowGate?: () => Promise<unknown>,
) {
  const { path, projectDirectory } = repository
  const withRepository = repositoryRunner(repository)
  const submit = (input: unknown, sessionID: string) =>
    submitTaskReceipt(
      { location: ctx.location, withRepository, timeoutDefaults, fallowGate },
      input,
      sessionID,
    )
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "lz-submit-task",
      description:
        "Validate and persist a task; does not execute. Required idempotencyKey: 1–200 characters, non-whitespace, compared exactly within the canonical repo across sessions/restarts. Retry the same key/content to recover the original ID. Changed content conflicts; new logical work needs a new key. Object key order is ignored; array order and values matter. Invalid input saves nothing and returns the wrong fields with the full usage.",
      input: declareInput(TaskSubmissionSchema),
      options: { codemode: true, permission: "lz-submit-task" },
      execute: (input, context) =>
        ctx.permission
          .assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "lz-submit-task",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  const receipt = await submit(input, context.sessionID)
                  return { content: JSON.stringify(receipt) }
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lz-dispose-task",
      description:
        "Architect-only durable disposition for an old task: record reviewed fulfillment, supersession, rejection or duplication with a reason, evidence and project-local related task IDs. The immutable task remains readable. This does not accept worker execution, override active work, or force a plan state.",
      input: declareInput(TaskDispositionInput),
      options: { codemode: true, permission: "lz-dispose-task" },
      execute: (input, context) =>
        ctx.permission
          .assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "lz-dispose-task",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  if (context.agent !== "architect")
                    throw new Tool.Error({ message: "Task disposition is restricted to Architect" })
                  const parsed = TaskDispositionInput.parse(input)
                  const receipt = await withRepository((connection) =>
                    connection.recordDisposition(parsed, {
                      sessionID: context.sessionID,
                      agent: String(context.agent),
                    }),
                  )
                  return { content: JSON.stringify(receipt) }
                },
                catch: (error) =>
                  error instanceof Tool.Error
                    ? error
                    : new Tool.Error({
                        message: error instanceof Error ? error.message : String(error),
                      }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lz-classify-task",
      description:
        "Architect-only append-only task-kind/v1 classification or correction. Supply one primaryKind, a requestID and a reason. It appends to the task's classification history. Read the task with lz-get-task first: a write on a view older than the current revision conflicts, writes nothing, and is retried with a new requestID after re-reading.",
      input: tolerantJsonSchema(TaskClassificationToolInput),
      options: { codemode: true, permission: "lz-classify-task" },
      execute: (input, context) =>
        ctx.permission
          .assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "lz-classify-task",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  // Check caller authority before opening a project database or
                  // parsing data that could disclose project-local task state.
                  if (context.agent !== "architect")
                    throw new Tool.Error({
                      message: "Task classification is restricted to Architect",
                    })
                  const parsed = TaskClassificationToolInput.parse(input)
                  const receipt = await withRepository((connection) =>
                    guardedWrite(
                      connection,
                      {
                        sessionID: context.sessionID,
                        taskID: parsed.taskID,
                        kind: "classification",
                        recordKey: "annotation",
                      },
                      (expectedRevision) =>
                        connection.recordTaskClassification(
                          { ...parsed, expectedRevision },
                          { sessionID: context.sessionID, agent: String(context.agent) },
                        ),
                    ),
                  )
                  return { content: JSON.stringify(receipt) }
                },
                catch: (error) =>
                  error instanceof Tool.Error
                    ? error
                    : new Tool.Error({
                        message: error instanceof Error ? error.message : String(error),
                      }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lz-correct-task",
      description:
        "Architect-only explicit same-original-goal correction link. taskID is the correction task; originalTaskID is the task it corrects. Set originalTaskID to null to explicitly separate/retract the link. Supply a requestID; it appends to the task's correction history. Inspect with lz-inspect-task-corrections first: a write on a view older than the current revision conflicts, writes nothing, and is retried with a new requestID after re-inspecting. No relation is inferred from supplements, kind, ancestry, scope, or prose.",
      input: tolerantJsonSchema(TaskCorrectionToolInput),
      options: { codemode: true, permission: "lz-correct-task" },
      execute: (input, context) =>
        ctx.permission
          .assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "lz-correct-task",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  if (context.agent !== "architect")
                    throw new Tool.Error({ message: "Task correction is restricted to Architect" })
                  const parsed = TaskCorrectionToolInput.parse(input)
                  const receipt = await withRepository((connection) =>
                    guardedWrite(
                      connection,
                      {
                        sessionID: context.sessionID,
                        taskID: parsed.taskID,
                        kind: "correction",
                        recordKey: "correction",
                      },
                      (expectedRevision) =>
                        connection.recordTaskCorrection(
                          { ...parsed, expectedRevision },
                          { sessionID: context.sessionID, agent: String(context.agent) },
                        ),
                    ),
                  )
                  return { content: JSON.stringify(receipt) }
                },
                catch: (error) =>
                  error instanceof Tool.Error
                    ? error
                    : new Tool.Error({
                        message: error instanceof Error ? error.message : String(error),
                      }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lz-inspect-task-corrections",
      description:
        "Architect-only project-scoped inspection of effective same-goal correction membership and its complete append-only audit. Unlinked tasks remain separate and unreviewed; a retracted link is explicitly independent. The returned identity pins one coherent read snapshot.",
      input: declareInput(TaskCorrectionInspectionInput),
      output: TaskCorrectionInspection,
      options: { codemode: true, permission: "lz-inspect-task-corrections" },
      execute: (input, context) =>
        ctx.permission
          .assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "lz-inspect-task-corrections",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  if (context.agent !== "architect")
                    throw new Tool.Error({
                      message: "Task correction inspection is restricted to Architect",
                    })
                  const parsed = TaskCorrectionInspectionInput.parse(input)
                  const reader = openReadOnlyTaskCorrections(path, projectDirectory)
                  try {
                    const output = reader.inspect(parsed.taskID)
                    if (output.status === "found")
                      await withRepository((connection) =>
                        observeRevision(
                          connection,
                          context.sessionID,
                          parsed.taskID,
                          "correction",
                          output.task.revision,
                        ),
                      )
                    return { content: JSON.stringify(output), output }
                  } finally {
                    reader.close()
                  }
                },
                catch: (error) =>
                  error instanceof Tool.Error
                    ? error
                    : new Tool.Error({
                        message: error instanceof Error ? error.message : String(error),
                      }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lz-get-task",
      description:
        "Get a task by ID or project reference. Workers receive the complete readable task, advice, optional skill summaries, the plan's repository map and the source the task names in one call; other agents receive structured task/execution data. Optional format overrides that default. Read source directly as needed.",
      input: AgentGetInput.extend({
        format: z.enum(["instructions", "structured"]).optional(),
      }),
      output: z.union([GetOutput, GetInstructionsOutput]),
      options: { codemode: true, pinned: true, permission: "lz-get-task" },
      execute: (input, context) =>
        ctx.permission
          .assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "lz-get-task",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async (signal) => {
                  const { format, ...query } = input
                  const detail = await withRepository((connection) =>
                    new TaskReads(connection).get(query),
                  )
                  if (detail.status === "found" && detail.classification)
                    await withRepository((connection) => {
                      observeRevision(
                        connection,
                        context.sessionID,
                        detail.task.id,
                        "classification",
                        detail.classification.revision,
                      )
                      observeRevision(
                        connection,
                        context.sessionID,
                        detail.task.id,
                        "advice",
                        detail.advice?.current.revision ?? 0,
                      )
                    })
                  if (
                    (format ?? (isWorkerAgent(context.agent) ? "instructions" : "structured")) ===
                    "structured"
                  )
                    return { content: JSON.stringify(detail), output: detail }
                  let instructions = taskInstructions(
                    detail,
                    activeProfile(repository, repository.projectDirectory),
                  )
                  if (detail.status === "found") {
                    // One orientation map per plan, captured when the plan was submitted, so every
                    // worker of the plan carries identical bytes ahead of the task's own source.
                    const planID = planOfSession(repository, context.sessionID)
                    let map: RepoMap | undefined
                    if (planID) {
                      try {
                        map = await freezePlanMap(
                          repository,
                          planID,
                          ctx.location.directory,
                          repository.projectDirectory,
                        )
                        instructions += `\n\n${repoMapBlock(map, "plan start")}`
                      } catch {
                        signal.throwIfAborted()
                      }
                    }
                    let sourceTokens: number | undefined
                    if (index) {
                      try {
                        const advice = detail.advice?.current
                        const source = await index.taskContext(
                          { sessionID: context.sessionID, agent: context.agent, signal },
                          detail.task.proposal,
                          [
                            ...(advice?.findings ?? []),
                            ...(advice?.implementationAdvice ?? []),
                            ...(advice?.references.map((ref) => ref.reference) ?? []),
                          ],
                        )
                        sourceTokens = source.tokens
                        instructions += `\n\n## Source context\nWorkspace ${source.workspace}. Read now from the checkout; outlines list declarations, so read the file for bodies.\n`
                        for (const entry of source.entries) {
                          let fence = "```"
                          for (const match of entry.text.matchAll(/`+/g))
                            if (match[0].length >= fence.length)
                              fence = "`".repeat(match[0].length + 1)
                          instructions += `\n### ${entry.path} (${entry.level})\n\n${fence}\n${entry.text}\n${fence}\n`
                        }
                        if (source.deferred.length)
                          instructions += `\nAdditional source paths: ${source.deferred.join(", ")}. Read directly as needed.\n`
                      } catch {
                        signal.throwIfAborted()
                        instructions +=
                          "\n\nSource context is unavailable. Read the referenced source directly."
                      }
                    }
                    await withRepository((connection) =>
                      recordMapDelivery(connection, {
                        sessionID: context.sessionID,
                        taskID: detail.task.id,
                        role: "worker",
                        ...(planID ? { planID } : {}),
                        ...(map ? { map } : {}),
                        ...(sourceTokens !== undefined
                          ? { sourceContextTokens: sourceTokens }
                          : {}),
                      }),
                    )
                  }
                  return { content: instructions, output: instructions }
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lz-list-tasks",
      description:
        "List recent open submitted tasks in this repository, including each stable project-local reference (`<CODE>-<n>`) and UUID. Retired records stay available through lz-get-task or lz-query-tasks with includeRetired; use the latter for the full specification list.",
      input: listInput,
      options: { codemode: true, permission: "lz-list-tasks" },
      execute: (input, context) =>
        ctx.permission
          .assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "lz-list-tasks",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              result(() =>
                queryTaskPage(repository, { limit: listInput.parse(input).limit }).then((page) => ({
                  tasks: page.tasks,
                })),
              ),
            ),
          ),
    })
    editor.add({
      name: "lz-query-tasks",
      description:
        "Search this project's persisted open tasks across sessions, including older records. Literal text, task reference, UUID and scopePath substring candidates; no semantic uniqueness or glob-conflict guarantee. Set includeRetired to review disposition history. Page with the returned cursor using unchanged filters.",
      input: AgentQueryInput,
      output: AgentQueryOutput,
      options: { codemode: true, pinned: true, permission: "lz-query-tasks" },
      execute: (input, context) =>
        ctx.permission
          .assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "lz-query-tasks",
            resources: ["*"],
          })
          .pipe(Effect.flatMap(() => result(() => queryTaskPage(repository, input), true))),
    })
  })
}
