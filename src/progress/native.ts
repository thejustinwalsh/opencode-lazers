import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect, Stream } from "effect"
import { z } from "zod"
import {
  advanceNativeIdleSequence,
  confirmNativeIdleBackgroundSuccess,
  invalidateNativeIdleObserver,
  nativeIdleObservationFence,
  markNativeIdleBackgroundUnknown,
  noteStaleNativeIdleBackgroundEvent,
  observeNativeIdleBackground,
  releaseNativeIdleObserver,
  rememberNativeExecution,
  nativeExecutionCursor,
  forgetNativeExecution,
} from "../runner/native.ts"
import { privacyStats, safeError } from "../trajectory/privacy.ts"
import { ProgressInput } from "./schema.ts"
import type { ProgressRecorder } from "./recorder.ts"

type ProgressContext = Pick<Plugin.Context, "event" | "permission" | "session" | "tool">

const NATIVE_EVENT_TYPES = [
  "session.usage.updated",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.synthetic",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.text.ended",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.retry.scheduled",
  "session.shell.started",
  "session.shell.ended",
] as const

const BACKGROUND_INVALIDATING_EVENTS = new Set<string>([
  "session.execution.started",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.synthetic",
  "session.shell.started",
  "session.shell.ended",
])

type IdleLineage = {
  inputID: string
  executionStartSequence: number
  eventSequence: number
}

type SessionEventCursor = {
  lastSequence?: number
  executionStartSequence?: number
  idle?: IdleLineage
}

const HANDOFF_REMINDER =
  "Provide only any remaining concise handoff: changes, checks/artifact/commit, blockers, or judgment needed from the plan owner. Do not repeat recorded facts, claim acceptance, or alter task state."

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function latestInputID(messages: readonly unknown[]): string | undefined {
  for (const message of [...messages].reverse()) {
    const value = object(message)
    if ((value?.type === "user" || value?.type === "synthetic") && typeof value.id === "string")
      return value.id
  }
  return undefined
}

function eventSequence(event: unknown, sessionID: string): number | undefined {
  const durable = object(object(event)?.durable)
  if (
    durable?.aggregateID !== sessionID ||
    typeof durable.seq !== "number" ||
    !Number.isSafeInteger(durable.seq) ||
    durable.seq < 0
  )
    return undefined
  return durable.seq
}

function hasVisibleHandoff(messages: readonly unknown[]): boolean {
  let lastPrompt = -1
  for (const [index, raw] of messages.entries()) {
    const message = object(raw)
    if (message?.type === "user" || message?.type === "synthetic") lastPrompt = index
  }
  let lastAssistant = -1
  let lastToolWork = lastPrompt
  for (const [index, raw] of messages.entries()) {
    if (index <= lastPrompt) continue
    const message = object(raw)
    if (message?.type === "tool" || message?.type === "shell") lastToolWork = index
    if (message?.type !== "assistant" || !Array.isArray(message.content)) continue
    lastAssistant = index
    if (
      message.content.some((part) => {
        const item = object(part)
        return item?.type === "tool"
      })
    )
      lastToolWork = index
  }
  if (lastAssistant < 0 || lastAssistant <= lastToolWork) return false
  const finalAssistant = object(messages[lastAssistant])
  if (finalAssistant?.finish !== "stop" || !Array.isArray(finalAssistant.content)) return false
  return finalAssistant.content.some((part) => {
    const item = object(part)
    return item?.type === "text" && typeof item.text === "string" && item.text.trim().length > 0
  })
}

function confirmedSyntheticRejection(error: unknown): boolean {
  const value = object(error)
  return (
    value?._tag === "InvalidRequestError" ||
    value?._tag === "UnauthorizedError" ||
    value?._tag === "LocationNotFoundError" ||
    value?._tag === "SessionNotFoundError"
  )
}

function reminderEffect(
  ctx: ProgressContext,
  recorder: ProgressRecorder,
  sessionID: string,
  backgroundCount: number,
) {
  return Effect.tryPromise({
    try: async () => {
      if (backgroundCount > 0) return
      const assignment = recorder.assignmentForSession(sessionID)
      if (!assignment || assignment.attemptState !== "running") return
      const session = await Effect.runPromise(
        ctx.session.get({ sessionID: Session.ID.make(sessionID) }),
      )
      if (
        session.id !== sessionID ||
        session.projectID !== assignment.projectID ||
        session.agent !== "lazers-implementor" ||
        session.location.directory !== assignment.workspace
      )
        return
      const messages = await Effect.runPromise(ctx.session.context({ sessionID: session.id }))
      if (hasVisibleHandoff(messages)) return
      const proposedMessageID = SessionMessage.ID.create()
      const claim = recorder.claimReminder(sessionID, HANDOFF_REMINDER, proposedMessageID)
      if (!claim) return
      try {
        const admitted = await Effect.runPromise(
          ctx.session.synthetic({
            sessionID: Session.ID.make(sessionID),
            id: SessionMessage.ID.make(claim.messageID),
            description: "LAZERS concise worker handoff",
            text: HANDOFF_REMINDER,
            metadata: claim.ownership,
            delivery: "steer",
          }),
        )
        if (admitted.id === claim.messageID) recorder.finishReminder(claim, "admitted")
        else recorder.finishReminder(claim, "unknown")
      } catch (error) {
        recorder.finishReminder(
          claim,
          confirmedSyntheticRejection(error) ? "rejected" : "unknown",
          error,
        )
      }
    },
    catch: (error) => new Error(safeError(error, privacyStats())),
  }).pipe(Effect.catch(() => Effect.void))
}

async function reconcileSessions(
  ctx: ProgressContext,
  recorder: ProgressRecorder,
  projectID: string,
) {
  for (const assignment of recorder.assignments()) {
    let session: Session.Info
    try {
      session = await Effect.runPromise(
        ctx.session.get({ sessionID: Session.ID.make(assignment.sessionID) }),
      )
    } catch (error) {
      recorder.markRecoveryGap(
        assignment.sessionID,
        `Assigned native session is unavailable: ${safeError(error, privacyStats())}`,
      )
      continue
    }
    if (
      session.id !== assignment.sessionID ||
      session.projectID !== projectID ||
      session.agent !== "lazers-implementor" ||
      session.location.directory !== assignment.workspace
    ) {
      recorder.markRecoveryGap(
        assignment.sessionID,
        "Assigned session identity, project, agent, or workspace no longer matches its runner attempt.",
      )
      continue
    }
    recorder.recordSessionSnapshot(assignment.sessionID, session)
    recorder.recordSessionOutcome(assignment.sessionID, session)
    try {
      const messages = await Effect.runPromise(ctx.session.context({ sessionID: session.id }))
      recorder.reconcileMessages(assignment.sessionID, messages)
    } catch (error) {
      recorder.markRecoveryGap(
        assignment.sessionID,
        `Retained public session context is unavailable: ${safeError(error, privacyStats())}`,
      )
    }
  }
}

export function registerProgress(
  ctx: ProgressContext,
  recorder: ProgressRecorder,
  projectID: string,
) {
  return Effect.gen(function* () {
    const observer = Symbol("native-idle-observer")
    let observing = true
    const projectDirectory = recorder.store.repository.projectDirectory
    const sessionEventCursors = new Map<string, SessionEventCursor>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        observing = false
        releaseNativeIdleObserver(observer)
      }),
    )
    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "lazers_report_progress",
        description:
          "Record a concise progress note or handoff for this assigned worker attempt. Commentary is an annotation only: it cannot verify, accept, schedule, or change task state. Identity is resolved from the current native worker session.",
        input: z.toJSONSchema(ProgressInput, { io: "input" }),
        output: z.toJSONSchema(z.record(z.string(), z.unknown()), { io: "output" }),
        options: {
          codemode: true,
          permission: "lazers_report_progress",
        },
        execute: (input, call) =>
          ctx.permission
            .assert({
              sessionID: call.sessionID,
              agent: call.agent,
              action: "lazers_report_progress",
              resources: ["*"],
            })
            .pipe(
              Effect.flatMap(() =>
                Effect.tryPromise({
                  try: async () => {
                    const parsed = ProgressInput.parse(input)
                    const saved = recorder.report({
                      sessionID: call.sessionID,
                      agent: call.agent,
                      messageID: call.messageID,
                      callID: call.id,
                      message: parsed.message,
                    })
                    return {
                      content: `Progress recorded at sequence ${saved.sequence}.`,
                      output: saved,
                    }
                  },
                  catch: (error) => new Tool.Error({ message: safeError(error, privacyStats()) }),
                }),
              ),
            ),
      }),
    )

    yield* ctx.tool.hook("execute.after", (call) =>
      Effect.sync(() => {
        try {
          recorder.recordToolHook({
            tool: call.tool,
            sessionID: call.sessionID,
            agent: call.agent,
            messageID: call.messageID,
            callID: call.id,
            status: call.status,
            ...(call.status === "completed" ? { result: call.result } : { error: call.error }),
          })
        } catch {
          // A later retained-session reconciliation can recover public results.
        }
      }),
    )

    yield* ctx.session.hook("experimental.idle", (idle) =>
      Effect.gen(function* () {
        const stillCurrent = nativeIdleObservationFence(idle.sessionID)
        let stale = false
        yield* ctx.session.context({ sessionID: idle.sessionID }).pipe(
          Effect.match({
            onSuccess: (messages) => {
              if (!observing || !stillCurrent()) {
                stale = true
                return
              }
              let cursor = sessionEventCursors.get(idle.sessionID)
              if (cursor?.executionStartSequence === undefined) {
                const inherited = nativeExecutionCursor(projectDirectory, idle.sessionID)
                if (inherited) {
                  cursor = inherited
                  sessionEventCursors.set(idle.sessionID, inherited)
                }
              }
              const inputID = latestInputID(messages)
              if (
                !inputID ||
                cursor?.executionStartSequence === undefined ||
                cursor.lastSequence === undefined
              ) {
                sessionEventCursors.delete(idle.sessionID)
                markNativeIdleBackgroundUnknown(
                  idle.sessionID,
                  "Experimental idle report could not be tied to the current execution and input",
                  observer,
                )
                return
              }
              const lineage: IdleLineage = {
                inputID,
                executionStartSequence: cursor.executionStartSequence,
                eventSequence: cursor.lastSequence,
              }
              if (
                observeNativeIdleBackground(
                  idle.sessionID,
                  idle.background,
                  lineage,
                  Date.now(),
                  observer,
                )
              )
                cursor.idle = lineage
              else {
                stale = true
                cursor.idle = undefined
              }
            },
            onFailure: () => {
              if (!observing || !stillCurrent()) {
                stale = true
                return
              }
              sessionEventCursors.delete(idle.sessionID)
              markNativeIdleBackgroundUnknown(
                idle.sessionID,
                "Native input lineage was unavailable at experimental.idle",
                observer,
              )
            },
          }),
        )
        if (!stale && observing)
          yield* reminderEffect(ctx, recorder, idle.sessionID, idle.background.length)
      }),
    )

    const listen = Effect.forever(
      Stream.runForEach(ctx.event.subscribe({ types: NATIVE_EVENT_TYPES }), (event) =>
        Effect.gen(function* () {
          try {
            const rawType = object(event)?.type
            const rawSessionID = object(object(event)?.data)?.sessionID
            const type = typeof rawType === "string" ? rawType : undefined
            const sessionID = typeof rawSessionID === "string" ? rawSessionID : undefined
            if (
              observing &&
              type &&
              sessionID &&
              (BACKGROUND_INVALIDATING_EVENTS.has(type) || type === "session.execution.succeeded")
            ) {
              const cursor = sessionEventCursors.get(sessionID) ?? {}
              sessionEventCursors.set(sessionID, cursor)
              const sequence = eventSequence(event, sessionID)
              const ordering =
                sequence === undefined
                  ? undefined
                  : advanceNativeIdleSequence(sessionID, sequence, observer)
              if (sequence === undefined) {
                forgetNativeExecution(projectDirectory, sessionID)
                cursor.executionStartSequence = undefined
                cursor.idle = undefined
                markNativeIdleBackgroundUnknown(
                  sessionID,
                  `Native ${type} had no trustworthy durable session sequence`,
                  observer,
                )
              } else if (ordering === "stale") {
                noteStaleNativeIdleBackgroundEvent(sessionID, sequence, observer)
              } else if (cursor.lastSequence !== undefined && sequence <= cursor.lastSequence) {
                if (cursor.idle && sequence < cursor.idle.eventSequence)
                  noteStaleNativeIdleBackgroundEvent(sessionID, sequence, observer)
              } else {
                rememberNativeExecution(projectDirectory, sessionID, type, sequence)
                cursor.lastSequence = sequence
                if (type === "session.execution.started") {
                  cursor.executionStartSequence = sequence
                  cursor.idle = undefined
                  if (ordering === "newer")
                    markNativeIdleBackgroundUnknown(
                      sessionID,
                      "A newer native foreground execution started after the last experimental.idle report",
                      observer,
                      true,
                    )
                } else if (type === "session.execution.succeeded") {
                  const idle = cursor.idle
                  if (
                    !idle ||
                    idle.executionStartSequence !== cursor.executionStartSequence ||
                    sequence <= idle.eventSequence
                  ) {
                    cursor.idle = undefined
                    markNativeIdleBackgroundUnknown(
                      sessionID,
                      "Native execution success did not match the current experimental.idle execution",
                      observer,
                    )
                  } else {
                    const stillCurrent = nativeIdleObservationFence(sessionID, observer)
                    const messages = yield* ctx.session
                      .context({ sessionID: Session.ID.make(sessionID) })
                      .pipe(
                        Effect.match({
                          onSuccess: (value) => value,
                          onFailure: () => undefined,
                        }),
                      )
                    if (observing && stillCurrent()) {
                      if (latestInputID(messages ?? []) !== idle.inputID) {
                        cursor.idle = undefined
                        markNativeIdleBackgroundUnknown(
                          sessionID,
                          "Native execution success no longer matched the idle report input lineage",
                          observer,
                        )
                      } else if (
                        !confirmNativeIdleBackgroundSuccess(sessionID, idle, sequence, observer)
                      ) {
                        cursor.idle = undefined
                        markNativeIdleBackgroundUnknown(
                          sessionID,
                          "Native execution success could not confirm the current idle report",
                          observer,
                        )
                      }
                    }
                  }
                } else {
                  cursor.idle = undefined
                  if (ordering === "newer")
                    markNativeIdleBackgroundUnknown(
                      sessionID,
                      `Native ${type} was observed after the last experimental.idle background report`,
                      observer,
                      true,
                    )
                }
              }
            }
            recorder.recordNativeEvent(event)
          } catch {
            const sessionID = object(object(event)?.data)?.sessionID
            if (
              typeof sessionID === "string" &&
              observing &&
              nativeIdleObservationFence(sessionID, observer)()
            )
              markNativeIdleBackgroundUnknown(
                sessionID,
                "Native event observation failed; experimental.idle lineage is unknown",
                observer,
              )
          }
        }),
      ).pipe(
        Effect.match({
          onFailure: () => {
            for (const [id, cursor] of sessionEventCursors)
              forgetNativeExecution(projectDirectory, id, cursor.lastSequence)
            invalidateNativeIdleObserver(observer, "Native event stream disconnected")
            sessionEventCursors.clear()
            for (const assignment of recorder.assignments())
              recorder.markRecoveryGap(
                assignment.sessionID,
                "Native event stream disconnected; retained public session facts are reconciled at startup.",
                "event-stream",
              )
          },
          onSuccess: () => {
            for (const [id, cursor] of sessionEventCursors)
              forgetNativeExecution(projectDirectory, id, cursor.lastSequence)
            invalidateNativeIdleObserver(observer, "Native event stream ended")
            sessionEventCursors.clear()
            for (const assignment of recorder.assignments())
              recorder.markRecoveryGap(
                assignment.sessionID,
                "Native event stream ended; retained public session facts are reconciled at startup.",
                "event-stream",
              )
          },
        }),
        Effect.andThen(Effect.sleep(1_000)),
      ),
    )
    yield* Effect.forkScoped(listen)
    yield* Effect.forkScoped(
      Effect.tryPromise({
        try: () => reconcileSessions(ctx, recorder, projectID),
        catch: (error) => new Error(safeError(error, privacyStats())),
      }).pipe(Effect.catch(() => Effect.void)),
    )
  })
}
