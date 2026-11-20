import { isWorkerAgent } from "../runner/worker-agent.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect, Stream } from "effect"
import { z } from "zod"
import { privacyStats, safeError } from "../trajectory/privacy.ts"
import { declareInput } from "../tool-input.ts"
import { ProgressInput } from "./schema.ts"
import { endObservedSession, toolObservationScope } from "./tool-observation.ts"
import { endStalenessSession } from "./stale-reminder.ts"
import { timedHooks, sectionAsync } from "../diagnostics/stall-probe.ts"
import { dateMillis, type ProgressAssignment, type ProgressRecorder } from "./recorder.ts"
import {
  progressReconstructionKey,
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
  "session.unarchived",
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

const HANDOFF_REMINDER =
  "Provide only any remaining concise handoff: changes, checks/artifact/commit, blockers, or judgment needed from the plan owner. Do not repeat recorded facts, claim acceptance, or alter task state."

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
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
      // An unchanged native stamp means the retained context is the one already reconciled:
      // reuse its recorded handoff verdict instead of reading the conversation again.
      const updated = dateMillis(session.time?.updated)
      const stamp = updated === undefined ? undefined : recorder.sessionStamp(assignment.attemptID)
      const handoff =
        stamp && updated !== undefined && updated <= stamp.updated
          ? stamp.handoff
          : hasVisibleHandoff(
              await Effect.runPromise(ctx.session.context({ sessionID: session.id })),
            )
      if (handoff) return
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

  // Boot and event-driven checks both land here: a session whose native `time.updated` has not
  // moved since its last complete reconstruction has nothing new to read or record.
  const updated = dateMillis(session.time?.updated)
  const stamp = updated === undefined ? undefined : recorder.sessionStamp(assignment.attemptID)
  if (stamp && updated !== undefined && updated <= stamp.updated) return "complete" as const

  recorder.recordSessionSnapshot(assignment.sessionID, session)
  recorder.recordSessionOutcome(assignment.sessionID, session)
  const finishContext = readStarted("context")
  try {
    const messages = await Effect.runPromise(ctx.session.context({ sessionID: session.id }))
    finishContext("succeeded")
    if (!assignmentIsCurrent()) return "stale" as const
    await recorder.reconcileMessagesAsync(assignment.sessionID, messages)
    if (!assignmentIsCurrent()) return "stale" as const
    if (updated !== undefined)
      recorder.recordSessionStamp(assignment, { updated, handoff: hasVisibleHandoff(messages) })
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

/** Events after which a session holds nothing worth caching. */
const SESSION_END_EVENTS = new Set([
  "session.deleted",
  "session.moved",
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

type HubMember = {
  id: symbol
  generationID: string
  recorder: ProgressRecorder
  reconstruction: { changed(sessionID: string): void }
  /** Cheap per-copy reactions: source invalidation, scheduler wake, ownership cache. */
  memberEvent(sessionID: string | undefined, type: string | undefined): void
  owns(sessionID: string): Promise<boolean>
  streamLost(reason: "failed" | "ended"): void
  /** The native event loop of this copy's host connection. */
  listen: Effect.Effect<void>
  fiber?: { interruptUnsafe(): void }
}

/** Identifies this loaded bundle; a newer bundle's member takes the subscription over. */
const nativeGenerationID = crypto.randomUUID()

type EventHub = { members: Map<symbol, HubMember>; leader?: symbol }

/**
 * One native event subscriber per project per process. Every plugin copy of a project joins
 * the same hub; one member (the newest to join) owns the subscription and each event is
 * recorded once, with cheap per-copy reactions fanned out to the other members. When the
 * leader leaves, another member starts its own loop.
 */
const hubsKey = Symbol.for("opencode-lazers.progress-event-hubs.v1")
const hubHost = globalThis as typeof globalThis & { [hubsKey]?: Map<string, EventHub> }
const hubs: Map<string, EventHub> = (hubHost[hubsKey] ??= new Map())

function lead(hub: EventHub, member: HubMember) {
  const previous = hub.leader ? hub.members.get(hub.leader) : undefined
  previous?.fiber?.interruptUnsafe()
  if (previous) previous.fiber = undefined
  hub.leader = member.id
  member.fiber = Effect.runFork(Effect.sleep(0).pipe(Effect.andThen(member.listen)))
}

function joinHub(key: string, member: HubMember): () => void {
  let hub = hubs.get(key)
  if (!hub) {
    hub = { members: new Map() }
    hubs.set(key, hub)
  }
  const joined = hub
  joined.members.set(member.id, member)
  const leader = joined.leader ? joined.members.get(joined.leader) : undefined
  if (!leader || leader.generationID !== member.generationID) lead(joined, member)
  return () => {
    member.fiber?.interruptUnsafe()
    member.fiber = undefined
    joined.members.delete(member.id)
    if (joined.leader === member.id) {
      joined.leader = undefined
      const next = [...joined.members.values()].at(-1)
      if (next) lead(joined, next)
    }
    if (joined.members.size === 0 && hubs.get(key) === joined) hubs.delete(key)
  }
}

async function dispatchNativeEvent(hub: EventHub, leader: HubMember, event: unknown) {
  const rawType = object(event)?.type
  const rawSessionID = object(object(event)?.data)?.sessionID
  const type = typeof rawType === "string" ? rawType : undefined
  const sessionID = typeof rawSessionID === "string" ? rawSessionID : undefined
  for (const member of [...hub.members.values()]) {
    try {
      member.memberEvent(sessionID, type)
    } catch {
      // One copy's reaction cannot stop the others or the recording.
    }
  }
  if (sessionID && type && SESSION_END_EVENTS.has(type)) {
    endObservedSession(sessionID)
    endStalenessSession(sessionID)
  }
  if (sessionID) leader.reconstruction.changed(sessionID)
  try {
    let toolSession = false
    if (sessionID && type?.startsWith("session.tool.")) {
      for (const member of [...hub.members.values()]) {
        if (await member.owns(sessionID)) {
          toolSession = true
          break
        }
      }
    }
    leader.recorder.recordNativeEvent(event, toolSession)
  } catch {
    // A later retained-session reconciliation can recover public event facts.
  }
}

export function registerProgress(
  ctx: ProgressContext,
  recorder: ProgressRecorder,
  projectID: string,
  sourceChanged?: (sessionID?: string) => void,
  workerIdle?: () => void,
) {
  return Effect.gen(function* () {
    const listenerID = crypto.randomUUID()
    let observing = true
    let sourceStreamGap = false
    const invalidateSources = () => {
      try {
        if (!sourceStreamGap) sourceChanged?.()
        sourceStreamGap = true
      } catch {
        // Retry source invalidation at the next boundary; progress ingestion remains independent.
      }
    }
    const projectDirectory = recorder.store.repository.projectDirectory
    const toolScope = toolObservationScope(
      ctx,
      projectID,
      ctx.location?.directory ?? projectDirectory,
    )
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
    // The first listener repairs activity missed while the plugin was offline.
    invalidateSources()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        observing = false
      }),
    )
    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "lz-report-progress",
        description:
          "Record a concise progress note or handoff for this assigned worker attempt. Commentary is an annotation only: it cannot verify, accept, schedule, or change task state. Identity is resolved from the current native worker session.",
        input: declareInput(ProgressInput),
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

    yield* timedHooks(ctx.tool, "tool").hook("execute.after", (call) =>
      Effect.promise(async () => {
        if (!(await toolScope.owns(call.sessionID))) return
        try {
          recorder.recordToolHook({
            tool: call.tool,
            sessionID: call.sessionID,
            agent: call.agent,
            messageID: call.messageID,
            callID: call.id,
            input: call.input,
            status: call.status,
            ...(call.status === "completed" ? { result: call.result } : { error: call.error }),
          })
        } catch {
          // A later retained-session reconciliation can recover public results.
        }
      }),
    )

    yield* timedHooks(ctx.tool, "tool").hook("execute.before", (call) =>
      Effect.promise(async () => {
        if (!(await toolScope.owns(call.sessionID))) return
        try {
          recorder.recordToolBefore({
            tool: call.tool,
            sessionID: call.sessionID,
            agent: call.agent,
            messageID: call.messageID,
            callID: call.id,
            input: call.input,
          })
        } catch {
          // Tool observation cannot reject a native call.
        }
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

    // The idle hook carries the host's current background list. It is a live
    // observation, never persisted: it triggers the handoff reminder and wakes
    // the scheduler, which then asks the host for the worker's current activity.
    yield* timedHooks(ctx.session, "session").hook("experimental.idle", (idle) =>
      Effect.tryPromise({
        try: async () => {
          if (!observing || !recorder.assignmentForSession(idle.sessionID)) return
          trace(idle.sessionID, "idle-hook", { backgroundCount: idle.background.length })
          try {
            if (idle.background.length === 0)
              await Effect.runPromise(reminderEffect(ctx, recorder, idle.sessionID, 0))
          } finally {
            workerIdle?.()
          }
        },
        catch: (error) => new Error(safeError(error, privacyStats())),
      }).pipe(Effect.catch(() => Effect.void)),
    )

    const hubKey = progressReconstructionKey(
      recorder.store.repository.path,
      recorder.store.repository.projectDirectory,
      projectID,
    )
    const reconstruction = registerProgressReconstruction({
      databasePath: recorder.store.repository.path,
      projectDirectory: recorder.store.repository.projectDirectory,
      projectID,
      location: ctx.location?.directory ?? projectDirectory,
      participant: {
        assignments: () => recorder.assignments(),
        assignmentForSession: (sessionID) => recorder.assignmentForSession(sessionID),
        mayOwn: (sessionID) => recorder.mayBeAssigned(sessionID),
        reconstruct: (assignment, isCurrent, readStarted) =>
          reconstructSession(ctx, recorder, assignment, isCurrent, readStarted),
      },
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => reconstruction.dispose()))

    const memberID = Symbol("progress-event-member")
    const gaps = (reason: string) => {
      for (const assignment of recorder.assignments()) {
        recorder.markRecoveryGap(
          assignment.sessionID,
          `Native event stream ${reason}; retained public session facts are reconciled at startup.`,
          "event-stream",
        )
      }
    }
    const listen: Effect.Effect<void> = Effect.forever(
      Effect.suspend(() => {
        return Stream.runForEach(ctx.event.subscribe({ types: NATIVE_EVENT_TYPES }), (event) =>
          Effect.tryPromise({
            try: () =>
              sectionAsync(`event:${event.type}`, () => {
                const hub = hubs.get(hubKey)
                const self = hub?.members.get(memberID)
                return hub && self ? dispatchNativeEvent(hub, self, event) : Promise.resolve()
              }),
            catch: (error) => new Error(safeError(error, privacyStats())),
          }).pipe(Effect.catch(() => Effect.void)),
        ).pipe(
          Effect.match({
            onFailure: (error) => {
              const hub = hubs.get(hubKey)
              for (const member of hub?.members.values() ?? []) member.streamLost("failed")
              trace("unknown", "stream-failed", { error })
              gaps("disconnected")
            },
            onSuccess: () => {
              const hub = hubs.get(hubKey)
              for (const member of hub?.members.values() ?? []) member.streamLost("ended")
              trace("unknown", "stream-ended")
              gaps("ended")
            },
          }),
          Effect.andThen(Effect.sleep(1_000)),
        )
      }),
    )
    const leave = joinHub(hubKey, {
      id: memberID,
      generationID: nativeGenerationID,
      recorder,
      reconstruction,
      listen,
      owns: (sessionID) => toolScope.owns(sessionID),
      memberEvent: (sessionID, type) => {
        if (sessionID && observing) {
          sourceStreamGap = false
          try {
            sourceChanged?.(sessionID)
          } catch {
            // A later source event or prompt retries without dropping worker facts.
          }
        }
        if (sessionID && (type === "session.deleted" || type === "session.moved"))
          toolScope.forget(sessionID)
        if (
          observing &&
          sessionID &&
          (type === "session.execution.succeeded" ||
            type === "session.execution.failed" ||
            type === "session.execution.interrupted" ||
            type === "session.shell.ended" ||
            type === "session.idle") &&
          recorder.assignmentForSession(sessionID)
        )
          workerIdle?.()
      },
      streamLost: () => {
        invalidateSources()
        toolScope.clear()
      },
    })
    yield* Effect.addFinalizer(() => Effect.sync(leave))
  })
}
