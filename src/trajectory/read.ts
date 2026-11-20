import { sameProject } from "../project-key.ts"
import { isTakeoverAttempt, openConcerns } from "../recovery/detector.ts"
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { DateTime } from "effect"
import type { TaskSpec } from "../task.ts"
import type {
  AttemptRow,
  EffectRow,
  NodeRow,
  PlanRow,
  ProgressRow,
  RunnerStore,
} from "../runner/store.ts"
import { PlanInput } from "../runner/schema.ts"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { InspectTrajectoryInput } from "./schema.ts"
import { TrajectoryIdentityError } from "./native.ts"
import { MAX_CONTEXT_MESSAGES, type TrajectoryHost, type TrajectorySession } from "./native.ts"
import { privateTagOmission, privacyStats, safeError, safeText, safeValue } from "./privacy.ts"
import type { PrivacyStats } from "./privacy.ts"
import { projectProgressFact } from "../progress/projection.ts"
import { projectTaskEffortBasis } from "./accounting.ts"
import type { AccountingRoute } from "./accounting.ts"
import { unavailableTaskValuation } from "../models/task-valuation.ts"
import type { TaskValuationProvider } from "../models/task-valuation.ts"
import type { TrajectoryMarketEquivalentCost } from "../models/task-valuation-schema.ts"
import type { ProjectTaskValuationRequest } from "../models/valuation.ts"

type TransitionRow = {
  id: number
  plan_id: string
  task_id: string | null
  version: number
  event: string
  payload: string
  created_at: number
}

type CheckView = {
  id: string
  scope: "attempt" | "plan"
  attemptID: string | null
  state: string
  result: "passed" | "failed" | "unknown"
  command: string | null
  startedAt: number | null
  endedAt: number | null
  timingBasis: string
  exitCode: number | null
  timedOut: boolean | null
  unchanged: boolean | null
  stdout: string | null
  stderr: string | null
  error: string | null
}

type PlanSnapshot = {
  row: PlanRow
  node: NodeRow
  input: PlanInput | null
  attempts: AttemptRow[]
  effects: EffectRow[]
  transitions: TransitionRow[]
}

const ACTIVE_ATTEMPTS = new Set(["preparing", "running", "verifying"])
const modelIdentities = new WeakMap<
  object,
  {
    providerID: string
    modelID: string
    variant: string | null
  }
>()

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function dateMillis(value: unknown): number | null {
  let millis: number
  if (typeof value === "number" && Number.isFinite(value)) millis = value
  else {
    if (value === null || value === undefined) return null
    try {
      millis = DateTime.toEpochMillis(value as DateTime.DateTime)
    } catch {
      return null
    }
  }
  const integer = Math.trunc(millis)
  return Number.isSafeInteger(integer) ? integer : null
}

const EPOCH_MILLIS = "unix-epoch-ms" as const

function contextTiming(
  endpoints: Record<string, { value: unknown; sourceType: string; meaning: string }>,
) {
  return {
    unit: EPOCH_MILLIS,
    endpoints: Object.fromEntries(
      Object.entries(endpoints).map(([key, endpoint]) => {
        const at = dateMillis(endpoint.value)
        return [
          key,
          {
            at,
            source: at === null ? null : "native-context",
            sourceType: at === null ? null : endpoint.sourceType,
            meaning: endpoint.meaning,
          },
        ]
      }),
    ),
  }
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    return object(JSON.parse(text))
  } catch {
    return null
  }
}

function modelView(value: unknown, stats: PrivacyStats) {
  const data = object(value)
  if (!data) return null
  const providerID = typeof data.providerID === "string" ? data.providerID : null
  const id = typeof data.id === "string" ? data.id : null
  if (!providerID || !id) return null
  const view = {
    providerID: safeText(providerID, stats, 120),
    id: safeText(id, stats, 120),
    ...(typeof data.variant === "string" ? { variant: safeText(data.variant, stats, 120) } : {}),
  }
  modelIdentities.set(view, {
    providerID,
    modelID: id,
    variant: typeof data.variant === "string" ? data.variant : null,
  })
  return view
}

function modelKey(model: ReturnType<typeof modelView>) {
  if (!model) return ""
  const identity = modelIdentities.get(model)
  return identity
    ? JSON.stringify([identity.providerID, identity.modelID, identity.variant])
    : JSON.stringify([model.providerID, model.id, model.variant ?? null])
}

function accountingRoute(model: ReturnType<typeof modelView>): AccountingRoute | null {
  if (!model) return null
  const identity = modelIdentities.get(model)
  return {
    providerID: model.providerID,
    modelID: model.id,
    variant: model.variant ?? null,
    identity: identity
      ? {
          providerID: identity.providerID,
          modelID: identity.modelID,
          variant: identity.variant,
        }
      : null,
  }
}

function sessionStepRoutes(session: TrajectorySession | null, stats: PrivacyStats) {
  if (!session?.messages) return []
  return session.messages.slice(0, MAX_CONTEXT_MESSAGES).flatMap((raw) => {
    const message = object(raw)
    if (message?.type !== "assistant") return []
    const model = accountingRoute(modelView(message.model, stats))
    const id = typeof message.id === "string" ? safeText(message.id, stats, 200) : null
    if (!model || !id) return []
    return [
      {
        messageID: id,
        route: model,
        observedAt: dateMillis(object(message.time)?.created),
      },
    ]
  })
}

function frozenPersona(policy: Record<string, unknown> | null) {
  const value = policy?.persona
  return value === "ui" || value === "systems" || value === "small-refactoring" ? value : null
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function safeErrorView(value: unknown, stats: PrivacyStats) {
  try {
    if (value instanceof Error) {
      const message = safeText(value.message, stats, 1000)
      return message ? { message } : null
    }
    const data = object(value)
    if (!data) return null
    const rawType = data.type
    const privateKind = privateTagOmission(rawType)
    if (privateKind === "reasoning") stats.omittedReasoning++
    else if (privateKind === "system") stats.omittedSystem++
    else if (privateKind === "attachment") stats.omittedAttachments++
    if (privateKind) return null
    const type = typeof rawType === "string" ? safeText(rawType, stats, 160) : null
    const message = typeof data.message === "string" ? safeText(data.message, stats, 1000) : null
    return type || message ? { ...(type ? { type } : {}), ...(message ? { message } : {}) } : null
  } catch {
    stats.omittedUnsupportedParts++
    return null
  }
}

function safeSpec(task: TaskSpec, stats: PrivacyStats) {
  const proposal = task.proposal
  return {
    objective: safeText(proposal.objective, stats),
    ...(proposal.guidance ? { guidance: safeText(proposal.guidance, stats) } : {}),
    exclusions: proposal.exclusions.map((value) => safeText(value, stats)),
    constraints: proposal.constraints.map((value) => safeText(value, stats)),
    assumptions: proposal.assumptions.map((value) => safeText(value, stats)),
    context: proposal.context.map((item) => ({
      reference: safeText(item.reference, stats),
      revision: item.revision === null ? null : safeText(item.revision, stats),
    })),
    writeScope: proposal.writeScope.map((value) => safeText(value, stats)),
    acceptance: safeAcceptance(proposal.acceptance, stats),
    requirements: {
      capabilities: proposal.requirements.capabilities.map((value) => safeText(value, stats)),
      skills: proposal.requirements.skills.map((value) => safeText(value, stats)),
      risk: proposal.requirements.risk,
      ...(proposal.requirements.policyReference !== undefined
        ? { policyReference: safeText(proposal.requirements.policyReference, stats) }
        : {}),
    },
    verification: proposal.verification.map((item) => ({
      id: safeText(item.id, stats, 120),
      command: safeText(item.command, stats),
      ...(item.timeoutMs === undefined ? {} : { timeoutMs: item.timeoutMs }),
      ...(item.inactivityTimeoutMs === undefined
        ? {}
        : { inactivityTimeoutMs: item.inactivityTimeoutMs }),
      ...(item.hardTimeoutMs === undefined ? {} : { hardTimeoutMs: item.hardTimeoutMs }),
    })),
  }
}

function safeToolContent(value: unknown, stats: PrivacyStats) {
  const output: string[] = []
  try {
    if (!Array.isArray(value)) return ""
    const length = value.length
    for (let index = 0; index < Math.min(length, 40); index++) {
      const entry = object(value[index])
      if (entry?.type === "text" && typeof entry.text === "string")
        output.push(safeText(entry.text, stats))
      else if (entry?.type === "file") stats.omittedAttachments++
      else stats.omittedUnsupportedParts++
    }
    if (length > 40) stats.truncated++
  } catch {
    stats.omittedUnsupportedParts++
    return ""
  }
  return safeText(output.join("\n"), stats)
}

type MessageContext = {
  stats: PrivacyStats
  base: (id: string, at: number | null, kind: string) => Record<string, unknown>
  add: (event: Record<string, unknown>) => void
}

type MessageSlice = {
  message: Record<string, unknown>
  messageID: string
  createdAt: number | null
}

const TOOL_STATUSES = ["streaming", "running", "completed", "error"]

function userMessageEvents(ctx: MessageContext, { message, messageID, createdAt }: MessageSlice) {
  if (typeof message.text === "string")
    ctx.add({
      ...ctx.base(`${messageID}:text`, createdAt, message.type as string),
      text: safeText(message.text, ctx.stats),
    })
  if (Array.isArray(message.files)) ctx.stats.omittedAttachments += message.files.length
}

function assistantStepStatus(message: Record<string, unknown>, createdAt: number | null) {
  const messageTime = object(message.time)
  if (message.error) return "failed"
  if (dateMillis(messageTime?.completed) !== null) return "ended"
  if (dateMillis(messageTime?.streamed) !== null) return "streamed"
  return createdAt !== null ? "started" : "unknown"
}

function assistantStepEvent(
  ctx: MessageContext,
  { message, messageID, createdAt }: MessageSlice,
  model: ReturnType<typeof modelView>,
) {
  const messageTime = object(message.time)
  const stepStatus = assistantStepStatus(message, createdAt)
  ctx.add({
    ...ctx.base(`${messageID}:assistant-step`, createdAt, "assistant-step"),
    model,
    status: stepStatus,
    timing: contextTiming({
      startedAt: {
        value: messageTime?.created,
        sourceType: "session-message.assistant.time.created",
        meaning: "Retained assistant message start time",
      },
      streamedAt: {
        value: messageTime?.streamed,
        sourceType: "session-message.assistant.time.streamed",
        meaning: "Provider response-body end before tool settlement",
      },
      completedAt: {
        value: messageTime?.completed,
        sourceType: "session-message.assistant.time.completed",
        meaning: "Assistant completion after tool settlement",
      },
    }),
  })
}

function assistantToolEvent(
  ctx: MessageContext,
  part: Record<string, unknown>,
  partIndex: number,
  { messageID }: MessageSlice,
  model: ReturnType<typeof modelView>,
) {
  const { stats } = ctx
  const toolState = object(part.state)
  const status = typeof toolState?.status === "string" ? toolState.status : "unsupported"
  if (!toolState || !TOOL_STATUSES.includes(status)) stats.omittedUnsupportedParts++
  const input = toolState?.input
  const inputView = typeof input === "string" ? safeText(input, stats) : safeValue(input, stats)
  const toolTime = object(part.time)
  const ranAt = dateMillis(toolTime?.ran)
  const completedAt = dateMillis(toolTime?.completed)
  const executed = typeof part.executed === "boolean" ? part.executed : null
  const content =
    status === "completed" || status === "error" ? safeToolContent(toolState?.content, stats) : ""
  const error = status === "error" ? safeErrorView(toolState?.error, stats) : null
  ctx.add({
    ...ctx.base(
      `${messageID}:tool:${typeof part.id === "string" ? part.id : partIndex}`,
      ranAt,
      "tool",
    ),
    model,
    tool: typeof part.name === "string" ? safeText(part.name, stats, 160) : "[unknown tool]",
    status: TOOL_STATUSES.includes(status) ? status : "unsupported",
    callStatus: ranAt !== null || executed !== null ? "called" : null,
    input: inputView,
    result: content,
    ...(error ? { error } : {}),
    completedAt,
    execution: {
      status: executed === null ? "unknown" : executed ? "executed" : "not-executed",
      source: executed === null ? null : "native-context",
      sourceType: executed === null ? null : "session-message.assistant.tool.executed",
      meaning: "Retained explicit executed flag; called/ran time alone is not execution proof",
    },
    timing: contextTiming({
      inputAt: {
        value: toolTime?.created,
        sourceType: "session-message.assistant.tool.time.created",
        meaning: "Retained assistant tool input creation boundary",
      },
      calledAt: {
        value: toolTime?.ran,
        sourceType: "session-message.assistant.tool.time.ran",
        meaning: "Retained assistant tool call boundary; not proof that the tool executed",
      },
      completedAt: {
        value: toolTime?.completed,
        sourceType: "session-message.assistant.tool.time.completed",
        meaning: "Retained assistant tool result terminal boundary",
      },
    }),
  })
}

function assistantPartEvent(
  ctx: MessageContext,
  rawPart: unknown,
  partIndex: number,
  slice: MessageSlice,
  model: ReturnType<typeof modelView>,
) {
  const { stats } = ctx
  const part = object(rawPart)
  if (!part || typeof part.type !== "string") {
    stats.omittedUnsupportedParts++
    return
  }
  if (part.type === "reasoning") {
    stats.omittedReasoning++
    return
  }
  if (part.type === "text") {
    if (typeof part.text !== "string") {
      stats.omittedUnsupportedParts++
      return
    }
    ctx.add({
      ...ctx.base(`${slice.messageID}:text:${partIndex}`, slice.createdAt, "assistant-text"),
      model,
      text: safeText(part.text, stats),
    })
    return
  }
  if (part.type !== "tool") {
    stats.omittedUnsupportedParts++
    return
  }
  assistantToolEvent(ctx, part, partIndex, slice, model)
}

function assistantTrailingEvents(
  ctx: MessageContext,
  { message, messageID, createdAt }: MessageSlice,
) {
  if (message.retry) {
    const retry = object(message.retry)
    if (retry) {
      ctx.add({
        ...ctx.base(`${messageID}:provider-retry`, dateMillis(retry.at), "provider-retry"),
        attempt: asNumber(retry.attempt),
        error: safeErrorView(retry.error, ctx.stats),
        timing: contextTiming({
          scheduledAt: {
            value: retry.at,
            sourceType: "session-message.assistant.retry.at",
            meaning: "Retained provider retry scheduled time",
          },
        }),
      })
    }
  }
  if (message.error) {
    ctx.add({
      ...ctx.base(`${messageID}:error`, createdAt, "assistant-error"),
      error: safeErrorView(message.error, ctx.stats),
    })
  }
}

function assistantMessageEvents(ctx: MessageContext, slice: MessageSlice) {
  const model = modelView(slice.message.model, ctx.stats)
  const parts = Array.isArray(slice.message.content) ? slice.message.content : []
  assistantStepEvent(ctx, slice, model)
  for (const [partIndex, rawPart] of parts.entries())
    assistantPartEvent(ctx, rawPart, partIndex, slice, model)
  assistantTrailingEvents(ctx, slice)
}

function shellMessageEvents(ctx: MessageContext, { message, messageID, createdAt }: MessageSlice) {
  const { stats } = ctx
  const output = object(message.output)
  const shellTime = object(message.time)
  ctx.add({
    ...ctx.base(messageID, createdAt, "shell"),
    command: typeof message.command === "string" ? safeText(message.command, stats) : "",
    status: typeof message.status === "string" ? safeText(message.status, stats, 80) : "unknown",
    exit: asNumber(message.exit),
    output: typeof output?.output === "string" ? safeText(output.output, stats) : "",
    outputTruncated: output?.truncated === true,
    completedAt: dateMillis(shellTime?.completed),
    timing: contextTiming({
      createdAt: {
        value: shellTime?.created,
        sourceType: "session-message.shell.time.created",
        meaning: "Retained shell message creation; not process start",
      },
      startedAt: {
        value: undefined,
        sourceType: "session-message.shell.process.started",
        meaning: "Process start is not available in the retained shell message",
      },
      completedAt: {
        value: shellTime?.completed,
        sourceType: "session-message.shell.time.completed",
        meaning: "Retained shell completion time",
      },
    }),
  })
  if (output?.truncated === true) stats.truncated++
}

function compactionMessageEvents(
  ctx: MessageContext,
  { message, messageID, createdAt }: MessageSlice,
) {
  ctx.stats.compacted++
  const status = message.status
  const failed = status === "failed"
  ctx.add({
    ...ctx.base(messageID, createdAt, "compaction"),
    status: ["running", "completed", "failed"].includes(String(status)) ? status : "unknown",
    reason: message.reason === "auto" || message.reason === "manual" ? message.reason : "unknown",
    ...(failed ? { error: safeErrorView(message.error, ctx.stats) } : {}),
    summary: "[omitted: compaction summary and replay data are private]",
  })
}

function switchMessageEvents(
  ctx: MessageContext,
  { message, messageID, createdAt }: MessageSlice,
): boolean {
  const { stats } = ctx
  if (message.type === "idle") {
    ctx.add({
      ...ctx.base(messageID, createdAt, "session-idle"),
      outcome: ["succeeded", "failed", "interrupted"].includes(String(message.outcome))
        ? message.outcome
        : "unknown",
      error: safeErrorView(message.error, stats),
    })
    return true
  }
  if (message.type === "model-switched") {
    ctx.add({
      ...ctx.base(messageID, createdAt, "model-switched"),
      model: modelView(message.model, stats),
      previous: modelView(message.previous, stats),
    })
    return true
  }
  if (message.type === "agent-switched") {
    ctx.add({
      ...ctx.base(messageID, createdAt, "agent-switched"),
      agent: typeof message.agent === "string" ? safeText(message.agent, stats, 120) : null,
      previous:
        typeof message.previous === "string" ? safeText(message.previous, stats, 120) : null,
    })
    return true
  }
  if (message.type === "location-switched") {
    ctx.add({ ...ctx.base(messageID, createdAt, "location-switched"), location: "[path omitted]" })
    return true
  }
  return false
}

function messageSliceEvents(ctx: MessageContext, slice: MessageSlice) {
  const type = slice.message.type
  if (type === "user" || type === "synthetic") return userMessageEvents(ctx, slice)
  if (type === "assistant") return assistantMessageEvents(ctx, slice)
  if (type === "shell") return shellMessageEvents(ctx, slice)
  if (type === "compaction") return compactionMessageEvents(ctx, slice)
  if (switchMessageEvents(ctx, slice)) return
  if (type === "system" || type === "skill") ctx.stats.omittedSystem++
  else ctx.stats.omittedUnsupportedParts++
}

function messageEvents(
  rawMessages: ReadonlyArray<SessionMessage.Info>,
  attempt: AttemptRow,
  session: TrajectorySession,
  stats: PrivacyStats,
) {
  const events: Record<string, unknown>[] = []
  const ctx: MessageContext = {
    stats,
    base: (id, at, kind) => ({
      id: safeText(id, stats, 256),
      at,
      attemptID: safeText(attempt.id, stats, 128),
      sessionID: safeText(session.id, stats, 128),
      kind,
    }),
    add: (event) => events.push(event),
  }

  const messages = rawMessages.slice(0, MAX_CONTEXT_MESSAGES)
  if (rawMessages.length > messages.length) stats.truncated++
  for (const [index, raw] of messages.entries()) {
    const message = object(raw)
    if (!message || typeof message.type !== "string") {
      stats.omittedUnsupportedParts++
      continue
    }
    messageSliceEvents(ctx, {
      message,
      messageID: typeof message.id === "string" ? message.id : `unknown-${index}`,
      createdAt: dateMillis(object(message.time)?.created),
    })
  }
  return events
}

function checkView(
  effect: EffectRow,
  planScope: boolean,
  attemptID: string | null,
  stats: PrivacyStats,
): CheckView {
  const receipt = parseObject(effect.receipt)
  const check = object(receipt?.check)
  const error = typeof receipt?.error === "string" ? safeText(receipt.error, stats, 1000) : null
  const exitCode = asNumber(check?.exitCode)
  const timedOut = typeof check?.timedOut === "boolean" ? check.timedOut : null
  const unchanged = typeof check?.unchanged === "boolean" ? check.unchanged : null
  const result =
    effect.state !== "completed"
      ? "unknown"
      : exitCode === 0 && timedOut === false
        ? "passed"
        : exitCode !== null || timedOut === true
          ? "failed"
          : "unknown"
  return {
    id: safeText(effect.kind.replace(/^(?:graph-)?verify:/, ""), stats, 160),
    scope: planScope ? "plan" : "attempt",
    attemptID: attemptID === null ? null : safeText(attemptID, stats, 128),
    state: safeText(effect.state, stats, 80),
    result,
    command: typeof check?.command === "string" ? safeText(check.command, stats) : null,
    startedAt: asNumber(check?.startedAt),
    endedAt: asNumber(check?.endedAt),
    timingBasis:
      "Verification receipt check.startedAt/check.endedAt; absent endpoints remain unknown",
    exitCode,
    timedOut,
    unchanged,
    stdout: typeof check?.stdout === "string" ? safeText(check.stdout, stats) : null,
    stderr: typeof check?.stderr === "string" ? safeText(check.stderr, stats) : null,
    error,
  }
}

function transitionEvent(
  row: TransitionRow,
  attempts: Map<string, AttemptRow>,
  stats: PrivacyStats,
) {
  const payload = parseObject(row.payload)
  const requestedAttempt = typeof payload?.attemptID === "string" ? payload.attemptID : null
  const attemptID = requestedAttempt && attempts.has(requestedAttempt) ? requestedAttempt : null
  const eventName = safeText(row.event, stats, 120)
  return {
    id: safeText(`runner-transition:${row.plan_id}:${row.id}`, stats, 256),
    at: row.created_at,
    attemptID: attemptID ? safeText(attemptID, stats, 128) : null,
    sessionID: attemptID ? safeText(attempts.get(attemptID)!.session_id, stats, 128) : null,
    kind: "runner-transition",
    event: eventName,
    version: row.version,
    ...(typeof payload?.from === "string" ? { from: safeText(payload.from, stats, 80) } : {}),
    ...(typeof payload?.to === "string" ? { to: safeText(payload.to, stats, 80) } : {}),
    ...(typeof payload?.reason === "string" ? { reason: safeText(payload.reason, stats) } : {}),
  }
}

function effectEvents(
  effects: EffectRow[],
  attempts: Map<string, AttemptRow>,
  checks: CheckView[],
  stats: PrivacyStats,
) {
  const events: Record<string, unknown>[] = []
  for (const effect of effects) {
    const attempt = effect.attempt_id ? attempts.get(effect.attempt_id) : undefined
    if (effect.kind.startsWith("verify:") || effect.kind.startsWith("graph-verify:")) {
      const planScope = effect.kind.startsWith("graph-verify:")
      const check = checkView(effect, planScope, attempt?.id ?? null, stats)
      checks.push(check)
      events.push({
        id: safeText(`runner-check:${effect.id}`, stats, 256),
        at: check.endedAt ?? check.startedAt ?? attempt?.started_at ?? null,
        attemptID: attempt ? safeText(attempt.id, stats, 128) : null,
        sessionID: attempt ? safeText(attempt.session_id, stats, 128) : null,
        kind: "verification",
        checkID: check.id,
        status: check.result,
        state: check.state,
        ...(check.error ? { error: check.error } : {}),
      })
      continue
    }
    const receipt = parseObject(effect.receipt)
    const message = typeof receipt?.error === "string" ? safeText(receipt.error, stats, 1000) : null
    events.push({
      id: safeText(`runner-effect:${effect.id}`, stats, 256),
      at: attempt?.started_at ?? null,
      attemptID: attempt ? safeText(attempt.id, stats, 128) : null,
      sessionID: attempt ? safeText(attempt.session_id, stats, 128) : null,
      kind: "runner-effect",
      effect: safeText(effect.kind, stats, 100),
      state: safeText(effect.state, stats, 80),
      ...(message ? { error: message } : {}),
    })
  }
  return events
}

function rawPlanInput(row: PlanRow) {
  try {
    return PlanInput.parse(JSON.parse(row.body))
  } catch {
    return null
  }
}

function snapshots(store: RunnerStore, task: TaskSpec): PlanSnapshot[] {
  const directory = store.repository.projectDirectory
  // Filtered in SQL by task: only the plans that hold the task, and within them only its
  // node, attempts, effects and transitions. No pass over every plan's rows.
  return store.atomic((db) => {
    const rows = db
      .query<PlanRow, [string, string]>(
        `SELECT p.* FROM runner_plans p
         WHERE p.project_directory=?
           AND EXISTS (SELECT 1 FROM runner_nodes n WHERE n.plan_id=p.id AND n.task_id=?)
         ORDER BY p.rowid`,
      )
      .all(directory, task.id)
    const output: PlanSnapshot[] = []
    for (const row of rows) {
      const node = db
        .query<NodeRow, [string, string]>(
          "SELECT * FROM runner_nodes WHERE plan_id=? AND task_id=? ORDER BY ordinal LIMIT 1",
        )
        .get(row.id, task.id)
      if (!node) continue
      const attempts = db
        .query<AttemptRow, [string, string]>(
          "SELECT * FROM runner_attempts WHERE plan_id=? AND task_id=? ORDER BY started_at,number",
        )
        .all(row.id, task.id)
      const effects = db
        .query<EffectRow, [string, string]>(
          `SELECT * FROM runner_effects WHERE plan_id=?
             AND (task_id=? OR (task_id IS NULL AND attempt_id IS NULL)) ORDER BY rowid`,
        )
        .all(row.id, task.id)
      const transitions = db
        .query<TransitionRow, [string, string]>(
          "SELECT id,plan_id,task_id,version,event,payload,created_at FROM runner_transitions WHERE plan_id=? AND task_id=? ORDER BY id",
        )
        .all(row.id, task.id)
      output.push({ row, node, input: rawPlanInput(row), attempts, effects, transitions })
    }
    return output
  })
}

function makeCursor(secret: Uint8Array, data: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(data)).toString("base64url")
  const signature = createHmac("sha256", secret).update(body).digest("base64url")
  return `${body}.${signature}`
}

function readCursor(secret: Uint8Array, cursor: string) {
  if (cursor.length > 4096) throw new Error("Invalid or stale trajectory cursor")
  const [body, signature, extra] = cursor.split(".")
  if (!body || !signature || extra !== undefined)
    throw new Error("Invalid or stale trajectory cursor")
  const expected = createHmac("sha256", secret).update(body).digest("base64url")
  const providedBytes = Buffer.from(signature)
  const expectedBytes = Buffer.from(expected)
  if (
    providedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(providedBytes, expectedBytes)
  )
    throw new Error("Invalid or stale trajectory cursor")
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
    const data = object(parsed)
    if (
      !data ||
      data.v !== 1 ||
      !Number.isInteger(data.offset) ||
      (data.offset as number) < 0 ||
      typeof data.snapshot !== "string" ||
      typeof data.scope !== "string" ||
      !Number.isInteger(data.limit)
    )
      throw new Error("Invalid or stale trajectory cursor")
    return data as { v: 1; offset: number; snapshot: string; scope: string; limit: number }
  } catch {
    throw new Error("Invalid or stale trajectory cursor")
  }
}

function hashSource(value: unknown, secret?: Uint8Array) {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error("Trajectory source is not safely serializable")
  }
  if (serialized === undefined) throw new Error("Trajectory source is not safely serializable")
  return secret
    ? createHmac("sha256", secret).update(serialized).digest("hex")
    : createHash("sha256").update(serialized).digest("hex")
}

function usage(session: TrajectorySession | null) {
  const raw = session?.tokens
  if (
    !raw ||
    !Number.isFinite(raw.input) ||
    !Number.isFinite(raw.output) ||
    !Number.isFinite(raw.reasoning) ||
    !Number.isFinite(raw.cache?.read) ||
    !Number.isFinite(raw.cache?.write)
  )
    return null
  return {
    uncachedInput: raw.input,
    cacheRead: raw.cache.read,
    cacheWrite: raw.cache.write,
    output: raw.output,
    reasoning: raw.reasoning,
    source: "OpenCode cumulative session snapshot; one snapshot per unique worker session",
  }
}

function safeMessageModels(session: TrajectorySession | null, stats: PrivacyStats) {
  const found = new Map<string, NonNullable<ReturnType<typeof modelView>>>()
  for (const raw of session?.messages ?? []) {
    const message = object(raw)
    if (message?.type !== "assistant") continue
    const model = modelView(message.model, stats)
    if (model) found.set(modelKey(model), model)
  }
  return [...found.values()]
}

function modelFromPolicy(policy: string, stats: PrivacyStats) {
  const data = parseObject(policy)
  return modelView(data?.model, stats)
}

function attemptView(
  attempt: AttemptRow,
  snapshot: PlanSnapshot,
  session: TrajectorySession | null,
  sessionStatus: "available" | "missing" | "unavailable",
  sessionError: string | null,
  stats: PrivacyStats,
  checks: CheckView[],
  concern?: { line: string; action?: string; because?: string },
) {
  const admitted =
    modelFromPolicy(attempt.policy, stats) ?? modelView(parseObject(snapshot.row.model), stats)
  const observed = session ? modelView(session.model, stats) : null
  const messageModels = safeMessageModels(session, stats)
  const uniqueModels = new Map<string, NonNullable<typeof observed>>()
  for (const model of [...messageModels, ...(observed ? [observed] : [])])
    uniqueModels.set(modelKey(model), model)
  const legacyTokenCount = numberOrNull(attempt.token_count)
  return {
    id: safeText(attempt.id, stats, 128),
    planID: safeText(attempt.plan_id, stats, 128),
    number: attempt.number,
    state: safeText(attempt.state, stats, 80),
    // The Architect finishing the task itself, not a worker's attempt.
    ...(isTakeoverAttempt(attempt.policy) ? { takeover: { agent: "architect" as const } } : {}),
    ...(concern
      ? {
          concern: {
            line: safeText(concern.line, stats, 600),
            ...(concern.action ? { action: safeText(concern.action, stats, 40) } : {}),
            ...(concern.because ? { because: safeText(concern.because, stats, 600) } : {}),
          },
        }
      : {}),
    sessionID: safeText(attempt.session_id, stats, 128),
    baseCommit: safeText(attempt.base_commit, stats, 128),
    resultCommit: attempt.artifact ? safeText(attempt.artifact, stats, 128) : null,
    startedAt: attempt.started_at,
    times: session
      ? {
          sessionCreatedAt: session.time.created,
          sessionUpdatedAt: session.time.updated,
          lastBusyAt: session.time.busy,
          lastIdleAt: session.time.idle,
          sessionBusy: session.busy,
        }
      : null,
    intervals: {
      attempt: {
        startedAt: attempt.started_at,
        endedAt: null,
        basis: "runner_attempt.started_at is recorded; no attempt end is inferred",
      },
      modelActivity: {
        startedAt: session?.time.busy ?? null,
        endedAt: session?.time.idle ?? null,
        basis:
          "OpenCode native session busy/idle endpoints describe model activity only; idle is not task acceptance",
      },
    },
    sessionStatus,
    ...(sessionError ? { sessionError: safeText(sessionError, stats, 1000) } : {}),
    outcome: session?.outcome ?? null,
    admittedModel: admitted,
    observedCurrentModel: observed,
    observedMessageModels: messageModels,
    tokenModelAttribution:
      uniqueModels.size > 1
        ? "mixed models observed; session aggregate cannot be split by model"
        : "session aggregate attributed only to the session snapshot, not individual calls",
    usage: usage(session),
    legacyTokenCount: {
      value: legacyTokenCount,
      source: "runner_attempt.token_count scalar; not added to categorized session totals",
      status: legacyTokenCount === null ? "missing" : "legacy-aggregate",
    },
    toolCount: {
      value: attempt.tool_count,
      source: "runner_attempt.tool_count; attempt scope",
    },
    providerRetryCount: {
      value: attempt.retry_count,
      source: "runner_attempt.retry_count; attempt scope",
    },
    recordedCost: {
      valueUsd: numberOrNull(attempt.cost),
      source: "runner_attempt.cost scalar; provider, date, and price basis are not persisted",
      scope: "worker attempt only; not an API-equivalent estimate",
    },
    checks: checks.filter((check) => check.attemptID === attempt.id),
  }
}

type InspectOptions = {
  allEvents?: boolean
  includeMessages?: boolean
  taskValuationProvider?: TaskValuationProvider
  signal?: AbortSignal
}
type AttemptEntry = { attempt: AttemptRow; snapshot: PlanSnapshot }
type SessionStatus = "available" | "missing" | "unavailable"
type SessionReads = {
  sessions: Map<string, TrajectorySession | null>
  errors: Map<string, string>
  statuses: Map<string, SessionStatus>
}

function ownedByProject(task: TaskSpec, store: RunnerStore, projectID: string) {
  return (
    sameProject(task.provenance.projectID, projectID) &&
    task.provenance.projectDirectory === store.repository.projectDirectory
  )
}

function hasAttempt(plans: PlanSnapshot[], attemptID: string) {
  return plans.some((snapshot) => snapshot.attempts.some((attempt) => attempt.id === attemptID))
}

/** The project-owned task that holds the attempt: one indexed lookup, not a scan of every plan. */
function taskOfAttempt(store: RunnerStore, projectID: string, attemptID: string) {
  const taskIDs = store.atomic((db) =>
    db
      .query<{ task_id: string }, [string, string]>(
        `SELECT a.task_id FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
         WHERE p.project_directory=? AND a.id=? ORDER BY p.rowid`,
      )
      .all(store.repository.projectDirectory, attemptID),
  )
  let task: TaskSpec | undefined
  for (const { task_id } of taskIDs) {
    const found = store.repository.get(task_id)
    if (found && ownedByProject(found, store, projectID)) task = found
  }
  return task
}

function resolveTrajectoryTarget(
  store: RunnerStore,
  projectID: string,
  input: InspectTrajectoryInput,
) {
  let task: TaskSpec | undefined
  if (input.taskID) task = store.repository.get(input.taskID)
  if (task && !ownedByProject(task, store, projectID))
    throw new Error("Task is not owned by this project")

  let rawPlans = task ? snapshots(store, task) : []
  if (input.attemptID && !hasAttempt(rawPlans, input.attemptID)) {
    task = taskOfAttempt(store, projectID, input.attemptID) ?? task
    if (!task) throw new Error("No project-owned attempt found")
    rawPlans = snapshots(store, task)
  }
  if (!task)
    throw new Error(
      input.taskID ? "Task is not owned by this project" : "No project-owned attempt found",
    )
  if (input.attemptID && !hasAttempt(rawPlans, input.attemptID))
    throw new Error("No project-owned attempt found")
  return { task, rawPlans }
}

async function readAttemptSessions(
  host: TrajectoryHost,
  projectID: string,
  allAttempts: AttemptEntry[],
  options: InspectOptions,
  stats: PrivacyStats,
): Promise<SessionReads> {
  const statusReader = options.includeMessages === false ? host.status : undefined
  if (options.includeMessages === false && !statusReader)
    throw new Error("Metadata-only trajectory status is unavailable")

  const reads: SessionReads = { sessions: new Map(), errors: new Map(), statuses: new Map() }
  const sessionsByAssignment = new Map<string, Promise<TrajectorySession | null>>()
  for (const { attempt } of allAttempts) {
    // An Architect takeover has no native worker session to read; nothing is missing.
    if (isTakeoverAttempt(attempt.policy)) continue
    try {
      const sessionKey = JSON.stringify([attempt.session_id, attempt.id, attempt.workspace])
      let read = sessionsByAssignment.get(sessionKey)
      if (!read) {
        const sessionID = attempt.session_id
        read =
          options.includeMessages === false
            ? statusReader!(sessionID, attempt)
            : host.session(sessionID, attempt)
        sessionsByAssignment.set(sessionKey, read)
      }
      const session = await read
      if (session && (session.id !== attempt.session_id || session.projectID !== projectID))
        throw new TrajectoryIdentityError()
      reads.sessions.set(attempt.id, session)
      reads.statuses.set(attempt.id, session ? "available" : "missing")
      if (session?.messageStatus === "unavailable" && session.messageError)
        reads.errors.set(attempt.id, session.messageError)
    } catch (error) {
      if (error instanceof TrajectoryIdentityError) throw error
      reads.sessions.set(attempt.id, null)
      reads.statuses.set(attempt.id, "unavailable")
      reads.errors.set(attempt.id, safeError(error, stats))
    }
  }
  return reads
}

function collectTrajectoryEvents(
  rawPlans: PlanSnapshot[],
  allAttempts: AttemptEntry[],
  reads: SessionReads,
  projectedProgressFacts: Record<string, unknown>[],
  options: InspectOptions,
  stats: PrivacyStats,
) {
  const rawEvents: Record<string, unknown>[] = []
  const allChecks: CheckView[] = []
  const checksByPlan = new Map<string, CheckView[]>()
  const attemptMap = new Map(allAttempts.map(({ attempt }) => [attempt.id, attempt]))
  for (const snapshot of rawPlans) {
    for (const transition of snapshot.transitions)
      rawEvents.push(transitionEvent(transition, attemptMap, stats))
    const planChecks: CheckView[] = []
    rawEvents.push(...effectEvents(snapshot.effects, attemptMap, planChecks, stats))
    allChecks.push(...planChecks)
    checksByPlan.set(snapshot.row.id, planChecks)
    for (const attempt of snapshot.attempts) {
      const session = reads.sessions.get(attempt.id) ?? null
      if (
        options.includeMessages !== false &&
        session?.messages &&
        reads.statuses.get(attempt.id) === "available"
      )
        rawEvents.push(...messageEvents(session.messages, attempt, session, stats))
    }
  }
  rawEvents.push(...projectedProgressFacts)
  rawEvents.sort((a, b) => {
    const left = typeof a.at === "number" ? a.at : Number.MAX_SAFE_INTEGER
    const right = typeof b.at === "number" ? b.at : Number.MAX_SAFE_INTEGER
    return left - right || String(a.id).localeCompare(String(b.id))
  })
  return { rawEvents, allChecks, checksByPlan }
}

function safeAcceptance(items: TaskSpec["proposal"]["acceptance"], stats: PrivacyStats) {
  return items.map((item) => ({
    id: safeText(item.id, stats, 120),
    assertion: safeText(item.assertion, stats),
    evidence: item.evidence.map((evidence) =>
      evidence.kind === "verification"
        ? { kind: "verification", verificationID: safeText(evidence.verificationID, stats) }
        : { kind: "artifact", reference: safeText(evidence.reference, stats) },
    ),
  }))
}

function isAcceptedNode(snapshot: PlanSnapshot) {
  return snapshot.node.state === "accepted" || snapshot.node.state === "incorporated"
}

function focusedPlanViews(
  store: RunnerStore,
  task: TaskSpec,
  rawPlans: PlanSnapshot[],
  checksByPlan: Map<string, CheckView[]>,
  stats: PrivacyStats,
) {
  return rawPlans.map((snapshot) => ({
    id: safeText(snapshot.row.id, stats, 128),
    revision: snapshot.row.revision,
    state: safeText(snapshot.row.state, stats, 80),
    version: snapshot.row.version,
    reason: snapshot.row.reason === null ? null : safeText(snapshot.row.reason, stats),
    taskReason: snapshot.node.reason === null ? null : safeText(snapshot.node.reason, stats),
    objective: snapshot.input ? safeText(snapshot.input.objective, stats) : null,
    baseCommit: snapshot.input ? safeText(snapshot.input.baseCommit, stats, 128) : null,
    resultCommit: snapshot.row.artifact ? safeText(snapshot.row.artifact, stats, 128) : null,
    admittedModel:
      modelView(parseObject(snapshot.row.model), stats) ??
      modelView(snapshot.input?.workerModel, stats),
    taskState: safeText(snapshot.node.state, stats, 80),
    accepted: isAcceptedNode(snapshot),
    taskResultCommit: snapshot.node.artifact ? safeText(snapshot.node.artifact, stats, 128) : null,
    waitingOn: store.execution(task.id)?.waitingOn.map((id) => safeText(id, stats, 128)) ?? [],
    acceptance: safeAcceptance(snapshot.input?.acceptance ?? [], stats),
    checks: checksByPlan.get(snapshot.row.id) ?? [],
  }))
}

function truncatedContextSessions(
  allAttempts: AttemptEntry[],
  reads: SessionReads,
  stats: PrivacyStats,
) {
  return [
    ...new Set(
      allAttempts.flatMap(({ attempt }) => {
        const session = reads.sessions.get(attempt.id)
        return session?.messages && session.messages.length > MAX_CONTEXT_MESSAGES
          ? [safeText(attempt.session_id, stats, 128)]
          : []
      }),
    ),
  ]
}

function valuationAttempt(
  { attempt, snapshot }: AttemptEntry,
  session: TrajectorySession | null,
  sessionStatus: SessionStatus,
  stats: PrivacyStats,
): ProjectTaskValuationRequest["attempts"][number] {
  const policy = parseObject(attempt.policy)
  const attemptRoute = modelView(policy?.model, stats)
  const planRoute = modelView(snapshot.input?.workerModel, stats)
  const planPersona = snapshot.input?.nodes.find((node) => node.taskID === attempt.task_id)?.persona
  return {
    id: safeText(attempt.id, stats, 128),
    sessionID: safeText(attempt.session_id, stats, 128),
    state: safeText(attempt.state, stats, 80),
    legacyTokenCount: numberOrNull(attempt.token_count),
    recordedCostUSD: numberOrNull(attempt.cost),
    planRoute: accountingRoute(planRoute),
    planRouteStatus: snapshot.input
      ? snapshot.input.workerModel
        ? ("explicit" as const)
        : ("inherited" as const)
      : ("unavailable" as const),
    frozenRoute: accountingRoute(attemptRoute ?? modelView(parseObject(snapshot.row.model), stats)),
    frozenRouteSource: attemptRoute
      ? "runner_attempt.policy.model"
      : snapshot.row.model
        ? "runner_plans.model fallback; attempt policy model unavailable"
        : null,
    personaRequested: planPersona ?? null,
    personaFrozen: frozenPersona(policy),
    sessionStatus,
    contextStatus:
      session?.messageStatus === "available"
        ? "available"
        : session?.messageStatus === "not-read"
          ? "not-read"
          : "unavailable",
    currentRoute: accountingRoute(session ? modelView(session.model, stats) : null),
    currentRouteObservedAt: session ? dateMillis(session.time.updated) : null,
    sessionUsage: session?.tokens
      ? {
          input: session.tokens.input,
          output: session.tokens.output,
          reasoning: session.tokens.reasoning,
          cacheRead: session.tokens.cache.read,
          cacheWrite: session.tokens.cache.write,
        }
      : null,
    sessionUsageObservedAt: session ? dateMillis(session.time.updated) : null,
    stepRoutes: sessionStepRoutes(session, stats),
  }
}

async function marketEquivalentCostOf(
  valuationInput: ProjectTaskValuationRequest,
  options: InspectOptions,
): Promise<TrajectoryMarketEquivalentCost | undefined> {
  if (!options.taskValuationProvider) return undefined
  const signal = options.signal ?? new AbortController().signal
  signal.throwIfAborted()
  let marketEquivalentCost: TrajectoryMarketEquivalentCost
  try {
    marketEquivalentCost = await options.taskValuationProvider(valuationInput, signal)
  } catch {
    signal.throwIfAborted()
    marketEquivalentCost = unavailableTaskValuation(valuationInput)
  }
  signal.throwIfAborted()
  return marketEquivalentCost
}

type TaskEffortBasis = ReturnType<typeof projectTaskEffortBasis>

function effortTokenUsage(
  allAttempts: AttemptEntry[],
  taskEffortBasis: TaskEffortBasis,
  attemptViews: ReturnType<typeof attemptView>[],
  stats: PrivacyStats,
) {
  const categories = taskEffortBasis.usage.categories
  const totals = {
    uncachedInput: categories.uncachedInput.value,
    cacheRead: categories.cacheRead.value,
    cacheWrite: categories.cacheWrite.value,
    output: categories.output.value,
    reasoning: categories.reasoning.value,
  }
  const completeSessions = taskEffortBasis.usage.sessions.filter((session) =>
    Object.values(session.categories).every((category) => category.status === "observed"),
  )
  const completeSessionIDs = new Set(completeSessions.map((session) => session.sessionID))
  const unknownUsageAttempts = allAttempts
    .filter(({ attempt }) => !isTakeoverAttempt(attempt.policy))
    .filter(({ attempt }) => !completeSessionIDs.has(attempt.session_id))
    .map(({ attempt }) => safeText(attempt.id, stats, 128))
  return {
    measuredSubtotal: totals,
    total: Object.values(categories).every((category) => category.status === "observed")
      ? totals
      : null,
    unit: "tokens",
    components: {
      uncachedInput: "OpenCode input; cache is reported separately",
      cacheRead: "OpenCode cache-read tokens",
      cacheWrite: "OpenCode cache-write tokens",
      output: "OpenCode output; reasoning is reported separately",
      reasoning: "OpenCode reasoning tokens",
    },
    source:
      "One selected contribution per unique worker session: native cumulative snapshot, otherwise retained cumulative snapshot, otherwise additive-step subtotal",
    knownSessions: completeSessions.length,
    totalSessions: taskEffortBasis.usage.coverage.totalUniqueSessions,
    unknownAttempts: unknownUsageAttempts,
    legacyAttemptScalarsNotAdded: attemptViews
      .filter((attempt) => !attempt.takeover)
      .map((attempt) => ({
        attemptID: attempt.id,
        ...attempt.legacyTokenCount,
      })),
  }
}

function effortTiming(rawPlans: PlanSnapshot[], allAttempts: AttemptEntry[]) {
  const acceptedTransitions = rawPlans
    .flatMap((snapshot) => snapshot.transitions)
    .filter((event) => event.event === "ACCEPT")
  const acceptedAt = acceptedTransitions.length
    ? Math.min(...acceptedTransitions.map((event) => event.created_at))
    : null
  const firstAttemptAt = allAttempts.length
    ? Math.min(...allAttempts.map(({ attempt }) => attempt.started_at))
    : null
  const wallClockSpanMs =
    firstAttemptAt !== null && acceptedAt !== null && acceptedAt >= firstAttemptAt
      ? acceptedAt - firstAttemptAt
      : null
  return { acceptedAt, firstAttemptAt, wallClockSpanMs }
}

function effortView(
  rawPlans: PlanSnapshot[],
  allAttempts: AttemptEntry[],
  reads: SessionReads,
  attemptViews: ReturnType<typeof attemptView>[],
  taskEffortBasis: TaskEffortBasis,
  marketEquivalentCost: TrajectoryMarketEquivalentCost | undefined,
  stats: PrivacyStats,
) {
  const tokenUsage = effortTokenUsage(allAttempts, taskEffortBasis, attemptViews, stats)
  const { acceptedAt, firstAttemptAt, wallClockSpanMs } = effortTiming(rawPlans, allAttempts)
  const taskAccepted = rawPlans.some(isAcceptedNode)
  const busy = allAttempts.some(({ attempt }) => {
    const session = reads.sessions.get(attempt.id)
    return ACTIVE_ATTEMPTS.has(attempt.state) || session?.busy === true
  })
  const recorded = taskEffortBasis.cost.recordedWorkerAttemptSubtotalUSD
  return {
    busy,
    effort: {
      accepted: taskAccepted,
      ongoing: busy,
      firstAttemptAt,
      acceptedAt,
      wallClockSpanMs,
      wallClockBasis:
        "earliest runner attempt start to the task ACCEPT transition; not model-active time",
      tokenUsage,
      taskEffortBasis,
      toolCalls: {
        count: allAttempts.reduce((total, { attempt }) => total + attempt.tool_count, 0),
        source:
          "Sum of runner_attempt.tool_count once per attempt; transcript tool events are not added",
      },
      providerRetries: {
        count: allAttempts.reduce((total, { attempt }) => total + attempt.retry_count, 0),
        source: "Sum of runner_attempt.retry_count once per attempt",
      },
      recordedCost: {
        workerAttemptSubtotalUsd: recorded.valueUSD,
        status: recorded.status,
        workerScope: "LAZERS attempt rows only",
        provenance:
          "Legacy runner scalar; source model, price date, and billing basis are not persisted",
        unknownContributions: recorded.missingAttemptIDs.map((id) => safeText(id, stats, 128)),
        apiEquivalentTotalUsd: marketEquivalentCost?.valueUSD ?? null,
        apiEquivalentSubtotalUsd: marketEquivalentCost?.subtotalUSD ?? null,
        apiEquivalentStatus: marketEquivalentCost?.status ?? "unknown",
      },
      ...(marketEquivalentCost ? { marketEquivalentCost } : {}),
    },
  }
}

function taskView(
  store: RunnerStore,
  task: TaskSpec,
  rawPlans: PlanSnapshot[],
  stats: PrivacyStats,
) {
  return {
    id: safeText(task.id, stats, 128),
    // The same resolver the Tasks read uses; omitted for a task that has none.
    ...(store.repository.referenceFor(task.id)
      ? { reference: safeText(store.repository.referenceFor(task.id)!, stats, 300) }
      : {}),
    revision: task.revision,
    status: safeText(task.status, stats, 80),
    // The task's current recorded lifecycle state (its node in the latest plan), which is what
    // Tasks shows. `status` above is the proposal's own and stays "submitted" after acceptance.
    ...(rawPlans.at(-1) ? { recordedState: safeText(rawPlans.at(-1)!.node.state, stats, 80) } : {}),
    createdAt: safeText(task.createdAt, stats, 128),
    projectID: safeText(task.provenance.projectID, stats, 128),
    sourceCommit:
      task.provenance.startingRevision.kind === "git"
        ? safeText(task.provenance.startingRevision.commit, stats, 128)
        : null,
    specification: safeSpec(task, stats),
  }
}

function coverageView(
  allAttempts: AttemptEntry[],
  reads: SessionReads,
  attemptViews: ReturnType<typeof attemptView>[],
  progressRows: ProgressRow[],
  progressTruncated: boolean,
  busy: boolean,
  options: InspectOptions,
  stats: PrivacyStats,
) {
  const messagesUnavailable = allAttempts.filter(
    ({ attempt }) =>
      reads.statuses.get(attempt.id) === "unavailable" ||
      reads.sessions.get(attempt.id)?.messageStatus === "unavailable",
  ).length
  const messageSessions = allAttempts.filter(
    ({ attempt }) => reads.sessions.get(attempt.id)?.messages,
  ).length
  return {
    sessionRead:
      options.includeMessages === false
        ? "OpenCode session.get only; the native message list was not read"
        : "OpenCode session.get followed by a paged message.list read",
    transcript: "Only messages returned by the paged host message list, up to the transcript bound",
    availableSessionContexts: messageSessions,
    unavailableSessionContexts: messagesUnavailable,
    fullSessionHistory: "not guaranteed; use explicit warnings and do not infer omitted history",
    compacted: stats.compacted > 0,
    ongoing: busy,
    attemptsWithoutRecordedSessions: attemptViews.filter(
      (attempt) => attempt.sessionStatus !== "available" && !attempt.takeover,
    ).length,
    workerProgress: {
      facts: progressRows.length,
      truncated: progressTruncated,
      commentary: progressRows.filter((row) => row.kind === "commentary").length,
      automaticFacts: progressRows.filter((row) => row.kind !== "commentary").length,
      recoveryGaps: progressRows.filter((row) => row.kind === "gap").length,
      additiveStepMeasurements: progressRows.filter((row) => row.kind === "step").length,
      cumulativeUsageSnapshots: progressRows.filter((row) => row.kind === "usage-snapshot").length,
    },
  }
}

function privacyView(stats: PrivacyStats) {
  return {
    redactedValues: stats.redacted,
    truncatedValues: stats.truncated,
    omittedUnknownParts: stats.omittedUnsupportedParts,
    omittedAttachments: stats.omittedAttachments,
    omittedReasoning: stats.omittedReasoning,
    omittedSystemOrSkillMessages: stats.omittedSystem,
    warnings: [
      "Credential detection covers common formats and sensitive key names; arbitrary prose secrets may evade pattern detection.",
      "System instructions, reasoning, metadata, provider-native/replay data, attachment/file bodies, and raw response bodies are not exported.",
      "Compaction summaries are omitted; the paged transcript may not contain the full history.",
    ],
  }
}

/** Slices the visible events into the requested page and signs the continuation cursor. */
function paginateEvents(
  input: InspectTrajectoryInput,
  options: InspectOptions,
  cursorSecret: Uint8Array,
  source: {
    targetScope: string
    task: TaskSpec
    rawPlans: PlanSnapshot[]
    reads: SessionReads
    rawEvents: Record<string, unknown>[]
    visibleEvents: Record<string, unknown>[]
    summary: Record<string, unknown>
  },
) {
  const { targetScope, task, rawPlans, reads, rawEvents, visibleEvents, summary } = source
  let offset = 0
  const cursorSummary = structuredClone(summary)
  const cursorMarket = object(object(cursorSummary.effort)?.marketEquivalentCost)
  const cursorIndex = object(cursorMarket?.currentIndex)
  if (cursorIndex) delete cursorIndex.retrievedAt
  // A concern raised mid-read must not invalidate a continuation.
  if (Array.isArray(cursorSummary.attempts))
    for (const entry of cursorSummary.attempts) delete object(entry)?.concern
  if (input.cursor && options.allEvents) throw new Error("Invalid or stale trajectory cursor")
  // Full captures and live status never issue continuation tokens.
  const pagination = options.allEvents
    ? null
    : {
        scope: hashSource({ targetScope, limit: input.limit }),
        snapshot: hashSource({
          // Key raw-source identity so tokens cannot expose an offline oracle
          // for private source values.
          hash: hashSource(
            {
              targetScope,
              task,
              plans: rawPlans,
              sessions: [...reads.sessions.entries()],
              sessionErrors: [...reads.errors.entries()],
              events: rawEvents,
            },
            cursorSecret,
          ),
          // Models index retrieval time is per read; its stable index and source snapshots
          // still bind continuations to the exact cached price selection.
          summary: cursorSummary,
          events: visibleEvents,
        }),
      }
  if (input.cursor) {
    const cursor = readCursor(cursorSecret, input.cursor)
    if (
      cursor.scope !== pagination?.scope ||
      cursor.snapshot !== pagination?.snapshot ||
      cursor.limit !== input.limit
    )
      throw new Error("Stale trajectory cursor; restart from the first page")
    offset = cursor.offset
  }
  if (offset > visibleEvents.length) throw new Error("Invalid or stale trajectory cursor")
  const page = options.allEvents ? visibleEvents : visibleEvents.slice(offset, offset + input.limit)
  const nextOffset = offset + page.length
  const nextCursor =
    pagination && nextOffset < visibleEvents.length
      ? makeCursor(cursorSecret, {
          v: 1,
          offset: nextOffset,
          snapshot: pagination.snapshot,
          scope: pagination.scope,
          limit: input.limit,
        })
      : null
  return {
    order: "timestamp-ascending then stable event ID",
    page: Math.floor(offset / input.limit) + 1,
    limit: input.limit,
    totalEvents: visibleEvents.length,
    events: page,
    nextCursor,
    hasMore: nextCursor !== null,
  }
}

/**
 * Build one project-owned, read-only report. The runner's `detail()` method is
 * deliberately avoided because it calls `audit()` and inserts an audit row.
 */
export async function inspectTrajectory(
  store: RunnerStore,
  host: TrajectoryHost,
  projectID: string,
  input: InspectTrajectoryInput,
  cursorSecret: Uint8Array,
  options: InspectOptions = {},
) {
  const stats = privacyStats()
  const { task, rawPlans } = resolveTrajectoryTarget(store, projectID, input)

  const allAttempts = rawPlans.flatMap((snapshot) =>
    snapshot.attempts.map((attempt) => ({ attempt, snapshot })),
  )
  if (options.includeMessages === false && !host.status)
    throw new Error("Metadata-only trajectory status is unavailable")
  const progressRows = store.progressFacts(allAttempts.map(({ attempt }) => attempt.id))
  const progressTruncated = progressRows.length > 10_000
  const visibleProgressRows = progressTruncated ? progressRows.slice(-10_000) : progressRows
  const reads = await readAttemptSessions(host, projectID, allAttempts, options, stats)

  const projectedProgressFacts = visibleProgressRows.map(projectProgressFact)
  const { rawEvents, allChecks, checksByPlan } = collectTrajectoryEvents(
    rawPlans,
    allAttempts,
    reads,
    projectedProgressFacts,
    options,
    stats,
  )

  const targetScope = input.taskID ? `task:${input.taskID}` : `attempt:${input.attemptID}`
  const visibleEvents = input.attemptID
    ? rawEvents.filter((event) => event.attemptID === input.attemptID || event.attemptID === null)
    : rawEvents
  const focusedTaskPlans = focusedPlanViews(store, task, rawPlans, checksByPlan, stats)

  // One read: the task's open concerns, shown on the attempt each was raised against.
  const concerns = new Map<string, { line: string; action?: string; because?: string }>()
  for (const open of store.read((db) =>
    openConcerns(db, store.repository.projectDirectory, { taskID: task.id }),
  )) {
    const known = concerns.get(open.attemptID)
    concerns.set(open.attemptID, {
      line: known ? `${known.line}; ${open.reason}` : open.reason,
      ...(open.advice ? { action: open.advice.action, because: open.advice.because } : {}),
    })
  }
  const attemptViews = allAttempts.map(({ attempt, snapshot }) =>
    attemptView(
      attempt,
      snapshot,
      reads.sessions.get(attempt.id) ?? null,
      reads.statuses.get(attempt.id) ?? "missing",
      reads.errors.get(attempt.id) ?? null,
      stats,
      allChecks,
      concerns.get(attempt.id),
    ),
  )
  const truncatedContextSessionIDs = truncatedContextSessions(allAttempts, reads, stats)
  const valuationInput: ProjectTaskValuationRequest = {
    attempts: allAttempts
      .filter((entry) => !isTakeoverAttempt(entry.attempt.policy))
      .map((entry) =>
        valuationAttempt(
          entry,
          reads.sessions.get(entry.attempt.id) ?? null,
          reads.statuses.get(entry.attempt.id) ?? "missing",
          stats,
        ),
      ),
    progressFacts: projectedProgressFacts,
    progressTruncated,
    truncatedContextSessionIDs,
  }
  const taskEffortBasis = projectTaskEffortBasis(valuationInput)
  const focusedAttempts = input.attemptID
    ? attemptViews.filter((attempt) => attempt.id === input.attemptID)
    : attemptViews
  const marketEquivalentCost = await marketEquivalentCostOf(valuationInput, options)
  const { effort, busy } = effortView(
    rawPlans,
    allAttempts,
    reads,
    attemptViews,
    taskEffortBasis,
    marketEquivalentCost,
    stats,
  )
  const summary = {
    schemaVersion: 1,
    task: taskView(store, task, rawPlans, stats),
    plans: focusedTaskPlans,
    focusedAttemptID: input.attemptID ? safeText(input.attemptID, stats, 128) : null,
    attempts: focusedAttempts,
    effort,
    coverage: coverageView(
      allAttempts,
      reads,
      attemptViews,
      visibleProgressRows,
      progressTruncated,
      busy,
      options,
      stats,
    ),
    privacy: privacyView(stats),
  }
  const trajectory = paginateEvents(input, options, cursorSecret, {
    targetScope,
    task,
    rawPlans,
    reads,
    rawEvents,
    visibleEvents,
    summary,
  })
  return { ...summary, trajectory }
}

/** Captures the complete sanitized event projection once for the panel page cache. */
export function captureTrajectoryHistory(
  store: RunnerStore,
  host: TrajectoryHost,
  projectID: string,
  input: InspectTrajectoryInput,
  cursorSecret: Uint8Array,
  options: { taskValuationProvider?: TaskValuationProvider; signal?: AbortSignal } = {},
) {
  return inspectTrajectory(store, host, projectID, input, cursorSecret, {
    ...options,
    allEvents: true,
  })
}

/** Reads current runner/session facts without reading the native message list. */
export function inspectTrajectoryStatus(
  store: RunnerStore,
  host: TrajectoryHost,
  projectID: string,
  taskID: string,
  cursorSecret: Uint8Array,
) {
  return inspectTrajectory(store, host, projectID, { taskID, limit: 50 }, cursorSecret, {
    allEvents: true,
    includeMessages: false,
  })
}
