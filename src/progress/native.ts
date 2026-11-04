import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { DateTime, Effect, Stream } from "effect"
import { z } from "zod"
import { NativeIdleStore } from "../runner/native-idle.ts"
import type { NativeIdleBinding, NativeIdleTerminal } from "../runner/native-idle.ts"
import { privacyStats, safeError } from "../trajectory/privacy.ts"
import { ProgressInput } from "./schema.ts"
import { resolveNativeInputID } from "../runner/native-input.ts"
import type { ProgressAssignment, ProgressRecorder } from "./recorder.ts"
import {
  registerProgressReconstruction,
  sameProgressAssignment,
  type ReconstructionRead,
} from "./reconstruction.ts"

type ProgressContext = Pick<
  Plugin.Context,
  "event" | "permission" | "session" | "tool" | "location"
>

const NATIVE_EVENT_TYPES = [
  "session.created",
  "session.deleted",
  "session.moved",
  "session.usage.updated",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
  "session.synthetic",
  "session.step.started",
  "session.step.streamed",
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
  "session.compaction.ended",
  "session.compaction.failed",
  "session.idle",
  "session.status",
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

const HANDOFF_REMINDER =
  "Provide only any remaining concise handoff: changes, checks/artifact/commit, blockers, or judgment needed from the plan owner. Do not repeat recorded facts, claim acceptance, or alter task state."

type NativeIdleWork = { kind: "shell" | "subagent" | "image" }
type NativeIdleHook = { sessionID: Session.ID; background: readonly NativeIdleWork[] }

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
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

function idleBinding(
  assignment: ReturnType<ProgressRecorder["assignmentForSession"]>,
  projectDirectory: string,
): NativeIdleBinding | undefined {
  if (!assignment) return undefined
  return {
    projectDirectory,
    projectID: assignment.projectID,
    attemptID: assignment.attemptID,
    sessionID: assignment.sessionID,
    workspace: assignment.workspace,
    assignedMessageID: assignment.assignedMessageID,
  }
}

function sameIdleBinding(a: NativeIdleBinding | undefined, b: NativeIdleBinding | undefined) {
  return (
    a?.projectDirectory === b?.projectDirectory &&
    a?.projectID === b?.projectID &&
    a?.attemptID === b?.attemptID &&
    a?.sessionID === b?.sessionID &&
    a?.workspace === b?.workspace &&
    a?.assignedMessageID === b?.assignedMessageID
  )
}

function hasExactSuccessfulIdleMarker(messages: readonly unknown[], terminal: NativeIdleTerminal) {
  let expectedID: string
  try {
    expectedID = SessionMessage.ID.fromEvent(terminal.eventID)
  } catch {
    return false
  }
  if (expectedID !== terminal.messageID) return false
  return messages.some((raw) => {
    const message = object(raw)
    if (
      message?.type !== "idle" ||
      message.id !== terminal.messageID ||
      message.outcome !== "succeeded"
    )
      return false
    const time = object(message.time)
    return (
      DateTime.isDateTime(time?.created) && Number.isFinite(DateTime.toEpochMillis(time.created))
    )
  })
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

async function reconstructSession(
  ctx: ProgressContext,
  recorder: ProgressRecorder,
  assignment: ProgressAssignment,
  isCurrent: () => boolean,
  readStarted: ReconstructionRead,
) {
  const assignmentIsCurrent = () =>
    isCurrent() &&
    sameProgressAssignment(recorder.assignmentForSession(assignment.sessionID), assignment)
  let session: Session.Info
  const finishGet = readStarted("get")
  try {
    session = await Effect.runPromise(
      ctx.session.get({ sessionID: Session.ID.make(assignment.sessionID) }),
    )
    finishGet("succeeded")
  } catch (error) {
    finishGet("failed")
    if (!assignmentIsCurrent()) return "stale" as const
    recorder.markRecoveryGap(
      assignment.sessionID,
      `Assigned native session is unavailable: ${safeError(error, privacyStats())}`,
    )
    return "retry" as const
  }
  if (!assignmentIsCurrent()) return "stale" as const
  if (
    session.id !== assignment.sessionID ||
    session.projectID !== assignment.projectID ||
    session.agent !== "lazers-implementor" ||
    session.location.directory !== assignment.workspace
  ) {
    recorder.markRecoveryGap(
      assignment.sessionID,
      "Assigned session identity, project, agent, or workspace no longer matches its runner attempt.",
    )
    return "retry" as const
  }

  recorder.recordSessionSnapshot(assignment.sessionID, session)
  recorder.recordSessionOutcome(assignment.sessionID, session)
  const finishContext = readStarted("context")
  try {
    const messages = await Effect.runPromise(ctx.session.context({ sessionID: session.id }))
    finishContext("succeeded")
    if (!assignmentIsCurrent()) return "stale" as const
    recorder.reconcileMessages(assignment.sessionID, messages)
    return "complete" as const
  } catch (error) {
    finishContext("failed")
    if (!assignmentIsCurrent()) return "stale" as const
    recorder.markRecoveryGap(
      assignment.sessionID,
      `Retained public session context is unavailable: ${safeError(error, privacyStats())}`,
    )
    return "retry" as const
  }
}

export function registerProgress(
  ctx: ProgressContext,
  recorder: ProgressRecorder,
  projectID: string,
  retainedInputID: (sessionID: string) => Promise<string | undefined> = async () => undefined,
) {
  return Effect.gen(function* () {
    const readInputID = (sessionID: Session.ID) =>
      ctx.session.context({ sessionID }).pipe(
        Effect.flatMap((messages) =>
          Effect.tryPromise({
            try: () => resolveNativeInputID(messages, () => retainedInputID(sessionID)),
            catch: (error) => error,
          }),
        ),
      )
    const idleStore = new NativeIdleStore(recorder.store.repository)
    const listenerID = crypto.randomUUID()
    let observing = true
    const observedExecutionStarts = new Map<
      string,
      { binding: NativeIdleBinding; sequence: number }
    >()
    const startsRequiringNewerObservation = new Map<string, number>()
    const requireNewerStart = (sessionID: string, afterSequence: number) => {
      startsRequiringNewerObservation.set(
        sessionID,
        Math.max(startsRequiringNewerObservation.get(sessionID) ?? -1, afterSequence),
      )
    }
    const invalidateListenerStarts = () => {
      observedExecutionStarts.clear()
      for (const assignment of recorder.assignments()) {
        const binding = bindingFor(assignment.sessionID)
        let lastEventSequence: number
        try {
          lastEventSequence = binding
            ? (idleStore.read(binding)?.lastEventSequence ?? -1)
            : Number.MAX_SAFE_INTEGER
        } catch {
          lastEventSequence = Number.MAX_SAFE_INTEGER
        }
        requireNewerStart(assignment.sessionID, lastEventSequence)
      }
    }
    const projectDirectory = recorder.store.repository.projectDirectory
    const bindingFor = (sessionID: string) =>
      idleBinding(recorder.assignmentForSession(sessionID), projectDirectory)
    const trace = (
      sessionID: string,
      phase: string,
      details: Partial<Parameters<ProgressRecorder["recordNativeObservation"]>[0]> = {},
    ) => {
      try {
        recorder.recordNativeObservation({
          ...details,
          sessionID,
          listenerID,
          directory: ctx.location?.directory ?? projectDirectory,
          phase,
        })
      } catch {
        // Diagnostic storage cannot change the native observation or worker execution.
      }
    }
    yield* Effect.addFinalizer(() => Effect.sync(() => (observing = false)))
    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "lz-report-progress",
        description:
          "Record a concise progress note or handoff for this assigned worker attempt. Commentary is an annotation only: it cannot verify, accept, schedule, or change task state. Identity is resolved from the current native worker session.",
        input: z.toJSONSchema(ProgressInput, { io: "input" }),
        output: z.toJSONSchema(z.record(z.string(), z.unknown()), { io: "output" }),
        options: {
          codemode: true,
          permission: "lz-report-progress",
        },
        execute: (input, call) =>
          ctx.permission
            .assert({
              sessionID: call.sessionID,
              agent: call.agent,
              action: "lz-report-progress",
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

    const readNativeSession = (sessionID: string) =>
      Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(sessionID) }))
    const matchesBinding = (session: Session.Info, binding: NativeIdleBinding) =>
      session.id === binding.sessionID &&
      session.projectID === binding.projectID &&
      session.agent === "lazers-implementor" &&
      session.location.directory === binding.workspace &&
      session.metadata?.lazersAttemptID === binding.attemptID

    const observeIdleHook = async (idle: NativeIdleHook) => {
      const sessionID = idle.sessionID
      if (!observing) return
      const binding = bindingFor(sessionID)
      if (!binding) {
        trace(sessionID, "idle-unassigned", { backgroundCount: idle.background.length })
        return
      }
      const remindIfEmpty = async () => {
        if (idle.background.length === 0 && observing)
          await Effect.runPromise(reminderEffect(ctx, recorder, sessionID, 0))
      }
      const initial = idleStore.read(binding)
      if (initial?.pendingTerminal || initial?.terminal) {
        trace(sessionID, "idle-after-terminal", {
          eventSequence: initial.lastEventSequence ?? undefined,
        })
        return
      }
      const expectedRevision = initial?.revision ?? 0
      trace(sessionID, "idle-entered", {
        executionStartSequence: initial?.executionStartSequence ?? undefined,
        eventSequence: initial?.lastEventSequence ?? undefined,
        backgroundCount: idle.background.length,
      })
      try {
        const before = await readNativeSession(sessionID)
        const inputID = await Effect.runPromise(readInputID(Session.ID.make(sessionID)))
        const after = await readNativeSession(sessionID)
        const latest = idleStore.read(binding)
        if (
          !observing ||
          !sameIdleBinding(binding, bindingFor(sessionID)) ||
          (latest?.revision ?? 0) !== expectedRevision
        ) {
          trace(sessionID, "idle-stale", {
            inputID,
            eventSequence: latest?.lastEventSequence ?? undefined,
          })
          return
        }
        if (!matchesBinding(before, binding) || !matchesBinding(after, binding)) {
          idleStore.invalidate(
            binding,
            "Experimental idle hook did not match the assigned native session identity",
            expectedRevision,
          )
          return
        }
        const executionStartSequence = latest?.executionStartSequence
        const eventSequence = latest?.lastEventSequence
        const observedStart = observedExecutionStarts.get(sessionID)
        if (
          executionStartSequence === null ||
          executionStartSequence === undefined ||
          observedStart?.sequence !== executionStartSequence ||
          !sameIdleBinding(observedStart.binding, binding)
        ) {
          trace(sessionID, "idle-lineage-unavailable", {
            inputID,
            executionStartSequence: executionStartSequence ?? undefined,
            eventSequence: eventSequence ?? undefined,
          })
          await remindIfEmpty()
          return
        }
        if (
          !inputID ||
          executionStartSequence === null ||
          executionStartSequence === undefined ||
          eventSequence === null ||
          eventSequence === undefined
        ) {
          idleStore.invalidate(
            binding,
            "Experimental idle report could not be tied to the current execution and input",
            expectedRevision,
          )
          await remindIfEmpty()
          return
        }
        const kinds = { shell: 0, subagent: 0, image: 0 }
        for (const work of idle.background) kinds[work.kind]++
        const recorded = idleStore.recordIdle(
          binding,
          {
            observedAt: Date.now(),
            inputID,
            executionStartSequence,
            eventSequence,
            count: idle.background.length,
            kinds,
          },
          expectedRevision,
        )
        trace(sessionID, recorded ? "idle-report" : "idle-stale", {
          inputID,
          executionStartSequence,
          eventSequence,
          backgroundCount: idle.background.length,
        })
        const current = idleStore.read(binding)
        const sameExecutionReport =
          !recorded &&
          current !== undefined &&
          current.pendingTerminal === null &&
          current.terminal === null &&
          current?.executionStartSequence === executionStartSequence &&
          current.report?.executionStartSequence === executionStartSequence &&
          current.report.eventSequence === eventSequence &&
          current.report.inputID === inputID
        if (recorded || sameExecutionReport) await remindIfEmpty()
      } catch (error) {
        trace(sessionID, "idle-observation-failed", { error })
        try {
          idleStore.invalidate(
            binding,
            "Native idle persistence or lineage read failed",
            expectedRevision,
          )
        } catch {
          // A failed durable write remains unknown when cleanup reopens the store.
        }
        await remindIfEmpty()
      }
    }
    yield* ctx.session.hook("experimental.idle", (idle) =>
      Effect.tryPromise({
        try: () => observeIdleHook(idle),
        catch: (error) => new Error(safeError(error, privacyStats())),
      }).pipe(Effect.catch(() => Effect.void)),
    )

    const reconstruction = registerProgressReconstruction({
      databasePath: recorder.store.repository.path,
      projectDirectory: recorder.store.repository.projectDirectory,
      projectID,
      location: ctx.location?.directory ?? projectDirectory,
      participant: {
        assignments: () => recorder.assignments(),
        assignmentForSession: (sessionID) => recorder.assignmentForSession(sessionID),
        reconstruct: (assignment, isCurrent, readStarted) =>
          reconstructSession(ctx, recorder, assignment, isCurrent, readStarted),
      },
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => reconstruction.dispose()))

    const observeExecutionSuccess = async (
      binding: NativeIdleBinding,
      terminal: NativeIdleTerminal,
      expectedRevision: number,
    ) => {
      const state = idleStore.read(binding)
      if (
        !state ||
        state.revision !== expectedRevision ||
        state.pendingTerminal?.sequence !== terminal.sequence
      )
        return
      const before = await readNativeSession(binding.sessionID)
      const messages = await Effect.runPromise(
        ctx.session.context({ sessionID: Session.ID.make(binding.sessionID) }),
      )
      const inputID = await resolveNativeInputID(messages, () => retainedInputID(binding.sessionID))
      const after = await readNativeSession(binding.sessionID)
      const exact =
        observing &&
        sameIdleBinding(binding, bindingFor(binding.sessionID)) &&
        matchesBinding(before, binding) &&
        matchesBinding(after, binding) &&
        after.outcome === "succeeded" &&
        hasExactSuccessfulIdleMarker(messages, terminal) &&
        inputID === state.report?.inputID
      if (exact && idleStore.confirmSuccess(binding, inputID, terminal, expectedRevision)) {
        trace(binding.sessionID, "execution-success-confirmed", {
          eventSequence: terminal.sequence,
          inputID,
        })
        return
      }
      idleStore.invalidate(
        binding,
        "Native execution success could not confirm the current idle input lineage and terminal marker",
        expectedRevision,
        terminal.sequence,
      )
    }

    const observeNativeEvent = async (event: unknown) => {
      const rawType = object(event)?.type
      const rawSessionID = object(object(event)?.data)?.sessionID
      const type = typeof rawType === "string" ? rawType : undefined
      const sessionID = typeof rawSessionID === "string" ? rawSessionID : undefined
      if (sessionID) reconstruction.changed(sessionID)
      if (
        observing &&
        type &&
        sessionID &&
        (BACKGROUND_INVALIDATING_EVENTS.has(type) || type === "session.execution.succeeded")
      ) {
        const binding = bindingFor(sessionID)
        if (binding) {
          const sequence = eventSequence(event, sessionID)
          const rawEventID = object(event)?.id
          const eventID = typeof rawEventID === "string" ? rawEventID : undefined
          let terminalMessageID: string | undefined
          if (type === "session.execution.succeeded" && eventID) {
            try {
              terminalMessageID = SessionMessage.ID.fromEvent(eventID)
            } catch {
              terminalMessageID = undefined
            }
          }
          try {
            const result = idleStore.observeEvent(
              binding,
              type,
              sequence,
              eventID,
              terminalMessageID,
            )
            const current = idleStore.read(binding)
            trace(sessionID, `event-${result.status}`, {
              eventSequence: sequence,
              executionStartSequence: current?.executionStartSequence ?? undefined,
            })
            if (type === "session.execution.started" && sequence !== undefined) {
              if (result.status === "changed" || result.status === "seen") {
                if (
                  current?.lastEventSequence === sequence &&
                  current.executionStartSequence === sequence &&
                  sameIdleBinding(current.binding, binding) &&
                  sequence > (startsRequiringNewerObservation.get(sessionID) ?? -1)
                ) {
                  observedExecutionStarts.set(sessionID, { binding, sequence })
                  startsRequiringNewerObservation.delete(sessionID)
                }
              }
            } else if (
              sequence === undefined ||
              type === "session.execution.failed" ||
              type === "session.execution.interrupted"
            ) {
              observedExecutionStarts.delete(sessionID)
            }
            if (type === "session.execution.succeeded" && sequence !== undefined) {
              const pending = current?.pendingTerminal
              if (
                current &&
                pending &&
                pending.sequence === sequence &&
                current.lastEventSequence === sequence
              )
                await observeExecutionSuccess(binding, pending, current.revision)
            }
            if (result.status === "changed" && sequence === undefined)
              trace(sessionID, "event-order-unknown")
          } catch (error) {
            observedExecutionStarts.delete(sessionID)
            requireNewerStart(sessionID, sequence ?? Number.MAX_SAFE_INTEGER)
            throw error
          }
        }
      }
      try {
        recorder.recordNativeEvent(event)
      } catch {
        // A later retained-session reconciliation can recover public event facts.
      }
    }

    const listen = Effect.forever(
      Stream.runForEach(ctx.event.subscribe({ types: NATIVE_EVENT_TYPES }), (event) =>
        Effect.tryPromise({
          try: () => observeNativeEvent(event),
          catch: (error) => new Error(safeError(error, privacyStats())),
        }).pipe(Effect.catch(() => Effect.void)),
      ).pipe(
        Effect.match({
          onFailure: (error) => {
            trace("unknown", "stream-failed", { error })
            invalidateListenerStarts()
            for (const assignment of recorder.assignments()) {
              recorder.markRecoveryGap(
                assignment.sessionID,
                "Native event stream disconnected; retained public session facts are reconciled at startup.",
                "event-stream",
              )
            }
          },
          onSuccess: () => {
            trace("unknown", "stream-ended")
            invalidateListenerStarts()
            for (const assignment of recorder.assignments()) {
              recorder.markRecoveryGap(
                assignment.sessionID,
                "Native event stream ended; retained public session facts are reconciled at startup.",
                "event-stream",
              )
            }
          },
        }),
        Effect.andThen(Effect.sleep(1_000)),
      ),
    )
    yield* Effect.forkScoped(listen)
  })
}
