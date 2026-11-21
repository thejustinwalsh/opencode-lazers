import { sameProject } from "../project-key.ts"
import { isTakeoverAttempt, openConcerns } from "../recovery/detector.ts"
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import type { TaskSpec } from "../task.ts"
import type { AttemptRow, EffectRow, NodeRow, PlanRow, RunnerStore } from "../runner/store.ts"
import { PlanInput } from "../runner/schema.ts"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { InspectTrajectoryInput } from "./schema.ts"
import { TrajectoryIdentityError } from "./native.ts"
import { MAX_CONTEXT_MESSAGES, type TrajectoryHost, type TrajectorySession } from "./native.ts"
import { privacyStats, safeError, safeText } from "./privacy.ts"
import type { PrivacyStats } from "./privacy.ts"
import { projectProgressFact } from "../progress/projection.ts"
import { projectTaskEffortBasis } from "./accounting.ts"
import type { AccountingRoute } from "./accounting.ts"
import { unavailableTaskValuation } from "../models/task-valuation.ts"
import type { TaskValuationProvider } from "../models/task-valuation.ts"
import type { TrajectoryMarketEquivalentCost } from "../models/task-valuation-schema.ts"
import type { ProjectTaskValuationRequest } from "../models/valuation.ts"
import { planIs } from "../runner/identity-read.ts"
import { effectEvents, transitionEvent, type CheckView, type TransitionRow } from "./events.ts"
import { dateMillis } from "../transcript-meta/step.ts"
import {
  messageSliceEvents,
  modelIdentities,
  modelView,
  object,
  type MessageContext,
} from "./message-events.ts"
import type { TranscriptRouteRow } from "../transcript-meta/schema.ts"

type PlanSnapshot = {
  row: PlanRow
  node: NodeRow
  input: PlanInput | null
  attempts: AttemptRow[]
  effects: EffectRow[]
  transitions: TransitionRow[]
}

const ACTIVE_ATTEMPTS = new Set(["preparing", "running", "verifying"])

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    return object(JSON.parse(text))
  } catch {
    return null
  }
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

function frozenPersona(policy: Record<string, unknown> | null) {
  const value = policy?.persona
  return value === "ui" || value === "systems" || value === "small-refactoring" ? value : null
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

/** What one attempt's transcript contributes to a report, folded a page at a time. */
type MessageFold = {
  events: Record<string, unknown>[]
  models: NonNullable<ReturnType<typeof modelView>>[]
  routes: Array<{ messageID: string; route: AccountingRoute; observedAt: number | null }>
  /** Messages seen, up to one past the transcript bound. */
  count: number
  /** Digest of the raw messages: binds a continuation cursor to the transcript without holding it. */
  digest: string
}

/**
 * One accumulator per fold over a transcript (events, models seen, step routes, digest), fed a
 * page at a time so the report holds one page of messages, never the transcript. Events and
 * routes cover the first MAX_CONTEXT_MESSAGES messages; models cover every message read.
 */
function messageFold(attempt: AttemptRow, stats: PrivacyStats) {
  const events: Record<string, unknown>[] = []
  const ctx: MessageContext = {
    stats,
    base: (id, at, kind) => ({
      id: safeText(id, stats, 256),
      at,
      attemptID: safeText(attempt.id, stats, 128),
      sessionID: safeText(attempt.session_id, stats, 128),
      kind,
    }),
    add: (event) => events.push(event),
  }
  const models = new Map<string, NonNullable<ReturnType<typeof modelView>>>()
  const routes: MessageFold["routes"] = []
  const digest = createHash("sha256")
  let index = 0
  let fed = false
  return {
    /** True once a page (possibly empty) has been given: the transcript was read. */
    get fed() {
      return fed
    },
    page(page: ReadonlyArray<SessionMessage.Info>) {
      fed = true
      for (const raw of page) {
        const message = object(raw)
        digest.update(JSON.stringify(raw) ?? "null")
        if (message?.type === "assistant") {
          const model = modelView(message.model, stats)
          if (model) models.set(modelKey(model), model)
        }
        if (index < MAX_CONTEXT_MESSAGES) {
          if (message?.type === "assistant") {
            const route = accountingRoute(modelView(message.model, stats))
            const id = typeof message.id === "string" ? safeText(message.id, stats, 200) : null
            if (route && id)
              routes.push({
                messageID: id,
                route,
                observedAt: dateMillis(object(message.time)?.created),
              })
          }
          if (!message || typeof message.type !== "string") stats.omittedUnsupportedParts++
          else
            messageSliceEvents(ctx, {
              message,
              messageID: typeof message.id === "string" ? message.id : `unknown-${index}`,
              createdAt: dateMillis(object(message.time)?.created),
            })
        }
        index++
      }
    },
    finish(): MessageFold {
      if (index > MAX_CONTEXT_MESSAGES) stats.truncated++
      return {
        events,
        models: [...models.values()],
        routes,
        count: index,
        digest: digest.digest("hex"),
      }
    },
  }
}

/**
 * What a transcript contributes to the effort, from the stored step rows (`transcript_steps`,
 * below the transcript bound, in transcript order) and the stored message count: the same routes
 * and count `messageFold` folds from the host's pages. Events, models and the digest are the
 * report's alone; the effort reads none of them.
 */
function storedMessageFold(transcript: StoredTranscript, stats: PrivacyStats): MessageFold {
  const routes: MessageFold["routes"] = []
  for (const row of transcript.routes) {
    const model =
      row.provider_id !== null && row.model_id !== null
        ? modelView(
            {
              providerID: row.provider_id,
              id: row.model_id,
              ...(row.variant !== null ? { variant: row.variant } : {}),
            },
            stats,
          )
        : null
    const route = accountingRoute(model)
    const id = safeText(row.message_id, stats, 200)
    if (route && id) routes.push({ messageID: id, route, observedAt: row.created_at })
  }
  return { events: [], models: [], routes, count: transcript.messageCount, digest: "" }
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
          `SELECT id,plan_id,task_id,version,event,payload,created_at FROM runner_transitions WHERE ${planIs(db, "runner_transitions")} AND task_id=? ORDER BY id`,
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

function modelFromPolicy(policy: string, stats: PrivacyStats) {
  const data = parseObject(policy)
  return modelView(data?.model, stats)
}

function legacyTokenCountView(attempt: AttemptRow) {
  const value = numberOrNull(attempt.token_count)
  return {
    value,
    source: "runner_attempt.token_count scalar; not added to categorized session totals",
    status: value === null ? ("missing" as const) : ("legacy-aggregate" as const),
  }
}

/** What the effort view reads of an attempt's view: its id, takeover mark and legacy scalar. */
type EffortAttemptView = {
  id: string
  takeover?: { agent: "architect" }
  legacyTokenCount: ReturnType<typeof legacyTokenCountView>
}

function attemptView(
  attempt: AttemptRow,
  snapshot: PlanSnapshot,
  session: TrajectorySession | null,
  messageModels: NonNullable<ReturnType<typeof modelView>>[],
  sessionStatus: "available" | "missing" | "unavailable",
  sessionError: string | null,
  stats: PrivacyStats,
  checks: CheckView[],
  concern?: { line: string; action?: string; because?: string },
) {
  const admitted =
    modelFromPolicy(attempt.policy, stats) ?? modelView(parseObject(snapshot.row.model), stats)
  const observed = session ? modelView(session.model, stats) : null
  const uniqueModels = new Map<string, NonNullable<typeof observed>>()
  for (const model of [...messageModels, ...(observed ? [observed] : [])])
    uniqueModels.set(modelKey(model), model)
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
    legacyTokenCount: legacyTokenCountView(attempt),
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
  /** Sessions as read; a transcript is never kept here, only folded into `folds`. */
  sessions: Map<string, TrajectorySession | null>
  /** Per attempt, what its transcript contributes, when the transcript was read. */
  folds: Map<string, MessageFold>
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

  const reads: SessionReads = {
    sessions: new Map(),
    folds: new Map(),
    errors: new Map(),
    statuses: new Map(),
  }
  const sessionsByAssignment = new Map<string, Promise<TrajectorySession | null>>()
  for (const { attempt } of allAttempts) {
    // An Architect takeover has no native worker session to read; nothing is missing.
    if (isTakeoverAttempt(attempt.policy)) continue
    try {
      const sessionKey = JSON.stringify([attempt.session_id, attempt.id, attempt.workspace])
      let read = sessionsByAssignment.get(sessionKey)
      // The host hands the transcript to the fold page by page; this attempt's fold sees it once.
      const fold = options.includeMessages === false ? undefined : messageFold(attempt, stats)
      if (!read) {
        const sessionID = attempt.session_id
        read =
          options.includeMessages === false
            ? statusReader!(sessionID, attempt)
            : host.session(sessionID, attempt, fold!.page)
        sessionsByAssignment.set(sessionKey, read)
      }
      const session = await read
      if (session && (session.id !== attempt.session_id || session.projectID !== projectID))
        throw new TrajectoryIdentityError()
      // A host that returns the transcript whole (a fixture, an older host) feeds the same fold.
      if (session?.messages && fold) fold.page(session.messages)
      if (session && fold?.fed && session.messageStatus === "available")
        reads.folds.set(attempt.id, fold.finish())
      reads.sessions.set(attempt.id, session?.messages ? { ...session, messages: null } : session)
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
      const fold = reads.folds.get(attempt.id)
      if (
        options.includeMessages !== false &&
        fold &&
        reads.statuses.get(attempt.id) === "available"
      )
        rawEvents.push(...fold.events)
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
        const fold = reads.folds.get(attempt.id)
        return fold && fold.count > MAX_CONTEXT_MESSAGES
          ? [safeText(attempt.session_id, stats, 128)]
          : []
      }),
    ),
  ]
}

function valuationAttempt(
  { attempt, snapshot }: AttemptEntry,
  session: TrajectorySession | null,
  stepRoutes: MessageFold["routes"],
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
    stepRoutes,
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
  attemptViews: readonly EffortAttemptView[],
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
  reads: Pick<SessionReads, "sessions">,
  attemptViews: readonly EffortAttemptView[],
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

type ProgressCounts = {
  facts: number
  commentary: number
  gaps: number
  steps: number
  usageSnapshots: number
}

/**
 * Folds the newest progress rows a page at a time: each row is projected and counted, then
 * dropped, so the raw payloads of the window are never held together. The projected facts are
 * what the report keeps.
 */
function foldProgress(store: RunnerStore, attemptIDs: readonly string[], visible?: number) {
  const window = store.progressReportWindow(attemptIDs, visible)
  const counts: ProgressCounts = { facts: 0, commentary: 0, gaps: 0, steps: 0, usageSnapshots: 0 }
  const facts: Record<string, unknown>[] = []
  for (const page of window.pages)
    for (const row of page) {
      facts.push(projectProgressFact(row))
      counts.facts++
      if (row.kind === "commentary") counts.commentary++
      else if (row.kind === "gap") counts.gaps++
      else if (row.kind === "step") counts.steps++
      else if (row.kind === "usage-snapshot") counts.usageSnapshots++
    }
  return { facts, counts, truncated: window.truncated }
}

function coverageView(
  allAttempts: AttemptEntry[],
  reads: SessionReads,
  attemptViews: ReturnType<typeof attemptView>[],
  progress: ProgressCounts,
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
  const messageSessions = allAttempts.filter(({ attempt }) => reads.folds.has(attempt.id)).length
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
      facts: progress.facts,
      truncated: progressTruncated,
      commentary: progress.commentary,
      automaticFacts: progress.facts - progress.commentary,
      recoveryGaps: progress.gaps,
      additiveStepMeasurements: progress.steps,
      cumulativeUsageSnapshots: progress.usageSnapshots,
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
              sessions: [...reads.sessions.entries()].map(([id, session]) => [
                id,
                session,
                reads.folds.get(id)?.digest ?? null,
              ]),
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
 * The task's effort: usage and routes per unique worker session (`projectTaskEffortBasis`), the
 * market valuation of the same request (`marketEquivalentCostOf`) and the view the report shows.
 * The report and the stored effort (`effort-store.ts`) both compose it here, so they agree.
 */
async function composeTaskEffort(input: {
  rawPlans: PlanSnapshot[]
  allAttempts: AttemptEntry[]
  reads: SessionReads
  attemptViews: readonly EffortAttemptView[]
  progressFacts: Record<string, unknown>[]
  progressTruncated: boolean
  truncatedContextSessionIDs: string[]
  options: InspectOptions
  stats: PrivacyStats
}) {
  const { rawPlans, allAttempts, reads, stats } = input
  const valuationInput: ProjectTaskValuationRequest = {
    attempts: allAttempts
      .filter((entry) => !isTakeoverAttempt(entry.attempt.policy))
      .map((entry) =>
        valuationAttempt(
          entry,
          reads.sessions.get(entry.attempt.id) ?? null,
          reads.folds.get(entry.attempt.id)?.routes ?? [],
          reads.statuses.get(entry.attempt.id) ?? "missing",
          stats,
        ),
      ),
    progressFacts: input.progressFacts,
    progressTruncated: input.progressTruncated,
    truncatedContextSessionIDs: input.truncatedContextSessionIDs,
  }
  const taskEffortBasis = projectTaskEffortBasis(valuationInput)
  const marketEquivalentCost = await marketEquivalentCostOf(valuationInput, input.options)
  return effortView(
    rawPlans,
    allAttempts,
    reads,
    input.attemptViews,
    taskEffortBasis,
    marketEquivalentCost,
    stats,
  )
}

export type TaskEffort = Awaited<ReturnType<typeof composeTaskEffort>>["effort"]

/** A session's stored transcript metadata: its message count and its step routes below the bound. */
export type StoredTranscript = { messageCount: number; routes: Iterable<TranscriptRouteRow> }

/**
 * The effort of one project-owned task from stored facts only: the attempts and plans, every
 * retained progress row of its attempts (no window: nothing is truncated), the live session
 * facts the host session fold stored (`sessionOf`, one row per session; absent reads as a
 * missing session) and the transcript metadata the transcript fold stored (`transcriptOf`, read
 * only for a session whose context is `available`). No host read and no message text: the
 * composition equals the history capture's. Undefined when the task is gone or not this
 * project's.
 */
export async function inspectTaskEffort(
  store: RunnerStore,
  projectID: string,
  taskID: string,
  sessionOf: (sessionID: string) => TrajectorySession | null,
  options: {
    taskValuationProvider: TaskValuationProvider
    signal?: AbortSignal
    transcriptOf?: (sessionID: string, below: number) => StoredTranscript | undefined
  },
): Promise<{ effort: TaskEffort; busy: boolean } | undefined> {
  const stats = privacyStats()
  const task = store.repository.get(taskID)
  if (!task || !ownedByProject(task, store, projectID)) return undefined
  const rawPlans = snapshots(store, task)
  const allAttempts = rawPlans.flatMap((snapshot) =>
    snapshot.attempts.map((attempt) => ({ attempt, snapshot })),
  )
  const folded = foldProgress(
    store,
    allAttempts.map(({ attempt }) => attempt.id),
    Number.MAX_SAFE_INTEGER,
  )
  const reads: SessionReads = {
    sessions: new Map(),
    folds: new Map(),
    errors: new Map(),
    statuses: new Map(),
  }
  for (const { attempt } of allAttempts) {
    // An Architect takeover has no native worker session; nothing is missing.
    if (isTakeoverAttempt(attempt.policy)) continue
    const session = sessionOf(attempt.session_id)
    reads.sessions.set(attempt.id, session)
    reads.statuses.set(attempt.id, session ? "available" : "missing")
    if (session?.messageStatus !== "available") continue
    const transcript = options.transcriptOf?.(attempt.session_id, MAX_CONTEXT_MESSAGES)
    if (transcript) reads.folds.set(attempt.id, storedMessageFold(transcript, stats))
  }
  return composeTaskEffort({
    rawPlans,
    allAttempts,
    reads,
    attemptViews: allAttempts.map(({ attempt }) => ({
      id: safeText(attempt.id, stats, 128),
      ...(isTakeoverAttempt(attempt.policy) ? { takeover: { agent: "architect" as const } } : {}),
      legacyTokenCount: legacyTokenCountView(attempt),
    })),
    progressFacts: folded.facts,
    progressTruncated: folded.truncated,
    truncatedContextSessionIDs: truncatedContextSessions(allAttempts, reads, stats),
    options,
    stats,
  })
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
  const folded = foldProgress(
    store,
    allAttempts.map(({ attempt }) => attempt.id),
  )
  const progressTruncated = folded.truncated
  const reads = await readAttemptSessions(host, projectID, allAttempts, options, stats)

  const projectedProgressFacts = folded.facts
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
      reads.folds.get(attempt.id)?.models ?? [],
      reads.statuses.get(attempt.id) ?? "missing",
      reads.errors.get(attempt.id) ?? null,
      stats,
      allChecks,
      concerns.get(attempt.id),
    ),
  )
  const focusedAttempts = input.attemptID
    ? attemptViews.filter((attempt) => attempt.id === input.attemptID)
    : attemptViews
  const { effort, busy } = await composeTaskEffort({
    rawPlans,
    allAttempts,
    reads,
    attemptViews,
    progressFacts: projectedProgressFacts,
    progressTruncated,
    truncatedContextSessionIDs: truncatedContextSessions(allAttempts, reads, stats),
    options,
    stats,
  })
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
      folded.counts,
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
