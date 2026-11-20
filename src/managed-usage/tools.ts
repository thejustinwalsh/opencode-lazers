import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { z } from "zod"
import { isWorkerAgent } from "../runner/worker-agent.ts"
import type { ManagedUsagePriceProvider } from "../models/managed-usage-valuation.ts"
import { privacyStats, safeError } from "../trajectory/privacy.ts"
import { ManagedUsageEnrollmentInputSchema, ManagedUsageReadInputSchema } from "./contract.ts"
import { ManagedUsageReportSchema, readManagedUsageReport } from "./report.ts"
import { ManagedUsageCapture } from "./native.ts"
import type { ManagedUsageStore } from "./store.ts"

type ManagedUsageToolContext = Pick<Plugin.Context, "location" | "permission" | "session" | "tool">

const UNAVAILABLE = "Managed usage scope is unavailable"

async function readSession(ctx: ManagedUsageToolContext, sessionID: string, signal: AbortSignal) {
  return Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(sessionID) }), { signal })
}

async function authorizeArchitectCaller(
  ctx: ManagedUsageToolContext,
  call: { sessionID: string; agent: string },
  projectID: string,
  store: ManagedUsageStore,
  signal: AbortSignal,
) {
  if (call.agent !== "architect") throw new Error(UNAVAILABLE)
  signal.throwIfAborted()
  const caller = await readSession(ctx, String(call.sessionID), signal)
  if (
    String(caller.id) !== String(call.sessionID) ||
    caller.projectID !== projectID ||
    caller.agent !== "architect" ||
    caller.time.archived !== undefined ||
    isWorkerAgent(caller.agent) ||
    store.isWorkerSession(String(caller.id))
  )
    throw new Error(UNAVAILABLE)
  return caller
}

function managedTargetAllowed(
  target: Awaited<ReturnType<typeof readSession>>,
  targetID: string,
  projectID: string,
  store: ManagedUsageStore,
): target is Awaited<ReturnType<typeof readSession>> & { agent: string } {
  return (
    String(target.id) === targetID &&
    target.projectID === projectID &&
    target.time.archived === undefined &&
    typeof target.agent === "string" &&
    target.agent.length > 0 &&
    !isWorkerAgent(target.agent) &&
    !store.isWorkerSession(targetID)
  )
}

async function authorizeManagedTarget(
  ctx: ManagedUsageToolContext,
  caller: Awaited<ReturnType<typeof readSession>>,
  targetID: string,
  projectID: string,
  store: ManagedUsageStore,
  signal: AbortSignal,
): Promise<{ agent: string; busy: boolean }> {
  const target = await readSession(ctx, targetID, signal)
  if (!managedTargetAllowed(target, targetID, projectID, store)) throw new Error(UNAVAILABLE)

  if (
    String(caller.id) !== targetID &&
    !(await hasArchitectLineage(ctx, target, caller, projectID, store, signal))
  )
    throw new Error(UNAVAILABLE)
  return { agent: target.agent, busy: target.time.busy !== undefined }
}

async function lineageParent(
  ctx: ManagedUsageToolContext,
  parentID: string,
  projectID: string,
  store: ManagedUsageStore,
  signal: AbortSignal,
) {
  const parent = await readSession(ctx, parentID, signal)
  const valid =
    String(parent.id) === parentID &&
    parent.projectID === projectID &&
    !isWorkerAgent(parent.agent) &&
    !store.isWorkerSession(parentID)
  if (!valid) throw new Error(UNAVAILABLE)
  return parent
}

async function hasArchitectLineage(
  ctx: ManagedUsageToolContext,
  target: Awaited<ReturnType<typeof readSession>>,
  caller: Awaited<ReturnType<typeof readSession>>,
  projectID: string,
  store: ManagedUsageStore,
  signal: AbortSignal,
) {
  const callerID = String(caller.id)
  const visited = new Set([String(target.id)])
  let parentID = target.parentID ? String(target.parentID) : undefined
  while (parentID) {
    if (visited.has(parentID) || visited.size >= 33) throw new Error(UNAVAILABLE)
    visited.add(parentID)
    const parent = await lineageParent(ctx, parentID, projectID, store, signal)
    if (parentID === callerID) return true
    parentID = parent.parentID ? String(parent.parentID) : undefined
  }
  return false
}

type EnrollmentCall = { sessionID: string; agent: string; messageID: string }
type EnrollmentAuthority = {
  caller: Awaited<ReturnType<typeof readSession>>
  target: { agent: string; busy: boolean }
}

async function authorizeEnrollment(
  ctx: ManagedUsageToolContext,
  store: ManagedUsageStore,
  projectID: string,
  request: z.infer<typeof ManagedUsageEnrollmentInputSchema>,
  call: EnrollmentCall,
  signal: AbortSignal,
): Promise<EnrollmentAuthority> {
  const caller = await authorizeArchitectCaller(ctx, call, projectID, store, signal)
  const target = await authorizeManagedTarget(
    ctx,
    caller,
    request.sessionID,
    projectID,
    store,
    signal,
  )
  if (String(caller.id) !== request.sessionID && target.busy) throw new Error(UNAVAILABLE)
  return { caller, target }
}

function stableEnrollmentAuthority(
  initial: EnrollmentAuthority,
  current: EnrollmentAuthority,
  request: z.infer<typeof ManagedUsageEnrollmentInputSchema>,
) {
  const sameCaller = String(current.caller.id) === String(initial.caller.id)
  const sameAgent = current.target.agent === initial.target.agent
  const targetIsIdle = String(current.caller.id) === request.sessionID || !current.target.busy
  if (!sameCaller || !sameAgent || !targetIsIdle) throw new Error(UNAVAILABLE)
}

function existingEnrollmentResult(
  store: ManagedUsageStore,
  request: z.infer<typeof ManagedUsageEnrollmentInputSchema>,
) {
  const retry = store.findEnrollmentRequest(request.requestID, request)
  if (retry) return retry
  const currentRevision = store.sessionRevision(request.sessionID)
  if (request.expectedRevision === currentRevision) return null
  return {
    status: "conflict" as const,
    reason: "stale-revision" as const,
    expectedRevision: request.expectedRevision,
    currentRevision,
  }
}

async function commitEnrollment(input: {
  ctx: ManagedUsageToolContext
  store: ManagedUsageStore
  capture: ManagedUsageCapture
  projectID: string
  request: z.infer<typeof ManagedUsageEnrollmentInputSchema>
  call: EnrollmentCall
  initial: EnrollmentAuthority
  signal: AbortSignal
}) {
  const { ctx, store, capture, projectID, request, call, initial, signal } = input
  const pending = capture.beginEnrollment(request.sessionID)
  let boundarySequence = capture.boundarySequence(request.sessionID)
  try {
    const current = await authorizeEnrollment(ctx, store, projectID, request, call, signal)
    stableEnrollmentAuthority(initial, current, request)
    signal.throwIfAborted()
    boundarySequence = capture.boundarySequence(request.sessionID)
    const result = store.enroll({
      request,
      agent: initial.target.agent,
      boundarySequence,
      excludedAssistantMessageID:
        String(current.caller.id) === request.sessionID ? call.messageID : null,
    })
    const committed = result.status === "enrolled"
    pending.finish(committed ? result.boundarySequence : boundarySequence, committed)
    return result
  } finally {
    pending.finish(boundarySequence, false)
  }
}

async function executeManagedUsageEnrollment(input: {
  ctx: ManagedUsageToolContext
  store: ManagedUsageStore
  capture: ManagedUsageCapture
  projectID: string
  projectDirectory: string
  raw: unknown
  call: EnrollmentCall
  signal: AbortSignal
}) {
  const request = ManagedUsageEnrollmentInputSchema.parse(input.raw)
  assertProject(request, input.ctx)
  const initial = await authorizeEnrollment(
    input.ctx,
    input.store,
    input.projectID,
    request,
    input.call,
    input.signal,
  )
  input.signal.throwIfAborted()
  const existing = existingEnrollmentResult(input.store, request)
  if (existing) return { content: JSON.stringify(existing), output: existing }
  input.store.validateAssociation(request.association)
  const result = await commitEnrollment({ ...input, request, initial })
  return { content: JSON.stringify(result), output: result }
}

function validateReadScope(
  store: ManagedUsageStore,
  scope: { kind: string; planID?: string; taskID?: string },
) {
  if (scope.kind === "plan" && scope.planID)
    store.validateAssociation({ kind: "plan", planID: scope.planID })
  if (scope.kind === "task" && scope.planID && scope.taskID)
    store.validateAssociation({ kind: "task", planID: scope.planID, taskID: scope.taskID })
}

function assertProject(
  input: { projectID: string; projectDirectory: string },
  ctx: ManagedUsageToolContext,
) {
  if (
    input.projectID !== ctx.location.project.id ||
    input.projectDirectory !== ctx.location.project.canonical
  )
    throw new Error(UNAVAILABLE)
}

export function registerManagedUsageTools(input: {
  ctx: ManagedUsageToolContext
  store: ManagedUsageStore
  capture: ManagedUsageCapture
  projectID: string
  projectDirectory: string
  priceProvider: ManagedUsagePriceProvider
}) {
  const cursorSecret = crypto.getRandomValues(new Uint8Array(32))
  return input.ctx.tool.transform((editor) => {
    editor.add({
      name: "lz-enroll-managed-usage",
      description:
        "Enroll a same-project Architect-managed session at a durable future-generation boundary and freeze its task, plan, or unallocated association. Exact retries are idempotent; use the returned revision for a later scope change.",
      input: z.toJSONSchema(ManagedUsageEnrollmentInputSchema, { io: "input" }),
      output: z.toJSONSchema(z.record(z.string(), z.unknown()), { io: "output" }),
      options: {
        codemode: true,
        pinned: true,
        permission: "lz-enroll-managed-usage",
      },
      execute: (raw, call) =>
        input.ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-enroll-managed-usage",
            resources: [input.projectDirectory],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: (signal) =>
                  executeManagedUsageEnrollment({
                    ...input,
                    raw,
                    call: {
                      sessionID: String(call.sessionID),
                      agent: String(call.agent),
                      messageID: String(call.messageID),
                    },
                    signal,
                  }),
                catch: (error) => new Tool.Error({ message: safeError(error, privacyStats()) }),
              }),
            ),
          ),
    })

    editor.add({
      name: "lz-read-managed-usage",
      description:
        "Read a deduplicated, privacy-safe managed-session generation report with immutable task/plan attribution, current cached market quotes, explicit unallocated usage and partial capture coverage. Continue pages only with the returned cursor and unchanged scope and limit.",
      input: z.toJSONSchema(ManagedUsageReadInputSchema, { io: "input" }),
      output: z.toJSONSchema(ManagedUsageReportSchema, { io: "output" }),
      options: {
        codemode: true,
        pinned: true,
        permission: "lz-read-managed-usage",
      },
      execute: (raw, call) =>
        input.ctx.permission
          .assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: "lz-read-managed-usage",
            resources: [input.projectDirectory],
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async (signal) => {
                  const request = ManagedUsageReadInputSchema.parse(raw)
                  assertProject(request.scope, input.ctx)
                  const caller = await authorizeArchitectCaller(
                    input.ctx,
                    { sessionID: String(call.sessionID), agent: String(call.agent) },
                    input.projectID,
                    input.store,
                    signal,
                  )
                  validateReadScope(input.store, request.scope)
                  const report = await readManagedUsageReport({
                    store: input.store,
                    priceProvider: input.priceProvider,
                    request,
                    cursorSecret,
                    signal,
                  })
                  signal.throwIfAborted()
                  const currentCaller = await authorizeArchitectCaller(
                    input.ctx,
                    { sessionID: String(call.sessionID), agent: String(call.agent) },
                    input.projectID,
                    input.store,
                    signal,
                  )
                  if (String(currentCaller.id) !== String(caller.id)) throw new Error(UNAVAILABLE)
                  validateReadScope(input.store, request.scope)
                  signal.throwIfAborted()
                  return { content: JSON.stringify(report), output: report }
                },
                catch: (error) => new Tool.Error({ message: safeError(error, privacyStats()) }),
              }),
            ),
          ),
    })
  })
}
