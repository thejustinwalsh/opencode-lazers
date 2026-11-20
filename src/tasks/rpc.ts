import { timedRpc } from "../diagnostics/stall-probe.ts"
import { FallowConfigRequiredError } from "../audit/fallow-refusal.ts"
import { isWorkerAgent } from "../runner/worker-agent.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { DateTime, Effect } from "effect"
import { Tool } from "@opencode/schema/tool"
import { z } from "zod"
import { resolve, isAbsolute } from "node:path"
import type { CurrentActivityTarget, TaskReads } from "./read.ts"
import { CurrentActivityInput, CurrentActivityOutput, Tasks } from "./contract.ts"
import type { CurrentTaskActivity } from "./contract.ts"
import { SchedulingInput, SchedulingOutput, TasksScheduling } from "./scheduling-contract.ts"
import type { TaskRuntime } from "../runner/runtime.ts"
import type { HostSession } from "../runner/host.ts"
import { revisionPublishers } from "../database-events.ts"
import { TaskAdviceToolInput, recordTaskAdvice } from "./advice.ts"
import { tolerantJsonSchema } from "../legacy-fields.ts"
import { guardedWrite } from "./observed-revisions.ts"
import { allProjectsAccess } from "../projects/read-access.ts"
import { loadedProjectDirectories } from "../core/registry.ts"

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null
}

function matchesCurrentWorker(
  worker: HostSession | null,
  target: CurrentActivityTarget,
  projectID: string,
): worker is HostSession {
  return Boolean(
    worker &&
    target.authorized &&
    target.attempt &&
    worker.id === target.attempt.sessionID &&
    worker.projectID === projectID &&
    isWorkerAgent(worker.agent) &&
    worker.metadata?.lazersAttemptID === target.attempt.id &&
    isAbsolute(worker.directory) &&
    isAbsolute(target.attempt.workspace) &&
    resolve(worker.directory) === resolve(target.attempt.workspace) &&
    typeof worker.busy === "boolean" &&
    worker.observationUnstable !== true,
  )
}

function sameWorkerObservation(left: HostSession, right: HostSession): boolean {
  return (
    left.id === right.id &&
    left.projectID === right.projectID &&
    left.directory === right.directory &&
    left.agent === right.agent &&
    left.archived === right.archived &&
    left.metadata?.lazersAttemptID === right.metadata?.lazersAttemptID &&
    left.busy === right.busy &&
    left.pendingInput === right.pendingInput &&
    left.pendingPermissions === right.pendingPermissions &&
    left.pendingForms === right.pendingForms &&
    left.outcome === right.outcome &&
    left.observationUnstable === right.observationUnstable
  )
}

function requireSession<T>(session: T | undefined): T {
  if (!session) throw new Error("Task scope is unavailable")
  return session
}

export function registerTaskReads(
  ctx: Pick<Plugin.Context, "rpc" | "permission"> &
    Partial<Pick<Plugin.Context, "tool" | "session">>,
  reads: TaskReads,
  runtime: TaskRuntime,
  options: { loaded?: () => Iterable<string> } = {},
) {
  const loaded = options.loaded ?? loadedProjectDirectories
  return Effect.gen(function* () {
    const rpc = yield* timedRpc(ctx.rpc).register(Tasks, {
      query: (input) =>
        input.allProjects
          ? Effect.tryPromise({
              try: async () => {
                const sessionService = ctx.session
                if (!sessionService) throw new Error("Task scope is unavailable")
                const access = await allProjectsAccess(
                  { session: sessionService },
                  {
                    sessionID: input.sessionID!,
                    projectID: runtime.projectID,
                    repository: reads.repository,
                    loaded,
                    unavailable: "Task scope is unavailable",
                  },
                )
                return reads.queryAll(input, access)
              },
              catch: (error) => (error instanceof Error ? error : new Error(String(error))),
            }).pipe(Effect.orDie)
          : Effect.sync(() => {
              const page = reads.query(input)
              return {
                ...page,
                tasks: page.tasks.map((task) => {
                  if (task.recordedState !== undefined) return task
                  const recordedState = reads.recordedStateForTask(task.taskID)
                  return recordedState ? { ...task, recordedState } : task
                }),
              }
            }),
      get: (input) =>
        input.allProjects
          ? Effect.tryPromise({
              try: async () =>
                reads.getAll(
                  input,
                  await allProjectsAccess(
                    { session: requireSession(ctx.session) },
                    {
                      sessionID: input.sessionID!,
                      projectID: runtime.projectID,
                      repository: reads.repository,
                      loaded,
                      unavailable: "Task scope is unavailable",
                    },
                  ),
                ),
              catch: (error) => (error instanceof Error ? error : new Error(String(error))),
            }).pipe(Effect.orDie)
          : Effect.sync(() => reads.get(input)),
      currentActivity: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = CurrentActivityInput.parse(input)
            const sessionService = ctx.session
            if (!sessionService) throw new Error("Current task activity is unavailable")
            const readScope = async (authorize: boolean) => {
              let actor
              try {
                actor = await Effect.runPromise(
                  sessionService
                    .get({ sessionID: Session.ID.make(request.sessionID) })
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
                throw new Error("Task activity scope is unavailable")
              }
              if (
                !actor ||
                actor.id !== request.sessionID ||
                actor.projectID !== runtime.projectID ||
                !actor.agent
              )
                throw new Error("Task activity scope is unavailable")
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

            signal.throwIfAborted()
            const initialScope = await readScope(request.scope !== "all")
            signal.throwIfAborted()
            const sessionScope = request.scope === "session" ? request.sessionID : undefined
            const everyProject =
              request.scope === "all"
                ? await allProjectsAccess(
                    { session: sessionService },
                    {
                      sessionID: request.sessionID,
                      projectID: runtime.projectID,
                      repository: reads.repository,
                      loaded,
                      unavailable: "Task activity scope is unavailable",
                    },
                  )
                : undefined
            const targets = async () =>
              everyProject
                ? reads.currentActivityTargetsAll(request.taskIDs, everyProject)
                : reads.currentActivityTargets(request.taskIDs, sessionScope)
            const before = await targets()
            const initial = await Promise.all(
              before.map(async (target): Promise<CurrentTaskActivity> => {
                const unknown = (
                  reason: "no-current-attempt" | "unavailable",
                  current = target,
                ): CurrentTaskActivity => ({
                  taskID: target.taskID,
                  ...(current.authorized && current.attempt
                    ? { workerSessionID: current.attempt.sessionID }
                    : {}),
                  attemptID: current.authorized ? (current.attempt?.id ?? null) : null,
                  foreground: "unknown",
                  unknownReason: reason,
                  recordedState: current.authorized ? current.recordedState : null,
                  waiting: current.authorized && current.waiting,
                  holdReason: current.authorized ? current.holdReason : null,
                  pendingInput: null,
                  pendingPermissions: null,
                  pendingForms: null,
                  outcome: null,
                  observedAt: null,
                })
                if (!target.authorized) return unknown("unavailable")
                if (!target.attempt) return unknown("no-current-attempt")
                signal.throwIfAborted()
                let worker: HostSession | null
                try {
                  worker = await runtime.host.session(target.attempt.sessionID, { messages: false })
                } catch {
                  if (signal.aborted) signal.throwIfAborted()
                  return unknown("unavailable")
                }
                signal.throwIfAborted()
                if (!matchesCurrentWorker(worker, target, runtime.projectID))
                  return unknown("unavailable")
                let confirmation: HostSession | null
                try {
                  confirmation = await runtime.host.session(target.attempt.sessionID, {
                    messages: false,
                  })
                } catch {
                  if (signal.aborted) signal.throwIfAborted()
                  return unknown("unavailable")
                }
                signal.throwIfAborted()
                if (
                  !matchesCurrentWorker(confirmation, target, runtime.projectID) ||
                  !sameWorkerObservation(worker, confirmation)
                )
                  return unknown("unavailable")
                return {
                  taskID: target.taskID,
                  workerSessionID: target.attempt.sessionID,
                  attemptID: target.attempt.id,
                  foreground: worker.busy ? "active" : "inactive",
                  archived: worker.archived,
                  unknownReason: null,
                  recordedState: target.recordedState,
                  waiting: target.waiting,
                  holdReason: target.holdReason,
                  pendingInput:
                    typeof worker.pendingInput === "boolean" ? worker.pendingInput : null,
                  pendingPermissions: nonnegativeInteger(worker.pendingPermissions),
                  pendingForms: nonnegativeInteger(worker.pendingForms),
                  outcome: worker.outcome ?? null,
                  observedAt: Date.now(),
                }
              }),
            )
            signal.throwIfAborted()
            const after = await targets()
            const currentScope = await readScope(false)
            signal.throwIfAborted()
            // Native DateTime values are freshly decoded on each read.
            const initialArchivedAt = initialScope.time.archived
              ? DateTime.toEpochMillis(initialScope.time.archived)
              : undefined
            const currentArchivedAt = currentScope.time.archived
              ? DateTime.toEpochMillis(currentScope.time.archived)
              : undefined
            const scopeChanged =
              currentScope.id !== initialScope.id ||
              currentScope.projectID !== initialScope.projectID ||
              currentScope.location.directory !== initialScope.location.directory ||
              currentScope.agent !== initialScope.agent ||
              currentArchivedAt !== initialArchivedAt
            const currentByID = new Map(after.map((target) => [target.taskID, target]))
            const activities = initial.map((activity, index) => {
              const original = before[index]!
              const current = currentByID.get(activity.taskID)
              if (
                scopeChanged ||
                !current ||
                JSON.stringify(original) !== JSON.stringify(current)
              ) {
                const latest = current ?? original
                return {
                  taskID: activity.taskID,
                  attemptID: latest.authorized ? (latest.attempt?.id ?? null) : null,
                  foreground: "unknown" as const,
                  unknownReason: "unavailable" as const,
                  recordedState: latest.authorized ? latest.recordedState : null,
                  waiting: latest.authorized && latest.waiting,
                  holdReason: latest.authorized ? latest.holdReason : null,
                  pendingInput: null,
                  pendingPermissions: null,
                  pendingForms: null,
                  outcome: null,
                  observedAt: null,
                }
              }
              return activity
            })
            const projectOf = new Map(before.map((target) => [target.taskID, target.project]))
            return CurrentActivityOutput.parse({
              activities: activities.map((activity) => {
                const project = projectOf.get(activity.taskID)
                return project ? { ...activity, project } : activity
              }),
            })
          },
          catch: () => new Error("Current task activity is unavailable"),
        }).pipe(Effect.orDie),
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
