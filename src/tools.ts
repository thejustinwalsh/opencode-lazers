import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { z } from "zod"
import { Tool } from "@opencode/schema/tool"
import { TaskRepository } from "./storage.ts"
import { startingRevision, submitTask } from "./submission.ts"
import { TaskSubmissionSchema } from "./task.ts"
import { GetInput, GetOutput, QueryInput, QueryOutput } from "./tasks/contract.ts"
import { TaskReads } from "./tasks/read.ts"

const listInput = z.strictObject({ limit: z.int().min(1).max(100) })

function result<T>(run: () => T, structured = false) {
  return Effect.sync(() => {
    try {
      const output = run()
      return structured
        ? { content: JSON.stringify(output), output }
        : { content: JSON.stringify(output) }
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
      name: "lazers_submit_task",
      description:
        "Validate and persist a task, not execute it. Choose required idempotencyKey before the first call: 1–200 characters containing non-whitespace text, compared exactly without trimming/normalization. Keys are durable within the canonical repository, shared across sessions/worktrees. Reuse the same key and validated content after an ambiguous/lost response or restart to recover the original submitted taskID/revision. Object property order is ignored; array order and field values matter. Changed valid content returns {status:'conflict',message}; invalid input returns field guidance. Use a new key only for a new logical submission. Cost limits are equivalent API USD, not subscription charges.",
      input: z.toJSONSchema(TaskSubmissionSchema, { io: "input" }),
      options: { codemode: false, permission: "lazers_submit_task" },
      execute: (input, context) =>
        ctx.permission
          .assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "lazers_submit_task",
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
                  const receipt = withRepository((connection) =>
                    submitTask(connection, parsed.data, () => ({
                      projectID: ctx.location.project.id,
                      projectDirectory: ctx.location.project.canonical,
                      workspaceDirectory: ctx.location.directory,
                      sessionID: context.sessionID,
                      startingRevision: startingRevision(ctx.location.directory),
                    })),
                  )
                  return { content: JSON.stringify(receipt) }
                },
                catch: (error) => new Tool.Error({ message: String(error) }),
              }),
            ),
          ),
    })
    editor.add({
      name: "lazers_get_task",
      description: "Retrieve a submitted LAZERS task by its durable UUID in this repository.",
      input: GetInput,
      output: GetOutput,
      options: { codemode: true, pinned: true, permission: "lazers_get_task" },
      execute: (input, context) =>
        ctx.permission
          .assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "lazers_get_task",
            resources: ["*"],
          })
          .pipe(
            Effect.flatMap(() =>
              result(
                () => withRepository((connection) => new TaskReads(connection).get(input)),
                true,
              ),
            ),
          ),
    })
    editor.add({
      name: "lazers_list_tasks",
      description:
        "List recent submitted tasks in this repository. Use lazers_get_task for the full specification.",
      input: listInput,
      options: { codemode: false, permission: "lazers_list_tasks" },
      execute: (input, context) =>
        ctx.permission
          .assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "lazers_list_tasks",
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
      name: "lazers_query_tasks",
      description:
        "Search this project's persisted tasks across sessions, including older records. Literal text/ID and scopePath substring candidates; no semantic uniqueness or glob-conflict guarantee. Page with the returned cursor using unchanged filters.",
      input: QueryInput,
      output: QueryOutput,
      options: { codemode: true, pinned: true, permission: "lazers_query_tasks" },
      execute: (input, context) =>
        ctx.permission
          .assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "lazers_query_tasks",
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
