import {
  forgetHostMessages,
  latestMessages,
  newMessages,
  type HostMessageClient,
} from "../core/host-messages.ts"
import { joinNativeEvents } from "../core/event-hub.ts"
import { isWorkerAgent } from "../runner/worker-agent.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
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

/**
 * Fold messages, oldest first, into whether the newest reply is a visible handoff: an assistant
 * stop with text that no prompt, shell or tool work follows. The verdict depends only on the
 * last deciding message, so folding a re-delivered tail again gives the same answer and a
 * caller can carry `visible` from the previous read instead of rereading the conversation.
 */
function foldVisibleHandoff(visible: boolean, messages: readonly unknown[]): boolean {
  for (const raw of messages) {
    const message = object(raw)
    if (
      message?.type === "user" ||
      message?.type === "synthetic" ||
      message?.type === "tool" ||
      message?.type === "shell"
    )
      visible = false
    else if (message?.type === "assistant" && Array.isArray(message.content)) {
      visible =
        !message.content.some((part) => object(part)?.type === "tool") &&
        message.finish === "stop" &&
        message.content.some((part) => {
          const item = object(part)
          return (
            item?.type === "text" && typeof item.text === "string" && item.text.trim().length > 0
          )
        })
    }
  }
  return visible
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
  messages: HostMessageClient,
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
      // An unchanged native stamp means the conversation is the one already reconciled: reuse
      // its recorded handoff verdict. Otherwise fold the newest page onto the recorded verdict;
      // the verdict depends on the last deciding message, so one page is enough.
      const updated = dateMillis(session.time?.updated)
      const stamp = updated === undefined ? undefined : recorder.sessionStamp(assignment.attemptID)
      const handoff =
        stamp && updated !== undefined && updated <= stamp.updated
          ? stamp.handoff
          : foldVisibleHandoff(stamp?.handoff ?? false, await latestMessages(messages, session.id))
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
  messages: HostMessageClient,
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
  // The read kind is named "context" for the diagnostics counters; it is one cursor pass.
  const finishContext = readStarted("context")
  try {
    // The cursor mirror resumes from the last page it delivered. A session whose stamp moved
    // reads only the new tail; the verdict folds onto the one recorded at the last stamp. With
    // no stamp the cursor may be ahead of what was recorded, so start the pass over.
    const repository = recorder.store.repository
    if (!stamp) forgetHostMessages(repository, assignment.sessionID)
    let handoff = stamp?.handoff ?? false
    let held: readonly unknown[] | undefined
    for await (const page of newMessages(repository, messages, assignment.sessionID)) {
      if (!assignmentIsCurrent()) {
        finishContext("succeeded")
        return "stale" as const
      }
      // One page is held back so the last one is reconciled as the end of history.
      if (held) await recorder.reconcileMessagesAsync(assignment.sessionID, held, { final: false })
      handoff = foldVisibleHandoff(handoff, page)
      held = page
    }
    finishContext("succeeded")
    if (!assignmentIsCurrent()) return "stale" as const
    await recorder.reconcileMessagesAsync(assignment.sessionID, held ?? [], { final: true })
    if (!assignmentIsCurrent()) return "stale" as const
    if (updated !== undefined) recorder.recordSessionStamp(assignment, { updated, handoff })
    return "complete" as const
  } catch (error) {
    finishContext("failed")
    if (!assignmentIsCurrent()) return "stale" as const
    recorder.markRecoveryGap(
      assignment.sessionID,
      `Retained public session messages are unavailable: ${safeError(error, privacyStats())}`,
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
  /**
   * Only a bundle older than the shared subscription design sets this: its leader's own
   * subscription loop, which a newer bundle's member interrupts when it takes over.
   */
  fiber?: { interruptUnsafe(): void }
  /** Leaves the shared event hub (this copy's own subscription). */
  leaveEvents?: () => void
}

/** Identifies this loaded bundle; a newer bundle's member takes the recording over. */
const nativeGenerationID = crypto.randomUUID()

type EventHub = {
  members: Map<symbol, HubMember>
  /** The one member that records and fans out; every member keeps its own subscription. */
  leader?: symbol
  /** Events are dispatched one at a time in arrival order, as one blocking stream did. */
  tail?: Promise<void>
}

/**
 * One recorder per project per process, fed by every copy's own subscription. Whether one
 * plugin copy's event stream carries every location's events is not proven (see
 * `core/event-hub.ts`), so a copy does not rely on a leader's stream: each member subscribes
 * for itself through the shared process hub, which de-duplicates events by id so each is
 * delivered once per process. One member (the newest generation to join) records each event
 * and fans cheap per-copy reactions out to the others; when it leaves, the next member takes
 * the role over without resubscribing, so nothing in between is missed.
 */
const hubsKey = Symbol.for("opencode-lazers.progress-event-hubs.v1")
const hubHost = globalThis as typeof globalThis & { [hubsKey]?: Map<string, EventHub> }
const hubs: Map<string, EventHub> = (hubHost[hubsKey] ??= new Map())

function lead(hub: EventHub, member: HubMember) {
  const previous = hub.leader ? hub.members.get(hub.leader) : undefined
  previous?.fiber?.interruptUnsafe()
  if (previous) previous.fiber = undefined
  hub.leader = member.id
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
    member.leaveEvents?.()
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
  sourceChanged: ((sessionID?: string, eventType?: string) => void) | undefined,
  workerIdle: (() => void) | undefined,
  messages: HostMessageClient,
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
              await Effect.runPromise(reminderEffect(ctx, messages, recorder, idle.sessionID, 0))
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
          reconstructSession(ctx, messages, recorder, assignment, isCurrent, readStarted),
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
    const onEvent = (event: unknown) => {
      const hub = hubs.get(hubKey)
      const self = hub?.members.get(memberID)
      // Every copy hears each event once per process; the recording member alone acts on it.
      if (!hub || !self || hub.leader !== memberID) return
      const type = object(event)?.type
      hub.tail = (hub.tail ?? Promise.resolve())
        .then(() =>
          sectionAsync(`event:${typeof type === "string" ? type : undefined}`, () =>
            dispatchNativeEvent(hub, self, event),
          ),
        )
        .catch(() => undefined)
    }
    const onGap = (reason: "failed" | "ended" | undefined) => {
      const hub = hubs.get(hubKey)
      // A lost stream is a gap for the whole project, handled once, by the recording member.
      if (!hub || hub.leader !== memberID) return
      const lost = reason ?? "failed"
      for (const member of hub.members.values()) member.streamLost(lost)
      trace("unknown", lost === "failed" ? "stream-failed" : "stream-ended")
      gaps(lost === "failed" ? "disconnected" : "ended")
    }
    const leave = joinHub(hubKey, {
      id: memberID,
      generationID: nativeGenerationID,
      recorder,
      reconstruction,
      leaveEvents: joinNativeEvents(
        ctx as never,
        NATIVE_EVENT_TYPES,
        { event: onEvent, gap: onGap },
        ctx.location?.directory,
      ),
      owns: (sessionID) => toolScope.owns(sessionID),
      memberEvent: (sessionID, type) => {
        if (sessionID && observing) {
          sourceStreamGap = false
          try {
            sourceChanged?.(sessionID, type)
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
