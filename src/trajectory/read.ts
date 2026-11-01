import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { DateTime } from "effect"
import type { TaskSpec } from "../task.ts"
import type { AttemptRow, EffectRow, NodeRow, PlanRow, RunnerStore } from "../runner/store.ts"
import { PlanInput } from "../runner/schema.ts"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { InspectTrajectoryInput } from "./schema.ts"
import { TrajectoryIdentityError } from "./native.ts"
import type { TrajectoryHost, TrajectorySession } from "./native.ts"
import { privateTagOmission, privacyStats, safeError, safeText, safeValue } from "./privacy.ts"
import type { PrivacyStats } from "./privacy.ts"
import { projectProgressFact } from "../progress/projection.ts"

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
const MAX_CONTEXT_MESSAGES = 10_000

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function dateMillis(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (value === null || value === undefined) return null
  try {
    return DateTime.toEpochMillis(value as DateTime.DateTime)
  } catch {
    return null
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
  return {
    providerID: safeText(providerID, stats, 120),
    id: safeText(id, stats, 120),
    ...(typeof data.variant === "string" ? { variant: safeText(data.variant, stats, 120) } : {}),
  }
}

function modelKey(model: ReturnType<typeof modelView>) {
  return model ? `${model.providerID}/${model.id}/${model.variant ?? ""}` : ""
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
    acceptance: proposal.acceptance.map((item) => ({
      id: safeText(item.id, stats, 120),
      assertion: safeText(item.assertion, stats),
      evidence: item.evidence.map((evidence) =>
        evidence.kind === "verification"
          ? { kind: "verification", verificationID: safeText(evidence.verificationID, stats) }
          : evidence.kind === "artifact"
            ? { kind: "artifact", reference: safeText(evidence.reference, stats) }
            : { kind: "human", decision: safeText(evidence.decision, stats) },
      ),
    })),
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
      timeoutMs: item.timeoutMs,
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
      if (entry?.type === "text" && typeof entry.text === "string") output.push(entry.text)
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

function messageEvents(
  rawMessages: ReadonlyArray<SessionMessage.Info>,
  attempt: AttemptRow,
  session: TrajectorySession,
  stats: PrivacyStats,
) {
  const events: Record<string, unknown>[] = []
  const base = (id: string, at: number | null, kind: string) => ({
    id: safeText(id, stats, 256),
    at,
    attemptID: safeText(attempt.id, stats, 128),
    sessionID: safeText(session.id, stats, 128),
    kind,
  })
  const add = (event: Record<string, unknown>) => events.push(event)

  const messages = rawMessages.slice(0, MAX_CONTEXT_MESSAGES)
  if (rawMessages.length > messages.length) stats.truncated++
  for (const [index, raw] of messages.entries()) {
    const message = object(raw)
    if (!message || typeof message.type !== "string") {
      stats.omittedUnsupportedParts++
      continue
    }
    const messageID = typeof message.id === "string" ? message.id : `unknown-${index}`
    const createdAt = dateMillis(object(message.time)?.created)
    if (message.type === "user" || message.type === "synthetic") {
      if (typeof message.text === "string")
        add({
          ...base(`${messageID}:text`, createdAt, message.type),
          text: safeText(message.text, stats),
        })
      if (Array.isArray(message.files)) stats.omittedAttachments += message.files.length
      continue
    }
    if (message.type === "assistant") {
      const model = modelView(message.model, stats)
      const parts = Array.isArray(message.content) ? message.content : []
      for (const [partIndex, rawPart] of parts.entries()) {
        const part = object(rawPart)
        if (!part || typeof part.type !== "string") {
          stats.omittedUnsupportedParts++
          continue
        }
        if (part.type === "reasoning") {
          stats.omittedReasoning++
          continue
        }
        if (part.type === "text") {
          if (typeof part.text === "string")
            add({
              ...base(`${messageID}:text:${partIndex}`, createdAt, "assistant-text"),
              model,
              text: safeText(part.text, stats),
            })
          else stats.omittedUnsupportedParts++
          continue
        }
        if (part.type !== "tool") {
          stats.omittedUnsupportedParts++
          continue
        }
        const toolState = object(part.state)
        const status = typeof toolState?.status === "string" ? toolState.status : "unsupported"
        if (!toolState || !["streaming", "running", "completed", "error"].includes(status))
          stats.omittedUnsupportedParts++
        const input = toolState?.input
        const inputView =
          typeof input === "string" ? safeText(input, stats) : safeValue(input, stats)
        const toolTime = object(part.time)
        const ranAt = dateMillis(toolTime?.ran) ?? createdAt
        const completedAt = dateMillis(toolTime?.completed)
        const content =
          status === "completed" || status === "error"
            ? safeToolContent(toolState?.content, stats)
            : ""
        const error = status === "error" ? safeErrorView(toolState?.error, stats) : null
        add({
          ...base(
            `${messageID}:tool:${typeof part.id === "string" ? part.id : partIndex}`,
            ranAt,
            "tool",
          ),
          model,
          tool: typeof part.name === "string" ? safeText(part.name, stats, 160) : "[unknown tool]",
          status: ["streaming", "running", "completed", "error"].includes(status)
            ? status
            : "unsupported",
          input: inputView,
          result: content,
          ...(error ? { error } : {}),
          completedAt,
        })
      }
      if (message.retry) {
        const retry = object(message.retry)
        if (retry) {
          add({
            ...base(
              `${messageID}:provider-retry`,
              dateMillis(retry.at) ?? createdAt,
              "provider-retry",
            ),
            attempt: asNumber(retry.attempt),
            error: safeErrorView(retry.error, stats),
          })
        }
      }
      if (message.error) {
        add({
          ...base(`${messageID}:error`, createdAt, "assistant-error"),
          error: safeErrorView(message.error, stats),
        })
      }
      continue
    }
    if (message.type === "shell") {
      const output = object(message.output)
      add({
        ...base(messageID, createdAt, "shell"),
        command: typeof message.command === "string" ? safeText(message.command, stats) : "",
        status:
          typeof message.status === "string" ? safeText(message.status, stats, 80) : "unknown",
        exit: asNumber(message.exit),
        output: typeof output?.output === "string" ? safeText(output.output, stats) : "",
        outputTruncated: output?.truncated === true,
        completedAt: dateMillis(object(message.time)?.completed),
      })
      if (output?.truncated === true) stats.truncated++
      continue
    }
    if (message.type === "compaction") {
      stats.compacted++
      const status = message.status
      const failed = status === "failed"
      add({
        ...base(messageID, createdAt, "compaction"),
        status: ["running", "completed", "failed"].includes(String(status)) ? status : "unknown",
        reason:
          message.reason === "auto" || message.reason === "manual" ? message.reason : "unknown",
        ...(failed ? { error: safeErrorView(message.error, stats) } : {}),
        summary: "[omitted: compaction summary and replay data are private]",
      })
      continue
    }
    if (message.type === "idle") {
      add({
        ...base(messageID, createdAt, "session-idle"),
        outcome: ["succeeded", "failed", "interrupted"].includes(String(message.outcome))
          ? message.outcome
          : "unknown",
        error: safeErrorView(message.error, stats),
      })
      continue
    }
    if (message.type === "model-switched") {
      add({
        ...base(messageID, createdAt, "model-switched"),
        model: modelView(message.model, stats),
        previous: modelView(message.previous, stats),
      })
      continue
    }
    if (message.type === "agent-switched") {
      add({
        ...base(messageID, createdAt, "agent-switched"),
        agent: typeof message.agent === "string" ? safeText(message.agent, stats, 120) : null,
        previous:
          typeof message.previous === "string" ? safeText(message.previous, stats, 120) : null,
      })
      continue
    }
    if (message.type === "location-switched") {
      add({ ...base(messageID, createdAt, "location-switched"), location: "[path omitted]" })
      continue
    }
    if (message.type === "system" || message.type === "skill") {
      stats.omittedSystem++
      continue
    }
    stats.omittedUnsupportedParts++
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
      : exitCode === 0 && timedOut === false && unchanged === true
        ? "passed"
        : exitCode !== null || timedOut === true || unchanged === false
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
  const rows = store.atomic((db) =>
    db
      .query<PlanRow, [string]>(
        "SELECT * FROM runner_plans WHERE project_directory=? ORDER BY rowid",
      )
      .all(directory),
  )
  const output: PlanSnapshot[] = []
  for (const row of rows) {
    const node = store.nodes(row.id).find((item) => item.task_id === task.id)
    if (!node) continue
    const attempts = store.attempts(row.id).filter((item) => item.task_id === task.id)
    const effects = store
      .effects(row.id)
      .filter(
        (item) => item.task_id === task.id || (item.task_id === null && item.attempt_id === null),
      )
    const transitions = store.atomic((db) =>
      db
        .query<TransitionRow, [string, string]>(
          "SELECT id,plan_id,task_id,version,event,payload,created_at FROM runner_transitions WHERE plan_id=? AND task_id=? ORDER BY id",
        )
        .all(row.id, task.id),
    )
    output.push({ row, node, input: rawPlanInput(row), attempts, effects, transitions })
  }
  return output
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
) {
  const stats = privacyStats()
  let task: TaskSpec | undefined
  if (input.taskID) task = store.repository.get(input.taskID)
  if (
    task &&
    (task.provenance.projectID !== projectID ||
      task.provenance.projectDirectory !== store.repository.projectDirectory)
  )
    throw new Error("Task is not owned by this project")

  let rawPlans = task ? snapshots(store, task) : []
  if (input.attemptID) {
    const matching = rawPlans
      .flatMap((snapshot) => snapshot.attempts.map((attempt) => ({ snapshot, attempt })))
      .find(({ attempt }) => attempt.id === input.attemptID)
    if (!matching) {
      const projectPlans = store.atomic((db) =>
        db
          .query<PlanRow, [string]>(
            "SELECT * FROM runner_plans WHERE project_directory=? ORDER BY rowid",
          )
          .all(store.repository.projectDirectory),
      )
      for (const row of projectPlans) {
        for (const attempt of store.attempts(row.id)) {
          if (attempt.id !== input.attemptID) continue
          const found = store.repository.get(attempt.task_id)
          if (
            found &&
            found.provenance.projectID === projectID &&
            found.provenance.projectDirectory === store.repository.projectDirectory
          )
            task = found
        }
      }
      if (!task) throw new Error("No project-owned attempt found")
      rawPlans = snapshots(store, task)
    }
  }
  if (!task)
    throw new Error(
      input.taskID ? "Task is not owned by this project" : "No project-owned attempt found",
    )
  if (
    input.attemptID &&
    !rawPlans.some((snapshot) =>
      snapshot.attempts.some((attempt) => attempt.id === input.attemptID),
    )
  )
    throw new Error("No project-owned attempt found")

  const allAttempts = rawPlans.flatMap((snapshot) =>
    snapshot.attempts.map((attempt) => ({ attempt, snapshot })),
  )
  const progressRows = store.progressFacts(allAttempts.map(({ attempt }) => attempt.id))
  const progressTruncated = progressRows.length > 10_000
  const visibleProgressRows = progressTruncated ? progressRows.slice(-10_000) : progressRows
  const sessions = new Map<string, TrajectorySession | null>()
  const sessionErrors = new Map<string, string>()
  const statuses = new Map<string, "available" | "missing" | "unavailable">()
  for (const { attempt } of allAttempts) {
    try {
      const session = await host.session(attempt.session_id)
      if (session && (session.id !== attempt.session_id || session.projectID !== projectID))
        throw new TrajectoryIdentityError()
      sessions.set(attempt.id, session)
      statuses.set(attempt.id, session ? "available" : "missing")
      if (session?.messageStatus === "unavailable" && session.messageError)
        sessionErrors.set(attempt.id, session.messageError)
    } catch (error) {
      if (error instanceof TrajectoryIdentityError) throw error
      sessions.set(attempt.id, null)
      statuses.set(attempt.id, "unavailable")
      sessionErrors.set(attempt.id, safeError(error, stats))
    }
  }

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
      const session = sessions.get(attempt.id) ?? null
      if (session?.messages && statuses.get(attempt.id) === "available")
        rawEvents.push(...messageEvents(session.messages, attempt, session, stats))
    }
  }
  rawEvents.push(...visibleProgressRows.map(projectProgressFact))
  rawEvents.sort((a, b) => {
    const left = typeof a.at === "number" ? a.at : Number.MAX_SAFE_INTEGER
    const right = typeof b.at === "number" ? b.at : Number.MAX_SAFE_INTEGER
    return left - right || String(a.id).localeCompare(String(b.id))
  })

  const targetScope = input.taskID ? `task:${input.taskID}` : `attempt:${input.attemptID}`
  const visibleEvents = input.attemptID
    ? rawEvents.filter((event) => event.attemptID === input.attemptID || event.attemptID === null)
    : rawEvents
  const focusedTaskPlans = rawPlans.map((snapshot) => ({
    id: safeText(snapshot.row.id, stats, 128),
    revision: snapshot.row.revision,
    state: safeText(snapshot.row.state, stats, 80),
    version: snapshot.row.version,
    reason: snapshot.row.reason === null ? null : safeText(snapshot.row.reason, stats),
    objective: snapshot.input ? safeText(snapshot.input.objective, stats) : null,
    baseCommit: snapshot.input ? safeText(snapshot.input.baseCommit, stats, 128) : null,
    resultCommit: snapshot.row.artifact ? safeText(snapshot.row.artifact, stats, 128) : null,
    admittedModel:
      modelView(parseObject(snapshot.row.model), stats) ??
      modelView(snapshot.input?.workerModel, stats),
    taskState: safeText(snapshot.node.state, stats, 80),
    accepted: snapshot.node.state === "accepted" || snapshot.node.state === "incorporated",
    taskResultCommit: snapshot.node.artifact ? safeText(snapshot.node.artifact, stats, 128) : null,
    waitingOn: store.execution(task.id)?.waitingOn.map((id) => safeText(id, stats, 128)) ?? [],
    acceptance: (snapshot.input?.acceptance ?? []).map((item) => ({
      id: safeText(item.id, stats, 120),
      assertion: safeText(item.assertion, stats),
      evidence: item.evidence.map((evidence) =>
        evidence.kind === "verification"
          ? { kind: "verification", verificationID: safeText(evidence.verificationID, stats) }
          : evidence.kind === "artifact"
            ? { kind: "artifact", reference: safeText(evidence.reference, stats) }
            : { kind: "human", decision: safeText(evidence.decision, stats) },
      ),
    })),
    checks: checksByPlan.get(snapshot.row.id) ?? [],
  }))

  const attemptViews = allAttempts.map(({ attempt, snapshot }) =>
    attemptView(
      attempt,
      snapshot,
      sessions.get(attempt.id) ?? null,
      statuses.get(attempt.id) ?? "missing",
      sessionErrors.get(attempt.id) ?? null,
      stats,
      allChecks,
    ),
  )
  const totals = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
  let knownSessions = 0
  const unknownUsageAttempts: string[] = []
  const seenSessions = new Set<string>()
  for (const { attempt } of allAttempts) {
    if (seenSessions.has(attempt.session_id)) continue
    seenSessions.add(attempt.session_id)
    const snapshot = usage(sessions.get(attempt.id) ?? null)
    if (!snapshot) {
      unknownUsageAttempts.push(safeText(attempt.id, stats, 128))
      continue
    }
    totals.uncachedInput += snapshot.uncachedInput
    totals.cacheRead += snapshot.cacheRead
    totals.cacheWrite += snapshot.cacheWrite
    totals.output += snapshot.output
    totals.reasoning += snapshot.reasoning
    knownSessions++
  }
  const recordedCosts = allAttempts
    .map(({ attempt }) => numberOrNull(attempt.cost))
    .filter((value): value is number => value !== null)
  const missingCostAttempts = allAttempts
    .filter(({ attempt }) => numberOrNull(attempt.cost) === null)
    .map(({ attempt }) => safeText(attempt.id, stats, 128))
  const acceptedTransitions = rawPlans
    .flatMap((snapshot) => snapshot.transitions)
    .filter((event) => event.event === "ACCEPT")
  const acceptedAt = acceptedTransitions.length
    ? Math.min(...acceptedTransitions.map((event) => event.created_at))
    : null
  const firstAttemptAt = allAttempts.length
    ? Math.min(...allAttempts.map(({ attempt }) => attempt.started_at))
    : null
  const taskAccepted = rawPlans.some(
    (snapshot) => snapshot.node.state === "accepted" || snapshot.node.state === "incorporated",
  )
  const wallClockSpanMs =
    firstAttemptAt !== null && acceptedAt !== null && acceptedAt >= firstAttemptAt
      ? acceptedAt - firstAttemptAt
      : null
  const focusedAttempts = input.attemptID
    ? attemptViews.filter((attempt) => attempt.id === input.attemptID)
    : attemptViews
  const observedModels = new Map<string, NonNullable<ReturnType<typeof modelView>>>()
  for (const attempt of attemptViews) {
    for (const model of [
      attempt.admittedModel,
      attempt.observedCurrentModel,
      ...attempt.observedMessageModels,
    ])
      if (model) observedModels.set(modelKey(model), model)
  }
  const busy = allAttempts.some(({ attempt }) => {
    const session = sessions.get(attempt.id)
    return ACTIVE_ATTEMPTS.has(attempt.state) || session?.busy === true
  })
  const messagesUnavailable = allAttempts.filter(
    ({ attempt }) =>
      statuses.get(attempt.id) === "unavailable" ||
      sessions.get(attempt.id)?.messageStatus === "unavailable",
  ).length
  const messageSessions = allAttempts.filter(
    ({ attempt }) => sessions.get(attempt.id)?.messages,
  ).length
  const redactedSource = {
    targetScope,
    task,
    plans: rawPlans,
    sessions: [...sessions.entries()],
    sessionErrors: [...sessionErrors.entries()],
    events: rawEvents,
  }
  // The raw-source fingerprint is kept inside the continuation token; key it
  // so the token cannot be used as an offline oracle for private source values.
  const snapshotHash = hashSource(redactedSource, cursorSecret)

  const summary = {
    schemaVersion: 1,
    task: {
      id: safeText(task.id, stats, 128),
      revision: task.revision,
      status: safeText(task.status, stats, 80),
      createdAt: safeText(task.createdAt, stats, 128),
      projectID: safeText(task.provenance.projectID, stats, 128),
      sourceCommit:
        task.provenance.startingRevision.kind === "git"
          ? safeText(task.provenance.startingRevision.commit, stats, 128)
          : null,
      specification: safeSpec(task, stats),
    },
    plans: focusedTaskPlans,
    focusedAttemptID: input.attemptID ? safeText(input.attemptID, stats, 128) : null,
    attempts: focusedAttempts,
    effort: {
      accepted: taskAccepted,
      ongoing: busy,
      firstAttemptAt,
      acceptedAt,
      wallClockSpanMs,
      wallClockBasis:
        "earliest runner attempt start to the task ACCEPT transition; not model-active time",
      tokenUsage: {
        measuredSubtotal: totals,
        total: unknownUsageAttempts.length === 0 ? totals : null,
        unit: "tokens",
        components: {
          uncachedInput: "OpenCode input; cache is reported separately",
          cacheRead: "OpenCode cache-read tokens",
          cacheWrite: "OpenCode cache-write tokens",
          output: "OpenCode output; reasoning is reported separately",
          reasoning: "OpenCode reasoning tokens",
        },
        source:
          "One cumulative OpenCode session snapshot per unique worker session; never sum message or page snapshots",
        knownSessions,
        totalSessions: seenSessions.size,
        unknownAttempts: unknownUsageAttempts,
        legacyAttemptScalarsNotAdded: attemptViews.map((attempt) => ({
          attemptID: attempt.id,
          ...attempt.legacyTokenCount,
        })),
      },
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
        workerAttemptSubtotalUsd: recordedCosts.reduce((total, value) => total + value, 0),
        workerScope: "LAZERS attempt rows only",
        provenance:
          "Legacy runner scalar; source model, price date, and billing basis are not persisted",
        unknownContributions: missingCostAttempts,
        apiEquivalentTotalUsd: null,
        apiEquivalentStatus:
          "unknown; recorded subscription/session zero is not an API-equivalent estimate",
      },
    },
    coverage: {
      sessionRead: "OpenCode session.get followed by session.context",
      transcript:
        "Only messages returned by session.context; plugin context does not expose client.message.list",
      availableSessionContexts: messageSessions,
      unavailableSessionContexts: messagesUnavailable,
      fullSessionHistory: "not guaranteed; use explicit warnings and do not infer omitted history",
      compacted: stats.compacted > 0,
      ongoing: busy,
      attemptsWithoutRecordedSessions: attemptViews.filter(
        (attempt) => attempt.sessionStatus !== "available",
      ).length,
      workerProgress: {
        facts: visibleProgressRows.length,
        truncated: progressTruncated,
        commentary: visibleProgressRows.filter((row) => row.kind === "commentary").length,
        automaticFacts: visibleProgressRows.filter((row) => row.kind !== "commentary").length,
        recoveryGaps: visibleProgressRows.filter((row) => row.kind === "gap").length,
        additiveStepMeasurements: visibleProgressRows.filter((row) => row.kind === "step").length,
        cumulativeUsageSnapshots: visibleProgressRows.filter((row) => row.kind === "usage-snapshot")
          .length,
      },
    },
    privacy: {
      redactedValues: stats.redacted,
      truncatedValues: stats.truncated,
      omittedUnknownParts: stats.omittedUnsupportedParts,
      omittedAttachments: stats.omittedAttachments,
      omittedReasoning: stats.omittedReasoning,
      omittedSystemOrSkillMessages: stats.omittedSystem,
      warnings: [
        "Credential detection covers common formats and sensitive key names; arbitrary prose secrets may evade pattern detection.",
        "System instructions, reasoning, metadata, provider-native/replay data, attachment/file bodies, and raw response bodies are not exported.",
        "Compaction summaries are omitted; the returned session.context may not contain the full history.",
      ],
    },
  }

  const filterHash = hashSource({ targetScope, limit: input.limit })
  const snapshot = hashSource({ hash: snapshotHash, summary, events: visibleEvents })
  let offset = 0
  if (input.cursor) {
    const cursor = readCursor(cursorSecret, input.cursor)
    if (cursor.scope !== filterHash || cursor.snapshot !== snapshot || cursor.limit !== input.limit)
      throw new Error("Stale trajectory cursor; restart from the first page")
    offset = cursor.offset
  }
  if (offset > visibleEvents.length) throw new Error("Invalid or stale trajectory cursor")
  const page = visibleEvents.slice(offset, offset + input.limit)
  const nextOffset = offset + page.length
  const nextCursor =
    nextOffset < visibleEvents.length
      ? makeCursor(cursorSecret, {
          v: 1,
          offset: nextOffset,
          snapshot,
          scope: filterHash,
          limit: input.limit,
        })
      : null
  return {
    ...summary,
    trajectory: {
      order: "timestamp-ascending then stable event ID",
      page: Math.floor(offset / input.limit) + 1,
      limit: input.limit,
      totalEvents: visibleEvents.length,
      events: page,
      nextCursor,
      hasMore: nextCursor !== null,
    },
  }
}
