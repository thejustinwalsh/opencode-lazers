import { timedRpc } from "../diagnostics/stall-probe.ts"
import { FallowConfigRequiredError } from "../audit/fallow-refusal.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { Tool } from "@opencode/schema/tool"
import { Tasks } from "./contract.ts"
import type { TaskRepository } from "../storage.ts"
import { SchedulingInput, SchedulingOutput, TasksScheduling } from "./scheduling-contract.ts"
import type { TaskRuntime } from "../runner/runtime.ts"
import { revisionPublishers } from "../database-events.ts"
import { TaskAdviceToolInput, recordTaskAdvice } from "./advice.ts"
import { tolerantJsonSchema } from "../legacy-fields.ts"
import { guardedWrite } from "./observed-revisions.ts"

/**
 * The Tasks RPC: `start` (a write). Task detail is read through the `tasks.detail` family of
 * streams (`readTaskDetail`), by the Tasks and Models panels alike.
 */
export function registerTaskReads(
  ctx: Pick<Plugin.Context, "rpc" | "permission"> &
    Partial<Pick<Plugin.Context, "tool" | "session">>,
  repository: TaskRepository,
  runtime: TaskRuntime,
) {
  const reads = { repository }
  return Effect.gen(function* () {
    const rpc = yield* timedRpc(ctx.rpc).register(Tasks, {
      start: (input) =>
        Effect.tryPromise({
          try: async () => {
            const actor = await runtime.host.session(input.sessionID)
            if (!actor || actor.archived || actor.projectID !== runtime.projectID || !actor.agent)
              throw new Error("Start requires a live session in this project")
            await Effect.runPromise(
              ctx.permission.assert({
                sessionID: Session.ID.make(actor.id),
                agent: Agent.ID.make(actor.agent),
                action: "lz-start-task",
                resources: [input.taskID],
              }),
            )
            return runtime.startTask(input).catch((error: unknown) => {
              // The panel gets the typed refusal, not an exception string.
              if (error instanceof FallowConfigRequiredError) return error.refusal
              throw error
            })
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.orDie),
    })
    yield* timedRpc(ctx.rpc).register(TasksScheduling, {
      read: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            signal.throwIfAborted()
            const request = SchedulingInput.parse(input)
            const sessionService = ctx.session
            if (!sessionService) throw new Error("Task scheduling scope is unavailable")
            const readScope = async (authorize: boolean) => {
              let actor
              try {
                actor = await Effect.runPromise(
                  sessionService
                    .get({ sessionID: Session.ID.make(request.scope.sessionID) })
                    .pipe(
                      Effect.catch((error) =>
                        typeof error === "object" &&
                        error !== null &&
                        "_tag" in error &&
                        error._tag === "SessionNotFoundError"
                          ? Effect.succeed(null)
                          : Effect.fail(error),
                      ),
                    ),
                )
              } catch {
                throw new Error("Task scheduling scope is unavailable")
              }
              if (
                !actor ||
                actor.id !== request.scope.sessionID ||
                actor.projectID !== runtime.projectID ||
                actor.time.archived !== undefined ||
                !actor.agent
              )
                throw new Error("Task scheduling scope is unavailable")
              if (authorize)
                await Effect.runPromise(
                  ctx.permission.assert({
                    sessionID: Session.ID.make(actor.id),
                    agent: Agent.ID.make(actor.agent),
                    action: "read",
                    resources: [reads.repository.projectDirectory],
                  }),
                )
              return actor
            }

            const initialScope = await readScope(true)
            signal.throwIfAborted()
            const result = await runtime.readScheduling(request)
            signal.throwIfAborted()
            const currentScope = await readScope(false)
            signal.throwIfAborted()
            if (
              currentScope.id !== initialScope.id ||
              currentScope.projectID !== initialScope.projectID ||
              currentScope.location.directory !== initialScope.location.directory ||
              currentScope.agent !== initialScope.agent ||
              currentScope.time.archived !== initialScope.time.archived
            )
              throw new Error("Task scheduling scope changed during the read")
            return SchedulingOutput.parse(result)
          },
          catch: () => new Error("Task scheduling read is unavailable"),
        }).pipe(Effect.orDie),
    })
    if (ctx.tool)
      yield* ctx.tool.transform((editor) => {
        editor.add({
          name: "lz-attach-task-advice",
          description:
            "Architect-only: attach concise findings and implementation advice to an existing task without changing its specification. Supply a requestID; advice attaches to the task's current specification and appends to its advice history. Read the task with lz-get-task first: a write on a view older than the current advice revision conflicts, writes nothing, and is retried with a new requestID after re-reading. Reuse requestID only for exact retries; changed content conflicts. Advice history is bounded and retained. Optional source/mini-skill references are links only and are never fetched.",
          input: tolerantJsonSchema(TaskAdviceToolInput),
          options: { codemode: true, permission: "lz-attach-task-advice" },
          execute: (input, context) =>
            ctx.permission
              .assert({
                sessionID: context.sessionID,
                agent: context.agent,
                action: "lz-attach-task-advice",
                resources: ["*"],
              })
              .pipe(
                Effect.flatMap(() =>
                  Effect.tryPromise({
                    try: async () => {
                      if (context.agent !== "architect")
                        throw new Tool.Error({
                          message: "Task advice attachment is restricted to Architect",
                        })
                      const parsed = TaskAdviceToolInput.parse(input)
                      const receipt = await reads.repository.retryBusy(() =>
                        guardedWrite(
                          reads.repository,
                          {
                            sessionID: context.sessionID,
                            taskID: parsed.taskID,
                            kind: "advice",
                            recordKey: "advice",
                          },
                          (expectedRevision) =>
                            recordTaskAdvice(
                              reads.repository,
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
      })
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        revisionPublishers.publishRevisions(
          reads.repository.path,
          JSON.stringify(["tasks.changed", reads.repository.projectDirectory]),
          {
            read: () => reads.repository.version(),
            emit: (version) =>
              Effect.runPromise(
                rpc.events.emit("changed", {
                  projectDirectory: reads.repository.projectDirectory,
                  version,
                }),
              ),
          },
        ),
      ),
      (close) => Effect.sync(close),
    )
  })
}
