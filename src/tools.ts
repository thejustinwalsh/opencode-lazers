import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { z } from "zod"
import { Tool } from "@opencode/schema/tool"
import { TaskRepository } from "./storage.ts"
import { startingRevision, submitTask, taskSubmissionSummary } from "./submission.ts"
import { TaskSubmissionSchema } from "./task.ts"
import {
  GetInput,
  GetInstructionsOutput,
  GetOutput,
  QueryInput,
  QueryOutput,
} from "./tasks/contract.ts"
import { TaskReads } from "./tasks/read.ts"
import { taskInstructions } from "./tasks/instructions.ts"
import { TaskDispositionInput } from "./task-disposition.ts"
import { TaskClassificationAnnotationInput } from "./task-classification.ts"

const listInput = z.strictObject({ limit: z.int().min(1).max(100) })

function result<T>(
  run: () => T,
  structured = false,
  render: (output: T) => string = JSON.stringify,
) {
  return Effect.sync(() => {
    try {
      const output = run()
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

type TaskToolContext = {
  location: Plugin.Context["location"]
  permission: Pick<Plugin.Context["permission"], "assert">
  tool: Pick<Plugin.Context["tool"], "transform">
}

export function registerTaskTools(ctx: TaskToolContext, repository: TaskRepository) {
  // The host may retain an admitted tool callback while a plugin reload closes
  // its setup-scoped connection. Each execution owns its connection; never
  // retry a write just because its old connection was disposed.
  const path = repository.path
  const projectDirectory = repository.projectDirectory
  function withRepository<T>(run: (connection: TaskRepository) => T): T {
    const connection = new TaskRepository(path, projectDirectory)
    try {
      return run(connection)
    } finally {
      connection.close()
    }
  }
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "lz-submit-task",
      description:
        "Validate and persist a task; does not execute. Required idempotencyKey: 1–200 characters, non-whitespace, compared exactly within the canonical repo across sessions/restarts. Retry the same key/content to recover the original ID. Changed content conflicts; new logical work needs a new key. Object key order is ignored; array order and values matter. Invalid input returns field errors without saving.",
      input: z.toJSONSchema(TaskSubmissionSchema, { io: "input" }),
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
                  const parsed = TaskSubmissionSchema.safeParse(input)
                  if (!parsed.success)
                    return {
                      content: JSON.stringify({
                        status: "invalid",
                        errors: parsed.error.issues.map((issue) => ({
                          path: issue.path.join("."),
                          message: issue.message,
                        })),
                      }),
                    }
                  const receipt = withRepository((connection) => {
                    const submitted = submitTask(connection, parsed.data, () => ({
                      projectID: ctx.location.project.id,
                      projectDirectory: ctx.location.project.canonical,
                      workspaceDirectory: ctx.location.directory,
                      sessionID: context.sessionID,
                      startingRevision: startingRevision(ctx.location.directory),
                    }))
                    if (submitted.status !== "submitted") return submitted
                    const detail = new TaskReads(connection).get({ taskID: submitted.taskID })
                    if (detail.status !== "found") return submitted
                    return taskSubmissionSummary(
                      submitted,
                      detail.task,
                      detail.execution?.state ?? detail.task.status,
                    )
                  })
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
      input: z.toJSONSchema(TaskDispositionInput, { io: "input" }),
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
                  const receipt = withRepository((connection) =>
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
        "Architect-only append-only task-kind/v1 classification or correction. Supply one primaryKind, a requestID, the exact expected classification revision and a reason. Read lz-get-task first; stale corrections conflict and must not be automatically retried.",
      input: z.toJSONSchema(TaskClassificationAnnotationInput, { io: "input" }),
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
                  const parsed = TaskClassificationAnnotationInput.parse(input)
                  const receipt = withRepository((connection) =>
                    connection.recordTaskClassification(parsed, {
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
      name: "lz-get-task",
      description:
        "Retrieve a LAZERS task by its project-local LZ reference or legacy UUID as structured task and execution data. Implementors should use lz-get-task-instructions for readable instructions.",
      input: GetInput,
      output: GetOutput,
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
              result(
                () => withRepository((connection) => new TaskReads(connection).get(input)),
                true,
                context.agent === "lazers-implementor" ? taskInstructions : JSON.stringify,
              ),
            ),
          ),
    })
    editor.add({
      name: "lz-get-task-instructions",
      description:
        "Retrieve readable implementation instructions by project-local LZ reference or legacy UUID, including the goal, acceptance, boundaries, advisory guidance, verification and sources. Use lz-get-task when structured task and execution fields are needed.",
      input: GetInput,
      output: GetInstructionsOutput,
      options: {
        codemode: true,
        pinned: true,
        permission: "lz-get-task-instructions",
      },
      execute: (input, context) =>
        ctx.permission
          .assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "lz-get-task-instructions",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              result(
                () =>
                  taskInstructions(
                    withRepository((connection) => new TaskReads(connection).get(input)),
                  ),
                true,
                (instructions) => instructions,
              ),
            ),
          ),
    })
    editor.add({
      name: "lz-list-tasks",
      description:
        "List recent open submitted tasks in this repository, including each stable project-local LZ reference and UUID. Retired records stay available through lz-get-task or lz-query-tasks with includeRetired; use the latter for the full specification list.",
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
                withRepository((connection) => ({
                  tasks: new TaskReads(connection).query({ limit: listInput.parse(input).limit })
                    .tasks,
                })),
              ),
            ),
          ),
    })
    editor.add({
      name: "lz-query-tasks",
      description:
        "Search this project's persisted open tasks across sessions, including older records. Literal text, LZ reference, UUID and scopePath substring candidates; no semantic uniqueness or glob-conflict guarantee. Set includeRetired to review disposition history. Page with the returned cursor using unchanged filters.",
      input: QueryInput,
      output: QueryOutput,
      options: { codemode: true, pinned: true, permission: "lz-query-tasks" },
      execute: (input, context) =>
        ctx.permission
          .assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "lz-query-tasks",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              result(
                () => withRepository((connection) => new TaskReads(connection).query(input)),
                true,
              ),
            ),
          ),
    })
  })
}
