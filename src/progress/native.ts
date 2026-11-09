import { isWorkerAgent } from "../runner/worker-agent.ts"
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

type ObservedExecutionStart = {
  binding: NativeIdleBinding
  sequence: number
  source: "live" | "native-log-replay" | "live-peer" | "current-idle"
  current?: () => boolean
}
type LiveStartObserver = (
  binding: NativeIdleBinding,
  sequence: number,
) => { current(): boolean } | undefined

// Local plugin imports are replaced independently for each loaded location.
// Keep only live listener registrations here; no start survives their retirement.
const liveStartsKey = Symbol.for("opencode-lazers.live-native-start-observers.v1")
const liveStartsHost = globalThis as typeof globalThis & {
  [liveStartsKey]?: Map<string, Map<string, LiveStartObserver>>
}
const liveStartObservers: Map<string, Map<string, LiveStartObserver>> = (liveStartsHost[
  liveStartsKey
] ??= new Map())

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
type NativeSessionLogReader = (
  sessionID: string,
) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>
type NativeReplayedStart = { sequence: number; lastObservedEventSequence: number }

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

async function replayCurrentExecutionStart(
  readSessionLog: NativeSessionLogReader,
  sessionID: string,
): Promise<NativeReplayedStart | undefined> {
  let synced = false
  let watermark: number | undefined
  let lastSequence: number | undefined
  let lastObservedEventSequence: number | undefined
  let executionStartSequence: number | undefined

  try {
    const log = await readSessionLog(sessionID)
    for await (const raw of log) {
      const item = object(raw)
      if (item?.type === "log.synced") {
        if (synced || item.aggregateID !== sessionID) return undefined
        synced = true
        if (item.seq !== undefined) {
          if (typeof item.seq !== "number" || !Number.isSafeInteger(item.seq) || item.seq < 0)
            return undefined
          watermark = item.seq
        }
        continue
      }
      if (synced || !item || typeof item.type !== "string") return undefined
      const durable = object(item.durable)
      // Session.log filters a shared aggregate sequence; gaps are valid, reordering is not.
      if (
        durable?.aggregateID !== sessionID ||
        typeof durable.seq !== "number" ||
        !Number.isSafeInteger(durable.seq) ||
        durable.seq < 0 ||
        (lastSequence !== undefined && durable.seq <= lastSequence)
      )
        return undefined
      lastSequence = durable.seq

      const observedByIdleStore =
        BACKGROUND_INVALIDATING_EVENTS.has(item.type) || item.type === "session.execution.succeeded"
      if (observedByIdleStore) {
        if (object(item.data)?.sessionID !== sessionID) return undefined
        lastObservedEventSequence = durable.seq
      }
      if (item.type === "session.execution.started") {
        executionStartSequence = durable.seq
      } else if (item.type === "session.inbox.delivered") {
        // Delivery may occur inside an unfinished execution; later invalidations still clear it.
      } else if (
        BACKGROUND_INVALIDATING_EVENTS.has(item.type) ||
        item.type === "session.execution.succeeded" ||
        item.type === "session.execution.failed" ||
        item.type === "session.execution.interrupted"
      ) {
        executionStartSequence = undefined
      }
    }
  } catch {
    return undefined
  }

  if (
    !synced ||
    // The sync watermark also covers durable events omitted from this filtered log.
    (lastSequence !== undefined && (watermark === undefined || watermark < lastSequence))
  )
    return undefined
  return executionStartSequence === undefined || lastObservedEventSequence === undefined
    ? undefined
    : { sequence: executionStartSequence, lastObservedEventSequence }
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
        !isWorkerAgent(session.agent) ||
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
    !isWorkerAgent(session.agent) ||
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
  readSessionLog?: NativeSessionLogReader,
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
    const observedExecutionStarts = new Map<string, ObservedExecutionStart>()
    const startsRequiringNewerObservation = new Map<string, number | null>()
    const requireNewerStart = (sessionID: string, afterSequence: number | null) => {
      const current = startsRequiringNewerObservation.get(sessionID)
      startsRequiringNewerObservation.set(
        sessionID,
        current === null || afterSequence === null ? null : Math.max(current ?? -1, afterSequence),
      )
    }
    const refreshUnknownStartFences = () => {
      // A readable recovery watermark is only a stale-event cutoff, never local start lineage.
      for (const [sessionID, afterSequence] of startsRequiringNewerObservation) {
        if (afterSequence !== null) continue
        try {
          const binding = bindingFor(sessionID)
          if (!binding) continue
          startsRequiringNewerObservation.set(
            sessionID,
            idleStore.read(binding)?.lastEventSequence ?? -1,
          )
        } catch {
          // Keep the unknown fence until a later stream boundary has a readable row.
        }
      }
    }
    const invalidateListenerStarts = () => {
      observedExecutionStarts.clear()
      for (const assignment of recorder.assignments()) {
        const binding = bindingFor(assignment.sessionID)
        let lastEventSequence: number | null
        try {
          lastEventSequence = binding ? (idleStore.read(binding)?.lastEventSequence ?? -1) : null
        } catch {
          lastEventSequence = null
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
    const liveStartsScope = JSON.stringify([
      recorder.store.repository.path,
      projectDirectory,
      projectID,
    ])
    const livePeers =
      liveStartObservers.get(liveStartsScope) ?? new Map<string, LiveStartObserver>()
    liveStartObservers.set(liveStartsScope, livePeers)
    livePeers.set(listenerID, (binding, sequence) => {
      const start = observedExecutionStarts.get(binding.sessionID)
      const current = () =>
        observing &&
        start !== undefined &&
        start.source !== "live-peer" &&
        observedExecutionStarts.get(binding.sessionID) === start &&
        start.sequence === sequence &&
        sameIdleBinding(start.binding, binding) &&
        !startsRequiringNewerObservation.has(binding.sessionID)
      return current() ? { current } : undefined
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        observing = false
        livePeers.delete(listenerID)
        if (!livePeers.size && liveStartObservers.get(liveStartsScope) === livePeers)
          liveStartObservers.delete(liveStartsScope)
      }),
    )
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

    yield* ctx.tool.hook("execute.before", (call) =>
      Effect.sync(() => {
        try {
          recorder.recordToolTargets({
            tool: call.tool,
            sessionID: call.sessionID,
            agent: call.agent,
            messageID: call.messageID,
            callID: call.id,
            input: call.input,
          })
        } catch {
          // Target-only observation must not alter native tool permission or outcome.
        }
      }),
    )

    const readNativeSession = (sessionID: string) =>
      Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(sessionID) }))
    const matchesBinding = (session: Session.Info, binding: NativeIdleBinding) =>
      session.id === binding.sessionID &&
      session.projectID === binding.projectID &&
      isWorkerAgent(session.agent) &&
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
        let inputID = await Effect.runPromise(readInputID(Session.ID.make(sessionID)))
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
        let executionStartSequence = latest?.executionStartSequence
        let eventSequence = latest?.lastEventSequence
        let observedStart = observedExecutionStarts.get(sessionID)
        if (
          executionStartSequence !== null &&
          executionStartSequence !== undefined &&
          !startsRequiringNewerObservation.has(sessionID) &&
          (observedStart?.sequence !== executionStartSequence ||
            !sameIdleBinding(observedStart.binding, binding) ||
            observedStart.current?.() === false)
        ) {
          for (const [peerID, peer] of livePeers) {
            if (peerID === listenerID) continue
            const witness = peer(binding, executionStartSequence)
            if (!witness) continue
            observedStart = {
              binding,
              sequence: executionStartSequence,
              source: "live-peer",
              current: witness.current,
            }
            observedExecutionStarts.set(sessionID, observedStart)
            trace(sessionID, "idle-lineage-live-peer", {
              executionStartSequence,
              eventSequence: eventSequence ?? undefined,
            })
            break
          }
        }
        if (
          executionStartSequence === null ||
          executionStartSequence === undefined ||
          observedStart?.sequence !== executionStartSequence ||
          !sameIdleBinding(observedStart.binding, binding) ||
          observedStart.current?.() === false
        ) {
          if (readSessionLog) {
            const replayedStart = await replayCurrentExecutionStart(readSessionLog, sessionID)
            if (replayedStart !== undefined) {
              const replaySession = await readNativeSession(sessionID)
              const replayInputID = await Effect.runPromise(readInputID(Session.ID.make(sessionID)))
              const replayedState = idleStore.read(binding)
              const requiredAfterSequence = startsRequiringNewerObservation.get(sessionID)
              const replayedSequence = replayedStart.sequence
              if (
                observing &&
                sameIdleBinding(binding, bindingFor(sessionID)) &&
                (replayedState?.revision ?? 0) === expectedRevision &&
                replayedState?.executionStartSequence === replayedSequence &&
                replayedState.lastEventSequence === replayedStart.lastObservedEventSequence &&
                replayedState.pendingTerminal === null &&
                replayedState.terminal === null &&
                replayInputID === inputID &&
                matchesBinding(replaySession, binding) &&
                (requiredAfterSequence === undefined ||
                  (requiredAfterSequence !== null && replayedSequence > requiredAfterSequence))
              ) {
                inputID = replayInputID
                executionStartSequence = replayedSequence
                eventSequence = replayedState.lastEventSequence
                observedStart = { binding, sequence: replayedSequence, source: "native-log-replay" }
                observedExecutionStarts.set(sessionID, observedStart)
                trace(sessionID, "idle-lineage-replayed", {
                  inputID,
                  executionStartSequence: replayedSequence,
                  eventSequence,
                })
              }
            }
          }
        }
        if (
          executionStartSequence === null ||
          executionStartSequence === undefined ||
          observedStart?.sequence !== executionStartSequence ||
          !sameIdleBinding(observedStart.binding, binding) ||
          observedStart.current?.() === false
        ) {
          // A current idle callback may witness the exact durable lineage after
          // replacement; it cannot invent sequences or outlive assignment fences.
          const assignment = recorder.assignmentForSession(sessionID)
          const assignedBinding = idleBinding(assignment, projectDirectory)
          const plan = assignment ? recorder.store.plan(assignment.planID) : undefined
          const currentAssignment = () => {
            const current = recorder.assignmentForSession(sessionID)
            return Boolean(
              assignment &&
              current &&
              current.attemptState === "running" &&
              sameProgressAssignment(current, assignment) &&
              sameIdleBinding(idleBinding(current, projectDirectory), binding) &&
              ["running", "blocked"].includes(recorder.store.plan(current.planID)?.state ?? "") &&
              !recorder.store.repository.taskDisposition(current.taskID),
            )
          }
          const canUseCurrentIdle = Boolean(
            assignment &&
            assignment.attemptState === "running" &&
            ["running", "blocked"].includes(plan?.state ?? "") &&
            !recorder.store.repository.taskDisposition(assignment.taskID) &&
            sameIdleBinding(assignedBinding, binding) &&
            executionStartSequence !== null &&
            executionStartSequence !== undefined &&
            Number.isSafeInteger(executionStartSequence) &&
            executionStartSequence >= 0 &&
            eventSequence !== null &&
            eventSequence !== undefined &&
            Number.isSafeInteger(eventSequence) &&
            eventSequence >= executionStartSequence &&
            !startsRequiringNewerObservation.has(sessionID) &&
            inputID !== undefined &&
            recorder.matchesAssignedInput(
              assignment.attemptID,
              assignment.sessionID,
              assignment.assignedMessageID,
              inputID,
            ),
          )
          if (
            canUseCurrentIdle &&
            assignment &&
            executionStartSequence !== null &&
            executionStartSequence !== undefined &&
            eventSequence !== null &&
            eventSequence !== undefined
          ) {
            const currentStartSequence = executionStartSequence
            const currentEventSequence = eventSequence
            const currentBefore = await readNativeSession(sessionID)
            const currentInputID = await Effect.runPromise(readInputID(Session.ID.make(sessionID)))
            const currentAfter = await readNativeSession(sessionID)
            const currentState = idleStore.read(binding)
            if (
              observing &&
              currentAssignment() &&
              sameIdleBinding(binding, bindingFor(sessionID)) &&
              currentState !== undefined &&
              currentState.revision === expectedRevision &&
              currentState.executionStartSequence === currentStartSequence &&
              currentState.lastEventSequence === currentEventSequence &&
              currentState.pendingTerminal === null &&
              currentState.terminal === null &&
              currentInputID === inputID &&
              recorder.matchesAssignedInput(
                assignment.attemptID,
                assignment.sessionID,
                assignment.assignedMessageID,
                currentInputID,
              ) &&
              matchesBinding(currentBefore, binding) &&
              matchesBinding(currentAfter, binding)
            ) {
              const currentIdleStart: ObservedExecutionStart = {
                binding,
                sequence: currentStartSequence,
                source: "current-idle",
                current: () =>
                  observing &&
                  observedExecutionStarts.get(sessionID) === currentIdleStart &&
                  !startsRequiringNewerObservation.has(sessionID) &&
                  currentAssignment(),
              }
              observedStart = currentIdleStart
              observedExecutionStarts.set(sessionID, currentIdleStart)
              trace(sessionID, "idle-lineage-current-hook", {
                inputID,
                executionStartSequence: currentStartSequence,
                eventSequence: currentEventSequence,
              })
            }
          }
        }
        if (
          executionStartSequence === null ||
          executionStartSequence === undefined ||
          observedStart?.sequence !== executionStartSequence ||
          !sameIdleBinding(observedStart.binding, binding) ||
          observedStart.current?.() === false
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
        trace(
          sessionID,
          recorded
            ? observedStart.source === "native-log-replay"
              ? "idle-report-replayed-lineage"
              : "idle-report"
            : "idle-stale",
          {
            inputID,
            executionStartSequence,
            eventSequence,
            backgroundCount: idle.background.length,
          },
        )
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
      const observedStart = observedExecutionStarts.get(binding.sessionID)
      const requiredAfterSequence = startsRequiringNewerObservation.get(binding.sessionID)
      if (
        state.executionStartSequence === null ||
        state.executionStartSequence === undefined ||
        observedStart?.sequence !== state.executionStartSequence ||
        !sameIdleBinding(observedStart.binding, binding) ||
        observedStart.current?.() === false ||
        requiredAfterSequence === null ||
        (requiredAfterSequence !== undefined &&
          state.executionStartSequence <= requiredAfterSequence)
      )
        // Another listener may still own the exact live start needed to confirm this terminal.
        return
      const before = await readNativeSession(binding.sessionID)
      const messages = await Effect.runPromise(
        ctx.session.context({ sessionID: Session.ID.make(binding.sessionID) }),
      )
      const inputID = await resolveNativeInputID(messages, () => retainedInputID(binding.sessionID))
      const after = await readNativeSession(binding.sessionID)
      const exact =
        observing &&
        observedStart.current?.() !== false &&
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
            const requiredAfterSequence = startsRequiringNewerObservation.get(sessionID)
            if (
              requiredAfterSequence === null &&
              result.status === "changed" &&
              sequence !== undefined &&
              Number.isSafeInteger(sequence) &&
              sequence >= 0 &&
              current?.lastEventSequence === sequence
            ) {
              if (type === "session.execution.started") {
                // A newly advanced durable start proves it is beyond the unknown cutoff.
                startsRequiringNewerObservation.delete(sessionID)
              } else {
                // A finite event advances only the cutoff; it never creates local start lineage.
                startsRequiringNewerObservation.set(sessionID, sequence)
              }
            }
            trace(sessionID, `event-${result.status}`, {
              eventSequence: sequence,
              executionStartSequence: current?.executionStartSequence ?? undefined,
            })
            if (type === "session.execution.started" && sequence !== undefined) {
              const observedStart = observedExecutionStarts.get(sessionID)
              if (
                result.status === "stale" &&
                observedStart &&
                sameIdleBinding(observedStart.binding, binding) &&
                sequence > observedStart.sequence
              ) {
                observedExecutionStarts.delete(sessionID)
                requireNewerStart(sessionID, sequence)
              } else if (result.status === "changed" || result.status === "seen") {
                const requiredAfterSequence = startsRequiringNewerObservation.get(sessionID)
                if (
                  current?.lastEventSequence === sequence &&
                  current.executionStartSequence === sequence &&
                  sameIdleBinding(current.binding, binding) &&
                  (requiredAfterSequence === undefined ||
                    (requiredAfterSequence !== null && sequence > requiredAfterSequence))
                ) {
                  observedExecutionStarts.set(sessionID, { binding, sequence, source: "live" })
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
            requireNewerStart(sessionID, sequence ?? null)
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
      Effect.suspend(() => {
        refreshUnknownStartFences()
        return Stream.runForEach(ctx.event.subscribe({ types: NATIVE_EVENT_TYPES }), (event) =>
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
        )
      }),
    )
    yield* Effect.forkScoped(listen)
  })
}
