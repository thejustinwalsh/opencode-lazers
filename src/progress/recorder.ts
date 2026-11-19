import { isWorkerAgent } from "../runner/worker-agent.ts"
import { isNativeInput } from "../runner/native-input.ts"
import { DateTime } from "effect"
import { createHash } from "node:crypto"
import type { Database } from "bun:sqlite"
import type { Tool } from "@opencode/schema/tool"
import { TaskSpecSchema } from "../task.ts"
import type { RunnerStore } from "../runner/store.ts"
import { privacyStats, safeError, safeText } from "../trajectory/privacy.ts"
import { publicProgressError, visibleProgressText } from "./privacy.ts"
import { ProgressInput, type NativeLineageRejection } from "./schema.ts"
import { observeFileTargets } from "./file-target.ts"
import { toolDetail } from "./tool-detail.ts"
import type { PathScope } from "./tool-detail.ts"
import { homedir } from "node:os"
import { sameProject } from "../project-key.ts"
import { sessionOwners, type SessionOwners } from "./session-owners.ts"

type ProgressSource =
  "tool-commentary" | "tool-hook" | "native-event" | "runtime" | "recovery" | "reminder"

type ProgressKind =
  | "commentary"
  | "tool"
  | "visible-text"
  | "step"
  | "usage-snapshot"
  | "provider-retry"
  | "execution-outcome"
  | "outcome-snapshot"
  | "shell"
  | "verification"
  | "artifact"
  | "gap"
  | "reminder"
  | "native-observation"

export type ProgressAssignment = {
  projectID: string
  taskID: string
  planID: string
  attemptID: string
  attemptState: string
  sessionID: string
  assignedMessageID: string
  workspace: string
}

export type ReminderOwnership = {
  lazersKind: "worker-progress-reminder"
  lazersAssignedMessageID?: string
  lazersProjectID: string
  lazersProjectDirectory: string
  lazersPlanID: string
  lazersTaskID: string
  lazersAttemptID: string
  lazersSessionID: string
  lazersMessageID: string
}

export type ReminderClaim = {
  attemptID: string
  sessionID: string
  messageID: string
  sequence: number
  attemptNumber: number
  ownership: ReminderOwnership
}

export type ReminderDelivery = "admitted" | "unknown" | "rejected"

type Fact = {
  source: ProgressSource
  sourceType?: string
  kind: ProgressKind
  dedupeKey: string
  at: number
  payload: Record<string, unknown>
  eventID?: string
  callID?: string
  messageID?: string
}

type ToolCall = {
  tool: string
  sessionID: string
  agent: string
  messageID: string
  callID: string
  status: "completed" | "error"
  result?: Tool.Result
  error?: unknown
  /** The call's input, read only to summarize it; never stored whole. */
  input?: unknown
}

/** The bounded one-line summary of a call, or nothing when its input says nothing worth showing. */
function detailField(
  call: { tool: string; input?: unknown },
  scope: PathScope,
): { detail?: string } {
  const detail = toolDetail(call.tool, call.input, scope)
  return detail === null ? {} : { detail }
}

export type ToolInvocation = {
  sessionID: string
  messageID: string
  agent: string
  tool: string
  identityKind: "native-call" | "local-invocation"
  invocationID: string
  nativeCallID: string | null
  parentCallID: string | null
  contextCallID: string
  localInvocationID: string | null
}

export type ToolCallRow = {
  project_directory: string
  project_id: string
  session_id: string
  identity_kind: ToolInvocation["identityKind"]
  invocation_id: string
  native_call_id: string | null
  parent_call_id: string | null
  context_call_id: string | null
  local_invocation_id: string | null
  message_id: string | null
  agent: string | null
  tool: string | null
  plan_id: string | null
  task_id: string | null
  attempt_id: string | null
  first_observed_at: number
  last_observed_at: number
  sources_json: string
  event_ids_json: string
  payload: string
}

type ToolFact = Omit<Fact, "source"> & { source: ProgressSource | "tool-wrapper" }

type JsonObject = Record<string, unknown>

type RecoveryFingerprintValue = null | boolean | number | string | RecoveryFingerprintValue[]

const MAX_RECONCILE_STATES = 256
/** One synchronous slice of reconcile work stays near this long before yielding. */
const RECONCILE_SLICE_MS = 20
const RECONCILE_CHUNK_MESSAGES = 25
/** Messages whose full content fingerprint is re-verified per run (rolling window). */
const RECONCILE_VERIFY_PER_RUN = 20
const RECONCILE_STAMP_VERSION = "m1"

type ReconciledStamp = { light: string; full?: string }

type SessionReconcileState = {
  assignmentFingerprint: string
  /** Durable per-message stamps (mirrors runner_progress_reconciled for this attempt). */
  stamps: Map<string, ReconciledStamp>
  verifyCursor: number
  gapsRecorded: boolean
  boundRecorded: boolean
}

type DirtyMessage = { raw: unknown; id: string; light: string | undefined; full?: string }

type TimingSource = "native-event" | "recovery" | "runtime"

type TimingEndpoint = {
  at: number
  source: TimingSource
  sourceType: string
  meaning: string
}

type ExecutionEvidence = {
  status: string
  source: string
  sourceType: string
  meaning: string
  phase: number
  conflict?: true
}

const EPOCH_MILLIS = "unix-epoch-ms" as const
const timingSourceRank: Record<string, number> = {
  "native-event": 3,
  recovery: 2,
  runtime: 2,
  "tool-hook": 1,
  "tool-wrapper": 1,
}

const object = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined

const targetOnlyTool = (value: unknown) => value === "read" || value === "edit" || value === "patch"

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

function dateMillis(value: unknown): number | undefined {
  let millis: number
  if (typeof value === "number" && Number.isFinite(value)) millis = value
  else {
    if (value === null || value === undefined) return undefined
    try {
      millis = DateTime.toEpochMillis(value as DateTime.DateTime)
    } catch {
      return undefined
    }
  }
  const integer = Math.trunc(millis)
  return Number.isSafeInteger(integer) ? integer : undefined
}

function timedEndpoint(
  value: unknown,
  source: TimingSource,
  sourceType: string,
  meaning: string,
): TimingEndpoint | undefined {
  const at = dateMillis(value)
  return at === undefined ? undefined : { at, source, sourceType, meaning }
}

function factTiming(endpoints: Record<string, TimingEndpoint | undefined>) {
  const present = Object.fromEntries(
    Object.entries(endpoints).filter((entry): entry is [string, TimingEndpoint] =>
      Boolean(entry[1]),
    ),
  )
  return Object.keys(present).length ? { unit: EPOCH_MILLIS, endpoints: present } : undefined
}

function visibleContent(
  value: unknown,
  stats: ReturnType<typeof privacyStats>,
): string | undefined {
  if (typeof value === "string") return visibleProgressText(value, stats)
  if (!Array.isArray(value)) return undefined
  const visible = value.flatMap((part) => {
    const entry = object(part)
    return entry?.type === "text" && typeof entry.text === "string" ? [entry.text] : []
  })
  return visible.length
    ? safeText(visible.map((part) => visibleProgressText(part, stats)).join("\n"), stats)
    : undefined
}

function errorView(value: unknown, stats: ReturnType<typeof privacyStats>) {
  return publicProgressError(value, stats)
}

function measuredUsage(value: unknown, costValue?: unknown) {
  const tokens = object(value)
  const cache = object(tokens?.cache)
  const cost = number(costValue)
  return {
    input: number(tokens?.input) ?? null,
    output: number(tokens?.output) ?? null,
    reasoning: number(tokens?.reasoning) ?? null,
    cacheRead: number(cache?.read) ?? null,
    cacheWrite: number(cache?.write) ?? null,
    costUSD: cost ?? null,
  }
}

function parseSources(textValue: string): ProgressSource[] {
  try {
    const parsed: unknown = JSON.parse(textValue)
    if (Array.isArray(parsed))
      return parsed.filter((source): source is ProgressSource => typeof source === "string")
  } catch {
    // Older or damaged rows still retain their original source column.
  }
  return []
}

function parseIDs(textValue: string): string[] {
  try {
    const parsed: unknown = JSON.parse(textValue)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

function mergeObjects(previous: JsonObject, incoming: JsonObject): JsonObject {
  const merged: JsonObject = { ...previous }
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === null) continue
    const old = merged[key]
    const oldObject = object(old)
    const nextObject = object(value)
    merged[key] = oldObject && nextObject ? mergeObjects(oldObject, nextObject) : value
  }
  return merged
}

const RECOVERY_TIME_FIELDS = new Set(["created", "streamed", "completed", "ran"])

function encodeEffectDateTime(value: object): RecoveryFingerprintValue | undefined {
  if (!DateTime.isDateTime(value)) return undefined
  const epochDescriptor = Object.getOwnPropertyDescriptor(value, "epochMilliseconds")
  if (
    !epochDescriptor ||
    !("value" in epochDescriptor) ||
    typeof epochDescriptor.value !== "number"
  )
    return undefined
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor)) return undefined
  }
  const normalizedMillis = dateMillis(value)
  if (normalizedMillis === undefined) return undefined

  return encodeRecoveryFingerprintValue(normalizedMillis, new Set())
}

function encodeRecoveryFingerprintValue(
  value: unknown,
  seen: Set<object>,
  timestampField = false,
  timestampContainer?: "time" | "retry",
): RecoveryFingerprintValue | undefined {
  if (value === null) return ["null"]
  if (value === undefined) return ["undefined"]
  if (typeof value === "string") return ["string", value]
  if (typeof value === "boolean") return ["boolean", value]
  if (typeof value === "number") {
    const encoded = Number.isNaN(value)
      ? "NaN"
      : value === Number.POSITIVE_INFINITY
        ? "Infinity"
        : value === Number.NEGATIVE_INFINITY
          ? "-Infinity"
          : Object.is(value, -0)
            ? "-0"
            : String(value)
    return ["number", encoded]
  }
  if (typeof value !== "object") return undefined
  if (seen.has(value)) return undefined

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const entries: RecoveryFingerprintValue[] = []
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor && (descriptor.get || descriptor.set)) return undefined
        const encoded = encodeRecoveryFingerprintValue(descriptor?.value, seen)
        if (encoded === undefined) return undefined
        entries.push(encoded)
      }
      return ["array", value.length, ...entries]
    }

    if (DateTime.isDateTime(value)) return timestampField ? encodeEffectDateTime(value) : undefined

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const entries: RecoveryFingerprintValue[] = []
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || descriptor.get || descriptor.set) return undefined
      const isTimestampField =
        (timestampContainer === "time" && RECOVERY_TIME_FIELDS.has(key)) ||
        (timestampContainer === "retry" && key === "at")
      const childContainer = key === "time" || key === "retry" ? key : undefined
      const encoded = encodeRecoveryFingerprintValue(
        descriptor.value,
        seen,
        isTimestampField,
        childContainer,
      )
      if (encoded === undefined) return undefined
      entries.push([key, descriptor.enumerable === true, encoded])
    }
    return ["object", prototype === null, ...entries]
  } finally {
    seen.delete(value)
  }
}

/** Full content fingerprint of one ordinary retained message; unusual objects return undefined. */
function messageFullFingerprint(message: unknown): string | undefined {
  try {
    const encoded = encodeRecoveryFingerprintValue(message, new Set())
    if (encoded === undefined) return undefined
    return createHash("sha256").update(JSON.stringify(encoded)).digest("hex")
  } catch {
    // Proxies and malformed retained data must retain the original recovery path.
    return undefined
  }
}

function shallowSignature(
  value: unknown,
  depth: number,
  out: string[],
  timestampField = false,
  timestampContainer?: "time" | "retry",
) {
  if (typeof value === "string") {
    out.push(
      value.length <= 24
        ? JSON.stringify(value)
        : `${value.length}:${value.slice(0, 12)}:${value.slice(-12)}`,
    )
  } else if (value === null || typeof value !== "object") {
    out.push(String(value))
  } else if (DateTime.isDateTime(value)) {
    // Zone presentation is not durable: stamp the same epoch millis the projection records.
    // Outside known timestamp fields a DateTime is unusual data and forces reprocessing.
    const encoded = timestampField ? encodeEffectDateTime(value) : undefined
    if (encoded === undefined) throw new Error("unsafe retained value")
    out.push(String(dateMillis(value)))
  } else if (depth <= 0) {
    out.push(Array.isArray(value) ? `[${value.length}]` : "{}")
  } else if (Array.isArray(value)) {
    out.push(`[${value.length}`)
    for (const item of value) shallowSignature(item, depth - 1, out)
    out.push("]")
  } else {
    const keys = Object.getOwnPropertyNames(value)
    out.push(`{${keys.join(",")}`)
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      // Never run user code: accessors keep the original full-reconciliation path.
      if (!descriptor || descriptor.get || descriptor.set) throw new Error("unsafe retained value")
      shallowSignature(
        descriptor.value,
        depth - 1,
        out,
        (timestampContainer === "time" && RECOVERY_TIME_FIELDS.has(key)) ||
          (timestampContainer === "retry" && key === "at"),
        key === "time" || key === "retry" ? key : undefined,
      )
    }
    out.push("}")
  }
}

/**
 * Cheap per-message change stamp: structure, stamps, string lengths and string edges.
 * No recursive tagged encode, JSON serialization of content or secret redaction; deterministic,
 * so it is persisted and survives restarts. Undefined means "always reprocess".
 */
export function messageLightSignature(message: unknown): string | undefined {
  try {
    const out: string[] = [RECONCILE_STAMP_VERSION]
    shallowSignature(message, 6, out)
    return createHash("sha256").update(out.join("|")).digest("hex")
  } catch {
    return undefined
  }
}

function recoveryAssignmentFingerprint(assignment: ProgressAssignment): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        assignment.projectID,
        assignment.taskID,
        assignment.planID,
        assignment.attemptID,
        assignment.sessionID,
        assignment.assignedMessageID,
        assignment.workspace,
      ]),
    )
    .digest("hex")
}

function routeEvidenceFromModel(
  value: unknown,
  stats: ReturnType<typeof privacyStats>,
): JsonObject {
  const model = object(value)
  if (!model) return { status: "identity-unavailable" }
  const providerID = text(model.providerID)
  const modelID = text(model.id) ?? text(model.modelID)
  const rawVariant = model.variant
  if (!providerID || !modelID) return { status: "identity-unavailable" }
  const invalidVariant =
    rawVariant !== undefined && rawVariant !== null && typeof rawVariant !== "string"

  let explicitIdentityLost = false
  if (Object.hasOwn(model, "identity")) {
    const identity = object(model.identity)
    if (
      !identity ||
      identity.providerID !== providerID ||
      identity.modelID !== modelID ||
      identity.variant !== (typeof rawVariant === "string" ? rawVariant : null)
    )
      explicitIdentityLost = true
  }

  const route = {
    providerID: safeText(providerID, stats, 200),
    modelID: safeText(modelID, stats, 300),
    variant: invalidVariant
      ? "[REDACTED]"
      : typeof rawVariant === "string"
        ? safeText(rawVariant, stats, 200)
        : null,
  }
  const sanitizedIdentityLost =
    route.providerID !== providerID ||
    route.modelID !== modelID ||
    (!invalidVariant && route.variant !== (typeof rawVariant === "string" ? rawVariant : null)) ||
    [route.providerID, route.modelID, route.variant].some(
      (part) => part?.endsWith("…[truncated]") || part?.includes("[REDACTED]"),
    )
  const identityLost = invalidVariant || explicitIdentityLost || sanitizedIdentityLost
  const retainedRoute = identityLost ? { ...route, identity: null } : route
  if (identityLost) return { status: "identity-unavailable", route: retainedRoute }
  return { status: "observed", route }
}

function mergeRouteEvidence(
  previousValue: unknown,
  incomingValue: unknown,
): JsonObject | undefined {
  const values = [previousValue, incomingValue].filter((value) => value !== undefined)
  if (!values.length) return undefined
  const identities = new Set<string>()
  let observed: JsonObject | undefined
  for (const value of values) {
    const evidence = object(value)
    if (evidence?.status !== "observed") return { status: "identity-unavailable" }
    const route = object(evidence.route)
    const providerID = text(route?.providerID)
    const modelID = text(route?.modelID)
    const variant = route?.variant
    if (
      !providerID ||
      !modelID ||
      (variant !== null && typeof variant !== "string") ||
      [providerID, modelID, variant].some(
        (part) =>
          typeof part === "string" &&
          (part.endsWith("…[truncated]") || part.includes("[REDACTED]")),
      )
    )
      return { status: "identity-unavailable" }
    identities.add(JSON.stringify([providerID, modelID, variant]))
    observed ??= { status: "observed", route: { providerID, modelID, variant } }
  }
  return identities.size === 1 ? observed : { status: "identity-unavailable" }
}

function routeEvidenceFromStoredRoute(value: unknown): JsonObject {
  const route = object(value)
  const providerID = text(route?.providerID)
  const modelID = text(route?.modelID) ?? text(route?.id)
  const variant = route?.variant
  if (!providerID || !modelID || (variant !== null && typeof variant !== "string"))
    return { status: "identity-unavailable" }
  if (route && Object.hasOwn(route, "identity")) {
    const identity = object(route.identity)
    if (
      !identity ||
      identity.providerID !== providerID ||
      identity.modelID !== modelID ||
      identity.variant !== (typeof variant === "string" ? variant : null)
    )
      return { status: "identity-unavailable" }
  }
  if (
    [providerID, modelID, variant].some(
      (part) =>
        typeof part === "string" && (part.endsWith("…[truncated]") || part.includes("[REDACTED]")),
    )
  )
    return { status: "identity-unavailable" }
  return {
    status: "observed",
    route: { providerID, modelID, variant: typeof variant === "string" ? variant : null },
  }
}

function payloadRouteEvidence(value: JsonObject): JsonObject | undefined {
  const assertions: unknown[] = []
  if (Object.hasOwn(value, "routeEvidence")) assertions.push(value.routeEvidence)
  if (Object.hasOwn(value, "route"))
    assertions.push(
      value.route === null
        ? { status: "identity-unavailable" }
        : routeEvidenceFromStoredRoute(value.route),
    )
  if (Array.isArray(value.observations))
    for (const raw of value.observations) {
      const observation = object(raw)
      if (!observation) continue
      if (Object.hasOwn(observation, "routeEvidence")) assertions.push(observation.routeEvidence)
      if (Object.hasOwn(observation, "route"))
        assertions.push(
          observation.route === null
            ? { status: "identity-unavailable" }
            : routeEvidenceFromStoredRoute(observation.route),
        )
    }
  return assertions.reduce<JsonObject | undefined>(
    (merged, assertion) => mergeRouteEvidence(merged, assertion),
    undefined,
  )
}

function setStepRouteEvidence(payload: JsonObject, routeEvidence: JsonObject | undefined): void {
  if (routeEvidence) {
    payload.routeEvidence = routeEvidence
    payload.route = routeEvidence.status === "observed" ? routeEvidence.route : null
  } else {
    delete payload.routeEvidence
  }
}

function normalizeStepRouteEvidence(payload: JsonObject): void {
  setStepRouteEvidence(payload, payloadRouteEvidence(payload))
}

function observationIdentity(item: JsonObject): string {
  return (
    text(item.eventID) ??
    text(item.observationID) ??
    `${text(item.source) ?? "unknown"}:${text(item.eventType) ?? "unknown"}:${number(item.at) ?? "unknown"}`
  )
}

function observationPhase(item: JsonObject): number {
  const explicit = number(item.phase)
  if (explicit !== undefined && Number.isInteger(explicit) && explicit >= 0) return explicit
  const eventType = text(item.eventType) ?? ""
  if (eventType === "session.tool.success" || eventType === "session.tool.failed") return 2
  if (eventType === "session.tool.called") return 1
  return 0
}

function preferObservation(kind: ProgressKind, previous: JsonObject, incoming: JsonObject) {
  const oldPriority = sourcePriority(previous)
  const nextPriority = sourcePriority(incoming)
  if (oldPriority !== nextPriority) return oldPriority > nextPriority ? previous : incoming

  const oldPhase = observationPhase(previous)
  const nextPhase = observationPhase(incoming)
  if (oldPhase !== nextPhase) return oldPhase > nextPhase ? previous : incoming

  const oldStatus = text(previous.status)
  const nextStatus = text(incoming.status)
  if (oldStatus && nextStatus) {
    const oldRank = statusRank(kind, oldStatus)
    const nextRank = statusRank(kind, nextStatus)
    if (oldRank !== nextRank) return oldRank > nextRank ? previous : incoming
    const terminalRank = kind === "tool" ? 3 : kind === "step" || kind === "shell" ? 2 : -1
    if (oldRank === terminalRank && oldStatus !== nextStatus) {
      if (oldStatus === "failed") return previous
      if (nextStatus === "failed") return incoming
    }
  }

  return JSON.stringify(previous).localeCompare(JSON.stringify(incoming)) <= 0 ? previous : incoming
}

function mergeObservations(previous: unknown, incoming: unknown, kind: ProgressKind): JsonObject[] {
  const values = [
    ...(Array.isArray(previous) ? previous : []),
    ...(Array.isArray(incoming) ? incoming : []),
  ]
  const unique = new Map<string, JsonObject>()
  for (const value of values) {
    const item = object(value)
    if (!item) continue
    const identity = observationIdentity(item)
    const prior = unique.get(identity)
    unique.set(identity, prior ? preferObservation(kind, prior, item) : item)
  }
  return [...unique.values()].slice(-25)
}

const toolStatusRank: Record<string, number> = {
  "input-started": 0,
  unknown: -1,
  "not-executed": 1,
  running: 2,
  succeeded: 3,
  failed: 3,
}

const stepStatusRank: Record<string, number> = {
  unknown: -1,
  started: 0,
  streamed: 1,
  ended: 2,
  failed: 2,
}

const shellStatusRank: Record<string, number> = {
  unknown: -1,
  running: 0,
  exited: 2,
  timeout: 2,
  killed: 2,
}

function statusRank(kind: ProgressKind, status: string) {
  if (kind === "tool") return toolStatusRank[status] ?? -1
  if (kind === "step") return stepStatusRank[status] ?? -1
  return shellStatusRank[status] ?? -1
}

function sourcePriority(value: unknown, fallback = "unknown") {
  const provenance = object(value)
  const source = text(provenance?.source) ?? fallback
  return timingSourceRank[source] ?? 0
}

function mergeStatus(
  kind: ProgressKind,
  previous: JsonObject,
  incoming: JsonObject,
): { status: string; provenance: JsonObject } | undefined {
  const oldStatus = text(previous.status)
  const nextStatus = text(incoming.status)
  if (!oldStatus && !nextStatus) return undefined
  if (!oldStatus)
    return {
      status: nextStatus!,
      provenance: object(incoming.statusProvenance) ?? {},
    }
  if (!nextStatus) return { status: oldStatus, provenance: object(previous.statusProvenance) ?? {} }

  const oldRank = statusRank(kind, oldStatus)
  const nextRank = statusRank(kind, nextStatus)
  if (oldRank > nextRank)
    return { status: oldStatus, provenance: object(previous.statusProvenance) ?? {} }
  if (nextRank > oldRank)
    return { status: nextStatus, provenance: object(incoming.statusProvenance) ?? {} }

  const oldProvenance = object(previous.statusProvenance) ?? {}
  const nextProvenance = object(incoming.statusProvenance) ?? {}
  const oldPriority = sourcePriority(oldProvenance)
  const nextPriority = sourcePriority(nextProvenance)
  if (oldPriority > nextPriority) return { status: oldStatus, provenance: oldProvenance }
  if (nextPriority > oldPriority) return { status: nextStatus, provenance: nextProvenance }
  if (oldStatus === nextStatus) {
    const oldSourceType = text(oldProvenance.sourceType) ?? ""
    const nextSourceType = text(nextProvenance.sourceType) ?? ""
    return oldSourceType.localeCompare(nextSourceType) <= 0
      ? { status: oldStatus, provenance: oldProvenance }
      : { status: nextStatus, provenance: nextProvenance }
  }
  // If equally authoritative terminal observations conflict, retain the
  // conservative failure without depending on which observation arrived last.
  const terminalRank = kind === "tool" ? 3 : 2
  if (oldRank === terminalRank && (oldStatus === "failed" || nextStatus === "failed"))
    return oldStatus === "failed"
      ? { status: oldStatus, provenance: oldProvenance }
      : { status: nextStatus, provenance: nextProvenance }
  return oldStatus.localeCompare(nextStatus) <= 0
    ? { status: oldStatus, provenance: oldProvenance }
    : { status: nextStatus, provenance: nextProvenance }
}

function mergeTiming(previousValue: unknown, incomingValue: unknown): JsonObject | undefined {
  const previous = object(previousValue)
  const incoming = object(incomingValue)
  const previousEndpoints = object(previous?.endpoints) ?? {}
  const incomingEndpoints = object(incoming?.endpoints) ?? {}
  const endpoints: JsonObject = { ...previousEndpoints }
  for (const [key, rawIncoming] of Object.entries(incomingEndpoints)) {
    const candidate = object(rawIncoming)
    const candidateAt = dateMillis(candidate?.at)
    if (
      !candidate ||
      candidateAt === undefined ||
      (candidate.source !== "native-event" &&
        candidate.source !== "recovery" &&
        candidate.source !== "runtime")
    )
      continue
    const normalized: JsonObject = { ...candidate, at: candidateAt }
    const existing = object(endpoints[key])
    const existingAt = dateMillis(existing?.at)
    if (!existing || existingAt === undefined) {
      endpoints[key] = normalized
      continue
    }
    const existingPriority = sourcePriority(existing)
    const candidatePriority = sourcePriority(normalized)
    if (candidatePriority > existingPriority) {
      endpoints[key] = normalized
      continue
    }
    if (candidatePriority < existingPriority) continue

    const starts = new Set([
      "startedAt",
      "inputAt",
      "calledAt",
      "ranAt",
      "createdAt",
      "scheduledAt",
    ])
    const preferredAt = starts.has(key)
      ? Math.min(existingAt, candidateAt)
      : Math.max(existingAt, candidateAt)
    if (preferredAt !== existingAt) {
      endpoints[key] = normalized
      continue
    }
    if (preferredAt !== candidateAt) continue
    const existingType = text(existing.sourceType) ?? ""
    const candidateType = text(normalized.sourceType) ?? ""
    if (candidateType.localeCompare(existingType) < 0) endpoints[key] = normalized
  }
  if (!Object.keys(endpoints).length) return undefined
  return { unit: EPOCH_MILLIS, endpoints }
}

function executionPhase(value: JsonObject, status: string | undefined, legacyConflict = false) {
  const explicit = number(value.phase)
  if (explicit !== undefined && Number.isInteger(explicit) && explicit >= 0) return explicit
  const sourceType = text(value.sourceType) ?? ""
  if (sourceType === "session.tool.success" || sourceType === "session.tool.failed") return 2
  if (sourceType === "session.tool.called") return 1
  if (legacyConflict) return 2
  if (status === "succeeded" || status === "failed") return 2
  if (status === "running" || status === "not-executed") return 1
  return 0
}

function executionEvidence(value: unknown, enclosingStatus?: string): ExecutionEvidence[] {
  const execution = object(value)
  if (!execution) return []
  const existingEvidence = Array.isArray(execution.evidence)
    ? execution.evidence.flatMap((item) => {
        const fact = object(item)
        const status = text(fact?.status)
        if (!fact || !status) return []
        const conflict = fact.conflict === true
        return [
          {
            status,
            source: text(fact.source) ?? "unknown",
            sourceType: text(fact.sourceType) ?? "unknown",
            meaning: text(fact.meaning) ?? "",
            phase: executionPhase(fact, status, conflict),
            ...(conflict ? { conflict: true as const } : {}),
          },
        ]
      })
    : []
  if (existingEvidence.length) return existingEvidence

  const status = text(execution.status)
  const source = text(execution.source) ?? "unknown"
  const sourceType = text(execution.sourceType) ?? "unknown"
  const legacyConflict =
    execution.conflict === true ||
    (status === "unknown" && (text(execution.meaning) ?? "").includes("conflicting"))
  if (!status || (status === "unknown" && !legacyConflict)) return []
  return [
    {
      status,
      source,
      sourceType,
      meaning: text(execution.meaning) ?? "",
      // Older recovery conflicts did not retain their phase or candidates.
      // Keep those conflicts conservative until higher-authority evidence arrives.
      phase: executionPhase(execution, enclosingStatus, legacyConflict),
      ...(legacyConflict ? { conflict: true as const } : {}),
    },
  ]
}

function isLegacyExecutionConflict(value: unknown): boolean {
  const execution = object(value)
  const status = text(execution?.status)
  return Boolean(
    execution &&
    !Array.isArray(execution.evidence) &&
    (execution.conflict === true ||
      (status === "unknown" && (text(execution.meaning) ?? "").includes("conflicting"))),
  )
}

function executionRank(value: ExecutionEvidence): [number, number] {
  return [sourcePriority(value), value.phase]
}

function compareExecutionRank(left: ExecutionEvidence, right: ExecutionEvidence) {
  const [leftPriority, leftPhase] = executionRank(left)
  const [rightPriority, rightPhase] = executionRank(right)
  return leftPriority - rightPriority || leftPhase - rightPhase
}

function canonicalExecutionEvidence(values: ExecutionEvidence[]) {
  const unique = new Map<string, ExecutionEvidence>()
  for (const value of values) unique.set(JSON.stringify(value), value)
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value)
}

function mergeExecution(
  previousValue: unknown,
  incomingValue: unknown,
  previousStatus?: string,
  incomingStatus?: string,
): JsonObject | undefined {
  const previous = object(previousValue)
  const previousEvidence = executionEvidence(previousValue, previousStatus)
  const incomingEvidence = executionEvidence(incomingValue, incomingStatus)
  if (
    previous &&
    isLegacyExecutionConflict(previousValue) &&
    previousEvidence[0] &&
    !incomingEvidence.some((candidate) => compareExecutionRank(candidate, previousEvidence[0]!) > 0)
  )
    return previous

  const values = canonicalExecutionEvidence([...previousEvidence, ...incomingEvidence])
  if (!values.length) return undefined

  const highest = values.reduce((winner, candidate) =>
    compareExecutionRank(candidate, winner) > 0 ? candidate : winner,
  )
  const evidence = values.filter((candidate) => compareExecutionRank(candidate, highest) === 0)
  const orderedEvidence = canonicalExecutionEvidence(evidence)
  const conflict =
    orderedEvidence.some((candidate) => candidate.conflict === true) ||
    new Set(orderedEvidence.map((candidate) => candidate.status)).size > 1
  if (conflict) {
    const canonical = orderedEvidence[0]!
    return {
      status: "unknown",
      source: canonical.source,
      sourceType: canonical.sourceType,
      phase: canonical.phase,
      meaning: "Execution state is conflicting at equal source authority and phase",
      conflict: true,
      evidence: orderedEvidence,
    }
  }

  const canonical = orderedEvidence[0]!
  return { ...canonical, evidence: orderedEvidence }
}

function mergeFactPayload(
  kind: ProgressKind,
  previous: JsonObject,
  incoming: JsonObject,
): JsonObject {
  const merged = mergeObjects(previous, incoming)
  const observations = mergeObservations(previous.observations, incoming.observations, kind)
  if (observations.length) merged.observations = observations
  if (kind === "tool" || kind === "step" || kind === "shell") {
    const status = mergeStatus(kind, previous, incoming)
    if (status) {
      merged.status = status.status
      merged.statusProvenance = status.provenance
    }
  }
  const timing = mergeTiming(previous.timing, incoming.timing)
  if (timing) merged.timing = timing
  const execution = mergeExecution(
    previous.execution,
    incoming.execution,
    text(previous.status),
    text(incoming.status),
  )
  if (execution) merged.execution = execution
  if (kind === "step")
    setStepRouteEvidence(
      merged,
      mergeRouteEvidence(payloadRouteEvidence(previous), payloadRouteEvidence(incoming)),
    )
  return merged
}

const activeAttempt = (state: string) => ["preparing", "running", "verifying"].includes(state)

function sameReminderOwnership(value: unknown, expected: ReminderOwnership): boolean {
  const actual = object(value)
  return Boolean(
    actual &&
    actual.lazersKind === expected.lazersKind &&
    actual.lazersProjectID === expected.lazersProjectID &&
    actual.lazersProjectDirectory === expected.lazersProjectDirectory &&
    actual.lazersPlanID === expected.lazersPlanID &&
    actual.lazersTaskID === expected.lazersTaskID &&
    actual.lazersAttemptID === expected.lazersAttemptID &&
    actual.lazersSessionID === expected.lazersSessionID &&
    actual.lazersMessageID === expected.lazersMessageID &&
    actual.lazersAssignedMessageID === expected.lazersAssignedMessageID,
  )
}

/**
 * One append-only, project-scoped ordered log shared by model commentary,
 * OpenCode observations, recovery and runtime verification facts.
 */
export class ProgressRecorder {
  private readonly reconcileStates = new Map<string, SessionReconcileState>()
  private readonly reconcileInflight = new Map<string, Promise<void>>()
  /** Work counters for tests and diagnostics; never persisted. */
  readonly reconcileStats = { stamped: 0, messages: 0, parts: 0 }
  private owners: SessionOwners | undefined

  constructor(
    readonly store: RunnerStore,
    readonly projectID: string,
  ) {}

  /**
   * O(1) prefilter: false means no runner attempt owns this session, so assignment-only
   * work (fact building, privacy scrubbing, transactions, reconstruction) can be skipped.
   */
  mayBeAssigned(sessionID: string): boolean {
    this.owners ??= sessionOwners(this.store.repository)
    return this.owners.has(sessionID)
  }

  private assignmentFromRow(row: {
    plan_id: string
    task_id: string
    attempt_id: string
    attempt_state: string
    session_id: string
    message_id: string
    workspace: string
    project_directory: string
    task_body: string
  }): ProgressAssignment | undefined {
    if (row.project_directory !== this.store.repository.projectDirectory) return undefined
    const task = TaskSpecSchema.parse(JSON.parse(row.task_body))
    if (
      task.id !== row.task_id ||
      !sameProject(task.provenance.projectID, this.projectID) ||
      task.provenance.projectDirectory !== row.project_directory
    )
      return undefined
    return {
      projectID: task.provenance.projectID,
      taskID: task.id,
      planID: row.plan_id,
      attemptID: row.attempt_id,
      attemptState: row.attempt_state,
      sessionID: row.session_id,
      assignedMessageID: row.message_id,
      workspace: row.workspace,
    }
  }

  private assignmentQuery(db: Database, where: "session" | "attempt", value: string) {
    const condition = where === "session" ? "a.session_id=?" : "a.id=?"
    const row = db
      .query<
        {
          plan_id: string
          task_id: string
          attempt_id: string
          attempt_state: string
          session_id: string
          message_id: string
          workspace: string
          project_directory: string
          task_body: string
        },
        [string, string, string]
      >(
        `SELECT a.plan_id,a.task_id,a.id AS attempt_id,a.state AS attempt_state,
                a.session_id,a.message_id,a.workspace,p.project_directory,t.body AS task_body
         FROM runner_attempts a
         JOIN runner_plans p ON p.id=a.plan_id
         JOIN tasks t ON t.id=a.task_id AND t.project_directory=p.project_directory
         WHERE p.project_directory=? AND t.project_directory=? AND ${condition}`,
      )
      .get(this.store.repository.projectDirectory, this.store.repository.projectDirectory, value)
    const assignment = row ? this.assignmentFromRow(row) : undefined
    if (assignment && where === "session")
      (this.owners ??= sessionOwners(this.store.repository)).markOwned(assignment.sessionID)
    return assignment
  }

  assignmentForSession(sessionID: string): ProgressAssignment | undefined {
    if (!this.mayBeAssigned(sessionID)) return undefined
    return this.store.atomic((db) => this.assignmentQuery(db, "session", sessionID))
  }

  matchesAssignedInput(
    attemptID: string,
    sessionID: string,
    assignedMessageID: string,
    inputID: string | null | undefined,
  ): boolean {
    if (!inputID) return false
    return this.store.atomic((db) => {
      const assignment = this.assignmentQuery(db, "attempt", attemptID)
      if (
        !assignment ||
        assignment.sessionID !== sessionID ||
        assignment.assignedMessageID !== assignedMessageID
      )
        return false
      if (inputID === assignedMessageID) return true
      // Native user/Architect steering belongs to the same assigned attempt.
      // These rows are captured from OpenCode messages, never from worker reports.
      const capturedInput = db
        .query<{ seq: number }, [string, string, string, string, string]>(
          `SELECT seq FROM runner_progress WHERE project_directory=? AND attempt_id=?
           AND session_id=? AND message_id=? AND dedupe_key=?
           AND source='recovery' AND kind='visible-text'
           AND json_extract(payload,'$.messageType') IN ('user','synthetic') LIMIT 1`,
        )
        .get(
          this.store.repository.projectDirectory,
          attemptID,
          sessionID,
          inputID,
          `input:${sessionID}:${inputID}`,
        )
      if (capturedInput) return true
      const claim = this.reminderClaimIn(db, attemptID, sessionID, inputID)
      return Boolean(
        claim &&
        claim.status === "admitted" &&
        sameReminderOwnership(claim.ownership, {
          lazersKind: "worker-progress-reminder",
          lazersAssignedMessageID: assignedMessageID,
          lazersProjectID: assignment.projectID,
          lazersProjectDirectory: this.store.repository.projectDirectory,
          lazersPlanID: assignment.planID,
          lazersTaskID: assignment.taskID,
          lazersAttemptID: attemptID,
          lazersSessionID: sessionID,
          lazersMessageID: inputID,
        }),
      )
    })
  }

  assignments(): ProgressAssignment[] {
    return this.store.atomic((db) => {
      const rows = db
        .query<
          {
            plan_id: string
            task_id: string
            attempt_id: string
            attempt_state: string
            session_id: string
            message_id: string
            workspace: string
            project_directory: string
            task_body: string
          },
          [string, string]
        >(
          `SELECT a.plan_id,a.task_id,a.id AS attempt_id,a.state AS attempt_state,
                  a.session_id,a.message_id,a.workspace,p.project_directory,t.body AS task_body
           FROM runner_attempts a
           JOIN runner_plans p ON p.id=a.plan_id
           JOIN tasks t ON t.id=a.task_id AND t.project_directory=p.project_directory
           WHERE p.project_directory=? AND t.project_directory=? ORDER BY a.started_at,a.number`,
        )
        .all(this.store.repository.projectDirectory, this.store.repository.projectDirectory)
      return rows.flatMap((row) => {
        const assignment = this.assignmentFromRow(row)
        return assignment ? [assignment] : []
      })
    })
  }

  private appendIn(db: Database, assignment: ProgressAssignment, fact: Fact): number {
    const directory = this.store.repository.projectDirectory
    const factAt = dateMillis(fact.at) ?? Date.now()
    const factPayload = { ...fact.payload }
    if (text(factPayload.status) && !object(factPayload.statusProvenance))
      factPayload.statusProvenance = {
        source: fact.source,
        sourceType: fact.sourceType ?? fact.kind,
      }
    const execution = mergeExecution(undefined, factPayload.execution, text(factPayload.status))
    if (execution) factPayload.execution = execution
    if (fact.kind === "step") normalizeStepRouteEvidence(factPayload)
    const payload = JSON.stringify(factPayload)
    const existing = db
      .query<
        {
          seq: number
          project_id: string
          plan_id: string
          task_id: string
          attempt_id: string
          session_id: string
          at: number
          recorded_at: number | null
          source: string
          sources_json: string
          kind: string
          event_ids_json: string
          call_id: string | null
          message_id: string | null
          payload: string
        },
        [string, string]
      >(
        "SELECT seq,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,source,sources_json,kind,event_ids_json,call_id,message_id,payload FROM runner_progress WHERE project_directory=? AND dedupe_key=?",
      )
      .get(directory, fact.dedupeKey)
    // All callers hold the repository's immediate transaction. Check the durable
    // key first: an ignored AUTOINCREMENT insert still writes sqlite_sequence.
    if (!existing) {
      const insertedAt = Date.now()
      const inserted = db
        .query(
          `INSERT OR IGNORE INTO runner_progress
           (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,source,
            sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          directory,
          assignment.projectID,
          assignment.planID,
          assignment.taskID,
          assignment.attemptID,
          assignment.sessionID,
          factAt,
          insertedAt,
          fact.source,
          JSON.stringify([fact.source]),
          fact.kind,
          JSON.stringify(fact.eventID ? [fact.eventID] : []),
          fact.callID ?? null,
          fact.messageID ?? null,
          fact.dedupeKey,
          payload,
        )
      if (inserted.changes) {
        return db.query<{ seq: number }, []>("SELECT last_insert_rowid() AS seq").get()!.seq
      }
      throw new Error("Progress fact disappeared during append")
    }
    let existingPayload: JsonObject | undefined
    if (existing.kind === "tool" && fact.kind === "tool") {
      let prior: JsonObject
      try {
        const parsed: unknown = JSON.parse(existing.payload)
        prior = object(parsed) ?? {}
      } catch {
        return existing.seq
      }
      existingPayload = prior
      if (
        existing.project_id !== assignment.projectID ||
        existing.plan_id !== assignment.planID ||
        existing.task_id !== assignment.taskID ||
        existing.attempt_id !== assignment.attemptID ||
        existing.session_id !== assignment.sessionID ||
        existing.call_id !== (fact.callID ?? null) ||
        existing.message_id !== (fact.messageID ?? null) ||
        (text(prior.tool) &&
          text(fact.payload.tool) &&
          text(prior.tool) !== text(fact.payload.tool))
      )
        return existing.seq
    }
    if (targetOnlyTool(existingPayload?.tool)) delete factPayload.content
    let priorPayload: JsonObject = {}
    try {
      priorPayload = object(JSON.parse(existing.payload)) ?? {}
    } catch {
      // A repaired append replaces malformed JSON with only the current safe projection.
    }
    const nextKind =
      existing.kind === "tool" && fact.kind === "commentary" ? "commentary" : existing.kind
    const cumulative = fact.kind === "usage-snapshot" || fact.kind === "outcome-snapshot"
    const replaceCumulative = cumulative && factAt >= existing.at
    const nextPayload = cumulative
      ? replaceCumulative
        ? factPayload
        : priorPayload
      : mergeFactPayload(nextKind as ProgressKind, priorPayload, factPayload)
    const sources = [
      ...new Set([...parseSources(existing.sources_json), existing.source, fact.source]),
    ].toSorted()
    const eventIDs = [
      ...new Set([...parseIDs(existing.event_ids_json), ...(fact.eventID ? [fact.eventID] : [])]),
    ]
    const nextPayloadText = JSON.stringify(nextPayload)
    const nextSourcesText = JSON.stringify(sources)
    const nextEventIDsText = JSON.stringify(eventIDs)
    const nextCallID = existing.call_id ?? fact.callID ?? null
    const nextMessageID = existing.message_id ?? fact.messageID ?? null
    const nextAt = replaceCumulative ? factAt : existing.at
    const changed =
      existing.kind !== nextKind ||
      existing.payload !== nextPayloadText ||
      existing.sources_json !== nextSourcesText ||
      existing.event_ids_json !== nextEventIDsText ||
      existing.call_id !== nextCallID ||
      existing.message_id !== nextMessageID ||
      existing.at !== nextAt
    if (changed) {
      const recordedAt = Math.max(existing.recorded_at ?? Number.MIN_SAFE_INTEGER, Date.now())
      db.query(
        `UPDATE runner_progress SET kind=?,payload=?,sources_json=?,event_ids_json=?,
         call_id=?,message_id=?,at=?,recorded_at=? WHERE seq=?`,
      ).run(
        nextKind,
        nextPayloadText,
        nextSourcesText,
        nextEventIDsText,
        nextCallID,
        nextMessageID,
        nextAt,
        recordedAt,
        existing.seq,
      )
    }
    return existing.seq
  }

  private updateProgressPayloadIn(db: Database, seq: number, value: JsonObject): boolean {
    const row = db
      .query<{ payload: string; recorded_at: number | null }, [number]>(
        "SELECT payload,recorded_at FROM runner_progress WHERE seq=?",
      )
      .get(seq)
    if (!row) return false
    const payload = JSON.stringify(value)
    if (payload === row.payload) return false
    const recordedAt = Math.max(row.recorded_at ?? Number.MIN_SAFE_INTEGER, Date.now())
    return Boolean(
      db
        .query("UPDATE runner_progress SET payload=?,recorded_at=? WHERE seq=?")
        .run(payload, recordedAt, seq).changes,
    )
  }

  /** Canonical tool-call history; runner_progress remains its assigned-worker projection. */
  toolCalls(sessionID: string): ToolCallRow[] {
    return this.store.atomic((db) =>
      db
        .query<ToolCallRow, [string, string]>(
          `SELECT * FROM native_tool_calls WHERE project_directory=? AND session_id=?
           ORDER BY first_observed_at,identity_kind,invocation_id`,
        )
        .all(this.store.repository.projectDirectory, sessionID),
    )
  }

  private appendToolCallIn(
    db: Database,
    sessionID: string,
    fact: ToolFact,
    invocation?: ToolInvocation,
  ): void {
    if (!fact.callID) return
    const directory = this.store.repository.projectDirectory
    let identityKind = invocation?.identityKind ?? "native-call"
    let invocationID = invocation?.invocationID ?? fact.callID
    let previous = db
      .query<ToolCallRow, [string, string, string, string]>(
        `SELECT * FROM native_tool_calls WHERE project_directory=? AND session_id=?
         AND identity_kind=? AND invocation_id=?`,
      )
      .get(directory, sessionID, identityKind, invocationID)
    if (!previous && invocation?.localInvocationID) {
      const resolved = db
        .query<ToolCallRow, [string, string, string]>(
          `SELECT * FROM native_tool_calls WHERE project_directory=? AND session_id=?
         AND local_invocation_id=? LIMIT 2`,
        )
        .all(directory, sessionID, invocation.localInvocationID)
      if (resolved.length > 1) return
      if (resolved.length === 1) {
        // Native input may promote the key while the callback is still running.
        // Its preserved UUID resolves terminal writes to that same durable row.
        previous = resolved[0]!
        identityKind = previous.identity_kind
        invocationID = previous.invocation_id
      }
    }
    const incomingTool = text(fact.payload.tool)
    if (!previous && identityKind === "native-call" && incomingTool) {
      const unmatched = db
        .query<ToolCallRow, [string, string, string, string]>(
          `SELECT * FROM native_tool_calls WHERE project_directory=? AND session_id=?
         AND identity_kind='local-invocation' AND context_call_id=? AND tool=?
         AND parent_call_id IS NULL LIMIT 2`,
        )
        .all(directory, sessionID, fact.callID, incomingTool)
      if (unmatched.length === 1) {
        // A later native observation resolves an initially unknown context. The
        // real callback UUID survives; no guessed child identity is introduced.
        const local = unmatched[0]!
        db.query(
          `UPDATE native_tool_calls SET identity_kind='native-call',invocation_id=?,native_call_id=?
          WHERE project_directory=? AND session_id=? AND identity_kind='local-invocation' AND invocation_id=?`,
        ).run(invocationID, fact.callID, directory, sessionID, local.invocation_id)
        previous = {
          ...local,
          identity_kind: "native-call",
          invocation_id: invocationID,
          native_call_id: fact.callID,
        }
      }
    }
    if (
      previous &&
      ((previous.tool && incomingTool && previous.tool !== incomingTool) ||
        (previous.message_id && fact.messageID && previous.message_id !== fact.messageID))
    )
      // Some Code Mode hooks share the outer ID. Never overwrite the outer tool
      // with an inner name; project-owned wrappers record their own local identity.
      return
    const assignment = this.assignmentQuery(db, "session", sessionID)
    const observedAt = Date.now()
    const incoming = { ...fact.payload }
    if (incoming.status && !incoming.statusProvenance)
      incoming.statusProvenance = { source: fact.source, sourceType: fact.sourceType ?? fact.kind }
    const prior = previous ? (object(JSON.parse(previous.payload)) ?? {}) : {}
    if (targetOnlyTool(previous?.tool ?? incomingTool)) delete incoming.content
    const payload = mergeFactPayload("tool", prior, incoming)
    const agent = text(payload.agent) ?? previous?.agent ?? null
    const sources = [
      ...new Set([...(previous ? parseIDs(previous.sources_json) : []), fact.source]),
    ].toSorted()
    const eventIDs = [
      ...new Set([
        ...(previous ? parseIDs(previous.event_ids_json) : []),
        ...(fact.eventID ? [fact.eventID] : []),
      ]),
    ]
    const payloadText = JSON.stringify(payload)
    const sourcesText = JSON.stringify(sources)
    const eventIDsText = JSON.stringify(eventIDs)
    if (!previous) {
      db.query(
        `INSERT INTO native_tool_calls
         (project_directory,project_id,session_id,identity_kind,invocation_id,native_call_id,parent_call_id,context_call_id,local_invocation_id,
          message_id,agent,tool,plan_id,task_id,attempt_id,first_observed_at,last_observed_at,
          sources_json,event_ids_json,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        directory,
        this.projectID,
        sessionID,
        identityKind,
        invocationID,
        invocation ? invocation.nativeCallID : fact.callID,
        invocation?.parentCallID ?? null,
        invocation?.contextCallID ?? fact.callID,
        invocation?.localInvocationID ?? null,
        fact.messageID ?? null,
        agent,
        incomingTool ?? null,
        assignment?.planID ?? null,
        assignment?.taskID ?? null,
        assignment?.attemptID ?? null,
        observedAt,
        observedAt,
        sourcesText,
        eventIDsText,
        payloadText,
      )
    } else if (
      previous.payload !== payloadText ||
      previous.sources_json !== sourcesText ||
      previous.event_ids_json !== eventIDsText ||
      previous.agent !== agent ||
      (!previous.tool && incomingTool) ||
      (!previous.attempt_id && assignment)
    ) {
      db.query(
        `UPDATE native_tool_calls SET message_id=COALESCE(message_id,?),agent=?,tool=COALESCE(tool,?),
         plan_id=COALESCE(plan_id,?),task_id=COALESCE(task_id,?),attempt_id=COALESCE(attempt_id,?),
         last_observed_at=?,sources_json=?,event_ids_json=?,payload=?
         WHERE project_directory=? AND session_id=? AND identity_kind=? AND invocation_id=?`,
      ).run(
        fact.messageID ?? null,
        agent,
        incomingTool ?? null,
        assignment?.planID ?? null,
        assignment?.taskID ?? null,
        assignment?.attemptID ?? null,
        Math.max(previous.last_observed_at, observedAt),
        sourcesText,
        eventIDsText,
        payloadText,
        directory,
        sessionID,
        identityKind,
        invocationID,
      )
    }
  }

  /**
   * Where a session works, for showing paths without the machine prefix: its assigned workspace
   * when it has one, the project root, and the per-task worktrees beside the project.
   */
  private pathScope(sessionID: string): PathScope {
    const project = this.store.repository.projectDirectory
    let workspace: string | undefined
    try {
      workspace = this.assignmentForSession(sessionID)?.workspace
    } catch {
      workspace = undefined
    }
    return {
      roots: workspace ? [workspace, project] : [project],
      worktreesBase: `${project}.worktrees`,
      home: homedir(),
    }
  }

  recordToolBefore(call: Omit<ToolCall, "status" | "result" | "error">): void {
    const at = Date.now()
    const stats = privacyStats()
    const detail = detailField(call, this.pathScope(call.sessionID))
    this.store.atomic((db) =>
      this.appendToolCallIn(db, call.sessionID, {
        source: "tool-hook",
        sourceType: "tool-hook.execute.before",
        kind: "tool",
        dedupeKey: `tool:${call.sessionID}:${call.callID}`,
        at,
        callID: call.callID,
        messageID: call.messageID,
        payload: {
          tool: safeText(call.tool, stats, 160),
          agent: safeText(call.agent, stats, 200),
          ...detail,
          observations: [
            {
              source: "tool-hook",
              observationID: "tool-hook.execute.before",
              eventType: "tool-hook.execute.before",
              at,
              unit: EPOCH_MILLIS,
              meaning: "Hook observation time; not an execution boundary",
            },
          ],
        },
      }),
    )
  }

  /** The UUID identifies this observed callback invocation, never a native child call. */
  beginToolInvocation(call: Omit<ToolCall, "status" | "result" | "error">): ToolInvocation {
    return this.store.atomic((db) => {
      const parent = db
        .query<{ tool: string | null }, [string, string, string]>(
          `SELECT tool FROM native_tool_calls WHERE project_directory=? AND session_id=?
         AND identity_kind='native-call' AND invocation_id=?`,
        )
        .get(this.store.repository.projectDirectory, call.sessionID, call.callID)
      const direct = parent?.tool === call.tool
      const localInvocationID = direct ? null : crypto.randomUUID()
      const invocation: ToolInvocation = {
        sessionID: call.sessionID,
        messageID: call.messageID,
        agent: call.agent,
        tool: call.tool,
        identityKind: direct ? "native-call" : "local-invocation",
        invocationID: localInvocationID ?? call.callID,
        nativeCallID: direct ? call.callID : null,
        parentCallID: parent?.tool === "execute" ? call.callID : null,
        contextCallID: call.callID,
        localInvocationID,
      }
      this.recordToolInvocationIn(db, invocation)
      return invocation
    })
  }

  private recordToolInvocationIn(db: Database, invocation: ToolInvocation, call?: ToolCall): void {
    const at = Date.now()
    const stats = privacyStats()
    const payload: JsonObject = {
      tool: safeText(invocation.tool, stats, 160),
      agent: safeText(invocation.agent, stats, 200),
      observations: [
        {
          source: "tool-wrapper",
          observationID: call ? "tool-wrapper.execute.after" : "tool-wrapper.execute.before",
          eventType: call ? "tool-wrapper.execute.after" : "tool-wrapper.execute.before",
          at,
          unit: EPOCH_MILLIS,
          meaning: "Project-owned callback observation; not a native execution endpoint",
        },
      ],
    }
    if (call) {
      payload.status = call.status === "error" ? "failed" : "succeeded"
      if (call.status === "error") payload.error = errorView(call.error, stats)
      // Successful arbitrary structured output is not an error/progress contract.
    }
    this.appendToolCallIn(
      db,
      invocation.sessionID,
      {
        source: "tool-wrapper",
        sourceType: call ? "tool-wrapper.execute.after" : "tool-wrapper.execute.before",
        kind: "tool",
        dedupeKey: invocation.invocationID,
        at,
        callID: invocation.contextCallID,
        messageID: invocation.messageID,
        payload,
      },
      invocation,
    )
  }

  endToolInvocation(invocation: ToolInvocation, outcome: Pick<ToolCall, "status" | "error">): void {
    this.store.atomic((db) =>
      this.recordToolInvocationIn(db, invocation, {
        ...invocation,
        callID: invocation.contextCallID,
        ...outcome,
      }),
    )
  }

  private appendForSession(
    sessionID: string,
    fact: Fact,
    verifiedToolSession?: boolean,
  ): number | undefined {
    if (verifiedToolSession !== true && !this.mayBeAssigned(sessionID)) return undefined
    return this.store.atomic((db) => {
      const assignment = this.assignmentQuery(db, "session", sessionID)
      if (
        fact.kind === "tool" &&
        (verifiedToolSession || (verifiedToolSession === undefined && assignment))
      )
        this.appendToolCallIn(db, sessionID, fact)
      return assignment ? this.appendIn(db, assignment, fact) : undefined
    })
  }

  recordNativeObservation(input: {
    sessionID: string
    listenerID: string
    directory: string
    phase: string
    executionStartSequence?: number
    eventSequence?: number
    idleSequence?: number
    inputID?: string
    backgroundCount?: number
    lineageRejection?: NativeLineageRejection
    current?: boolean
    error?: unknown
  }): number | undefined {
    const { sessionID, error, ...details } = input
    return this.appendForSession(sessionID, {
      source: "native-event",
      kind: "native-observation",
      dedupeKey: `native-observation:${crypto.randomUUID()}`,
      at: Date.now(),
      payload: {
        ...details,
        ...(error === undefined ? {} : { error: safeError(error, privacyStats()) }),
      },
    })
  }

  report(input: {
    sessionID: string
    agent: string
    callID: string
    messageID: string
    message: unknown
  }): { sequence: number; text: string } {
    if (!isWorkerAgent(input.agent))
      throw new Error("Only an assigned LAZERS implementor may report progress")
    const parsed = ProgressInput.parse({ message: input.message })
    const stats = privacyStats()
    const safeMessage = safeText(parsed.message, stats, 1200).trim()
    if (!safeMessage) throw new Error("Progress message is empty after privacy filtering")
    const result = this.store.atomic((db) => {
      const assignment = this.assignmentQuery(db, "session", input.sessionID)
      if (!assignment || !activeAttempt(assignment.attemptState))
        throw new Error("Progress reports require an active assigned worker session")
      return this.appendIn(db, assignment, {
        source: "tool-commentary",
        kind: "commentary",
        dedupeKey: `tool:${input.sessionID}:${input.callID}`,
        at: Date.now(),
        callID: input.callID,
        messageID: input.messageID,
        payload: { text: safeMessage },
      })
    })
    return { sequence: result, text: safeMessage }
  }

  recordToolHook(call: ToolCall): number | undefined {
    const at = Date.now()
    const stats = privacyStats()
    const payload: Record<string, unknown> = {
      tool: safeText(call.tool, stats, 160),
      agent: safeText(call.agent, stats, 200),
      status: call.status === "error" ? "failed" : "succeeded",
      ...detailField(call, this.pathScope(call.sessionID)),
      observations: [
        {
          source: "tool-hook",
          observationID: "tool-hook.execute.after",
          eventType: "tool-hook.execute.after",
          at,
          unit: EPOCH_MILLIS,
          meaning: "Hook observation time; not an execution boundary",
        },
      ],
    }
    if (call.status === "error") {
      const error = errorView(call.error, stats)
      if (error !== undefined) payload.error = error
    } else if (call.result && !targetOnlyTool(call.tool)) {
      const content = visibleContent(call.result.content, stats)
      if (content !== undefined) payload.content = content
      // Tool.Result.output is arbitrary data, not a public-content contract.
    }
    const fact: Fact = {
      source: "tool-hook",
      sourceType: "tool-hook.execute.after",
      kind: "tool",
      dedupeKey: `tool:${call.sessionID}:${call.callID}`,
      at,
      callID: call.callID,
      messageID: call.messageID,
      payload,
    }
    return this.store.atomic((db) => {
      this.appendToolCallIn(db, call.sessionID, fact)
      if (call.tool === "lz-report-progress" || !isWorkerAgent(call.agent)) return undefined
      const assignment = this.assignmentQuery(db, "session", call.sessionID)
      return assignment ? this.appendIn(db, assignment, fact) : undefined
    })
  }

  /** Store only supported, bounded requested paths for the exact active native call. */
  recordToolTargets(call: {
    tool: string
    sessionID: string
    agent: string
    messageID: string
    callID: string
    input: unknown
  }): number | undefined {
    if (
      !isWorkerAgent(call.agent) ||
      !call.tool ||
      call.tool.length > 160 ||
      !call.sessionID ||
      call.sessionID.length > 200 ||
      !call.messageID ||
      call.messageID.length > 200 ||
      !call.callID ||
      call.callID.length > 200
    )
      return undefined

    const initial = this.assignmentForSession(call.sessionID)
    if (!initial || !activeAttempt(initial.attemptState)) return undefined
    const fileTargets = observeFileTargets(call.tool, call.input, initial.workspace)
    const detail = toolDetail(call.tool, call.input, this.pathScope(call.sessionID))
    if (!fileTargets && detail === null) return undefined

    return this.store.atomic((db) => {
      const assignment = this.assignmentQuery(db, "session", call.sessionID)
      if (
        !assignment ||
        !activeAttempt(assignment.attemptState) ||
        assignment.projectID !== initial.projectID ||
        assignment.planID !== initial.planID ||
        assignment.taskID !== initial.taskID ||
        assignment.attemptID !== initial.attemptID ||
        assignment.sessionID !== initial.sessionID ||
        assignment.assignedMessageID !== initial.assignedMessageID ||
        assignment.workspace !== initial.workspace
      )
        return undefined

      const dedupeKey = `tool:${call.sessionID}:${call.callID}`
      const existing = db
        .query<
          {
            seq: number
            project_id: string
            plan_id: string
            task_id: string
            attempt_id: string
            session_id: string
            call_id: string | null
            message_id: string | null
            kind: string
            payload: string
          },
          [string, string]
        >(
          `SELECT seq,project_id,plan_id,task_id,attempt_id,session_id,call_id,message_id,kind,payload
           FROM runner_progress WHERE project_directory=? AND dedupe_key=?`,
        )
        .get(this.store.repository.projectDirectory, dedupeKey)
      if (existing) {
        let prior: JsonObject
        try {
          prior = object(JSON.parse(existing.payload)) ?? {}
        } catch {
          return undefined
        }
        if (
          existing.kind !== "tool" ||
          existing.project_id !== assignment.projectID ||
          existing.plan_id !== assignment.planID ||
          existing.task_id !== assignment.taskID ||
          existing.attempt_id !== assignment.attemptID ||
          existing.session_id !== assignment.sessionID ||
          existing.call_id !== call.callID ||
          existing.message_id !== call.messageID ||
          text(prior.tool) !== call.tool ||
          prior.status === "succeeded" ||
          prior.status === "failed"
        )
          return undefined
      }

      return this.appendIn(db, assignment, {
        source: "tool-hook",
        sourceType: "tool-hook.execute.before",
        kind: "tool",
        dedupeKey,
        at: Date.now(),
        callID: call.callID,
        messageID: call.messageID,
        payload: {
          tool: call.tool,
          ...(fileTargets ? { fileTargets } : {}),
          ...(detail === null ? {} : { detail }),
        },
      })
    })
  }

  recordNativeEvent(value: unknown, verifiedToolSession?: boolean): number | undefined {
    const event = object(value)
    const data = object(event?.data)
    const type = text(event?.type)
    const sessionID = text(data?.sessionID)
    if (!event || !data || !type || !sessionID) return undefined
    const eventID = text(event.id)
    const eventAt = dateMillis(event.created)
    const at = eventAt ?? Date.now()
    const messageID = text(data.assistantMessageID)
    const stats = privacyStats()
    if (type === "session.synthetic")
      return eventID
        ? this.observeReminderAdmission(sessionID, data.metadata, eventID, at)
        : undefined
    // Unowned sessions have nothing to record: skip fact building and privacy scrubbing.
    if (verifiedToolSession !== true && !this.mayBeAssigned(sessionID)) return undefined
    let fact: Fact | undefined

    if (
      type === "session.tool.input.started" ||
      type === "session.tool.called" ||
      type === "session.tool.success" ||
      type === "session.tool.failed"
    ) {
      const callID = text(data.id)
      if (!callID) return undefined
      const payload: Record<string, unknown> = {
        ...(type === "session.tool.input.started" && text(data.name)
          ? { tool: safeText(text(data.name)!, stats, 160) }
          : {}),
        status:
          type === "session.tool.input.started"
            ? "input-started"
            : type === "session.tool.called"
              ? data.executed === false
                ? "not-executed"
                : data.executed === true
                  ? "running"
                  : "unknown"
              : type === "session.tool.success"
                ? "succeeded"
                : "failed",
      }
      if (type !== "session.tool.input.started") payload.callStatus = "called"
      if (typeof data.executed === "boolean")
        payload.execution = {
          status: data.executed ? "executed" : "not-executed",
          source: "native-event",
          sourceType: type,
          phase:
            type === "session.tool.success" || type === "session.tool.failed"
              ? 2
              : type === "session.tool.called"
                ? 1
                : 0,
          meaning: "OpenCode executed flag; a tool call is not execution proof",
        }
      const toolTiming = factTiming({
        inputAt:
          type === "session.tool.input.started"
            ? timedEndpoint(eventAt, "native-event", type, "OpenCode tool input-started boundary")
            : undefined,
        calledAt:
          type === "session.tool.called"
            ? timedEndpoint(
                eventAt,
                "native-event",
                type,
                "OpenCode tool call boundary; distinct from explicit executed status",
              )
            : undefined,
        completedAt:
          type === "session.tool.success" || type === "session.tool.failed"
            ? timedEndpoint(eventAt, "native-event", type, "OpenCode tool result terminal boundary")
            : undefined,
      })
      if (toolTiming) payload.timing = toolTiming
      // Native terminal content cannot be safely associated with a file operation
      // when the call input event is absent or delayed. Keep terminal evidence only.
      if (type === "session.tool.failed") {
        const error = errorView(data.error, stats)
        if (error !== undefined) payload.error = error
      }
      payload.observations = [
        {
          source: "native-event",
          ...(eventID ? { eventID } : {}),
          eventType: type,
          at,
          unit: EPOCH_MILLIS,
          meaning: "Native event creation time; not a substitute for an absent tool endpoint",
          status: payload.status,
          phase:
            type === "session.tool.success" || type === "session.tool.failed"
              ? 2
              : type === "session.tool.called"
                ? 1
                : 0,
          messageID: messageID ?? null,
          callID,
          ...(type === "session.tool.input.started" && text(data.name)
            ? { tool: safeText(text(data.name)!, stats, 160) }
            : {}),
        },
      ]
      fact = {
        source: "native-event",
        sourceType: type,
        kind: "tool",
        dedupeKey: `tool:${sessionID}:${callID}`,
        at,
        eventID,
        callID,
        messageID,
        payload,
      }
    } else if (
      type === "session.step.started" ||
      type === "session.step.streamed" ||
      type === "session.step.ended" ||
      type === "session.step.failed"
    ) {
      if (!messageID) return undefined
      const status =
        type === "session.step.started"
          ? "started"
          : type === "session.step.streamed"
            ? "streamed"
            : type === "session.step.failed"
              ? "failed"
              : "ended"
      const payload: Record<string, unknown> = { status }
      const observedAgent = type === "session.step.started" ? text(data.agent) : undefined
      const routeEvidence =
        type === "session.step.started" && Object.hasOwn(data, "model")
          ? routeEvidenceFromModel(data.model, stats)
          : undefined
      const route = object(routeEvidence?.route)
      if (observedAgent) payload.agent = safeText(observedAgent, stats, 200)
      if (routeEvidence) payload.routeEvidence = routeEvidence
      if (route) payload.route = route
      if (type === "session.step.ended" || type === "session.step.failed") {
        if (object(data.tokens) || number(data.cost) !== undefined) {
          payload.measurementBasis = "additive-step-measurement"
          payload.usage = measuredUsage(data.tokens, data.cost)
        }
        if (text(data.finish)) payload.finish = safeText(text(data.finish)!, stats, 80)
      }
      const stepTiming = factTiming({
        startedAt:
          type === "session.step.started"
            ? timedEndpoint(
                data.started,
                "native-event",
                type,
                "OpenCode request dispatch time before provider output",
              )
            : undefined,
        streamedAt:
          type === "session.step.streamed"
            ? timedEndpoint(
                eventAt,
                "native-event",
                type,
                "OpenCode provider response-body end before tool settlement",
              )
            : undefined,
        completedAt:
          type === "session.step.ended" || type === "session.step.failed"
            ? timedEndpoint(
                eventAt,
                "native-event",
                type,
                "OpenCode assistant step terminal boundary after tool settlement",
              )
            : undefined,
      })
      if (stepTiming) payload.timing = stepTiming
      const error = errorView(data.error, stats)
      if (error !== undefined) payload.error = error
      payload.observations = [
        {
          source: "native-event",
          ...(eventID ? { eventID } : {}),
          eventType: type,
          at,
          unit: EPOCH_MILLIS,
          meaning: "Native event creation time; step endpoints are recorded separately",
          status,
          messageID,
          ...(observedAgent ? { agent: safeText(observedAgent, stats, 200) } : {}),
          ...(route ? { route } : {}),
          ...(routeEvidence ? { routeEvidence } : {}),
          ...(type === "session.step.started" && dateMillis(data.started) !== undefined
            ? { startedAt: dateMillis(data.started) }
            : {}),
        },
      ]
      fact = {
        source: "native-event",
        sourceType: type,
        kind: "step",
        dedupeKey: `step:${sessionID}:${messageID}`,
        at,
        eventID,
        messageID,
        payload,
      }
    } else if (type === "session.usage.updated") {
      fact = {
        source: "native-event",
        sourceType: type,
        kind: "usage-snapshot",
        dedupeKey: `usage-snapshot:${sessionID}`,
        at,
        eventID,
        payload: {
          measurementBasis: "cumulative-session-snapshot",
          usage: measuredUsage(data.tokens, data.cost),
        },
      }
    } else if (type === "session.retry.scheduled") {
      if (!messageID) return undefined
      const attemptNumber = number(data.attempt)
      const error = errorView(data.error, stats)
      const retryTiming = factTiming({
        scheduledAt: timedEndpoint(
          data.at,
          "native-event",
          type,
          "OpenCode provider retry scheduled time",
        ),
      })
      fact = {
        source: "native-event",
        sourceType: type,
        kind: "provider-retry",
        dedupeKey: `retry:${sessionID}:${messageID}:${attemptNumber ?? "unknown"}`,
        at: dateMillis(data.at) ?? at,
        eventID,
        messageID,
        payload: {
          ...(attemptNumber !== undefined ? { attempt: attemptNumber } : {}),
          ...(error !== undefined ? { error } : {}),
          ...(retryTiming ? { timing: retryTiming } : {}),
        },
      }
    } else if (type.startsWith("session.execution.")) {
      const outcome = type.slice("session.execution.".length)
      if (!new Set(["started", "succeeded", "failed", "interrupted"]).has(outcome)) return undefined
      const error = errorView(data.error, stats)
      // Pinned OpenCode creates terminal idle messages from this exact event ID
      // (schema SessionMessage.ID.fromEvent; core session/message-updater.ts).
      const terminalMessageID = eventID?.replace(/^evt_/, "msg_")
      fact = {
        source: "native-event",
        sourceType: type,
        kind: "execution-outcome",
        dedupeKey:
          outcome !== "started" && terminalMessageID
            ? `turn:${sessionID}:${terminalMessageID}`
            : `execution-event:${sessionID}:${eventID ?? `${outcome}:${at}`}`,
        at,
        eventID,
        messageID: outcome === "started" ? messageID : terminalMessageID,
        payload: {
          outcome,
          ...(error !== undefined ? { error } : {}),
        },
      }
    } else if (type === "session.shell.started" || type === "session.shell.ended") {
      const shell = object(data.shell)
      const shellID = text(shell?.id)
      if (!shell || !shellID) return undefined
      const payload: Record<string, unknown> = {
        shellID,
        status: text(shell.status) ?? (type.endsWith("started") ? "running" : "unknown"),
      }
      if (text(shell.command)) payload.command = safeText(text(shell.command)!, stats)
      if (number(shell.exit) !== undefined) payload.exit = number(shell.exit)
      const output = object(data.output)
      const shellOutput = text(output?.output)
      if (shellOutput) payload.output = safeText(shellOutput, stats)
      if (output?.truncated === true) payload.truncated = true
      const shellTime = object(shell.time)
      const shellTiming = factTiming({
        startedAt: timedEndpoint(
          shellTime?.started,
          "native-event",
          `${type}.shell.time.started`,
          "OpenCode shell process start time",
        ),
        completedAt: timedEndpoint(
          shellTime?.completed,
          "native-event",
          `${type}.shell.time.completed`,
          "OpenCode shell process completion time",
        ),
      })
      if (shellTiming) payload.timing = shellTiming
      fact = {
        source: "native-event",
        sourceType: type,
        kind: "shell",
        dedupeKey: `shell:${sessionID}:${shellID}`,
        at: dateMillis(shellTime?.started) ?? at,
        eventID,
        payload,
      }
    } else if (type === "session.text.ended") {
      if (!messageID || typeof data.ordinal !== "number" || typeof data.text !== "string")
        return undefined
      fact = {
        source: "native-event",
        sourceType: type,
        kind: "visible-text",
        dedupeKey: `text:${sessionID}:${messageID}:${data.ordinal}`,
        at,
        eventID,
        messageID,
        payload: { text: safeText(data.text, stats) },
      }
    }
    return fact ? this.appendForSession(sessionID, fact, verifiedToolSession) : undefined
  }

  /**
   * Reconcile only retained public session messages; it never invokes execution.
   * Synchronous drain of the same chunked engine, for callers that cannot yield.
   */
  reconcileMessages(sessionID: string, rawMessages: readonly unknown[]): void {
    const steps = this.reconcileSteps(sessionID, rawMessages)
    while (!steps.next().done) {
      // Each step is one short transaction; the sync caller simply continues.
    }
  }

  /**
   * Incremental, chunked reconcile: each slice is its own short transaction and the
   * event loop runs between slices. Overlapping runs for a session are serialized.
   */
  reconcileMessagesAsync(sessionID: string, rawMessages: readonly unknown[]): Promise<void> {
    const prior = this.reconcileInflight.get(sessionID)
    const run = (async () => {
      if (prior) await prior.catch(() => undefined)
      const steps = this.reconcileSteps(sessionID, rawMessages)
      while (!steps.next().done) await new Promise<void>((resolve) => setImmediate(resolve))
    })()
    const tracked: Promise<void> = run.finally(() => {
      if (this.reconcileInflight.get(sessionID) === tracked)
        this.reconcileInflight.delete(sessionID)
    })
    this.reconcileInflight.set(sessionID, tracked)
    return tracked
  }

  private loadReconcileState(
    assignment: ProgressAssignment,
    assignmentFingerprint: string,
  ): SessionReconcileState {
    const rows = this.store.repository.read((db) =>
      db
        .query<{ message_id: string; light: string; full: string | null }, [string, string]>(
          `SELECT message_id,light,full FROM runner_progress_reconciled
           WHERE project_directory=? AND attempt_id=?`,
        )
        .all(this.store.repository.projectDirectory, assignment.attemptID),
    )
    const stamps = new Map<string, ReconciledStamp>()
    for (const row of rows)
      stamps.set(row.message_id, { light: row.light, ...(row.full ? { full: row.full } : {}) })
    return {
      assignmentFingerprint,
      stamps,
      verifyCursor: 0,
      gapsRecorded: false,
      boundRecorded: false,
    }
  }

  private *reconcileSteps(
    sessionID: string,
    rawMessages: readonly unknown[],
  ): Generator<void, void, void> {
    const messages = rawMessages.slice(0, 10_000)
    const hasMoreThanBound = rawMessages.length > messages.length
    this.reconcileReminder(sessionID, rawMessages)
    const assignment = this.assignmentForSession(sessionID)
    if (!assignment) {
      this.reconcileStates.delete(sessionID)
      return
    }
    const assignmentFingerprint = recoveryAssignmentFingerprint(assignment)
    let state = this.reconcileStates.get(sessionID)
    if (!state || state.assignmentFingerprint !== assignmentFingerprint)
      state = this.loadReconcileState(assignment, assignmentFingerprint)
    // Bounded per-recorder LRU of warm sessions; evicted sessions reload from SQLite.
    this.reconcileStates.delete(sessionID)
    this.reconcileStates.set(sessionID, state)
    while (this.reconcileStates.size > MAX_RECONCILE_STATES) {
      const oldest = this.reconcileStates.keys().next().value
      if (oldest === undefined) break
      this.reconcileStates.delete(oldest)
    }

    // 1. Cheap per-message change stamps decide what is new or changed.
    const dirty: DirtyMessage[] = []
    const dirtyIDs = new Set<string>()
    let sliceStart = performance.now()
    for (const raw of messages) {
      const id = text(object(raw)?.id)
      if (!id) continue
      this.reconcileStats.stamped++
      const light = messageLightSignature(raw)
      const stamp = state.stamps.get(id)
      if (light === undefined || stamp?.light !== light) {
        dirty.push({ raw, id, light })
        dirtyIDs.add(id)
      }
      if (performance.now() - sliceStart > RECONCILE_SLICE_MS) {
        yield
        sliceStart = performance.now()
      }
    }

    // 2. Rolling content verification: a bounded window per run re-checks the full
    // fingerprint of messages the light stamp calls unchanged, covering its blind spot.
    const verifyCount = Math.min(RECONCILE_VERIFY_PER_RUN, messages.length)
    for (let n = 0; n < verifyCount; n++) {
      const raw = messages[state.verifyCursor++ % messages.length]
      const id = text(object(raw)?.id)
      if (!id || dirtyIDs.has(id)) continue
      const stamp = state.stamps.get(id)
      if (!stamp?.full) continue
      const full = messageFullFingerprint(raw)
      if (full !== undefined && full !== stamp.full) {
        dirty.push({ raw, id, light: stamp.light })
        dirtyIDs.add(id)
      }
    }

    // 3. Process the backlog in bounded transactions, yielding between them.
    let index = 0
    while (index < dirty.length) {
      const done: DirtyMessage[] = []
      let stale = false
      const chunkStart = performance.now()
      this.store.atomic((db) => {
        const current = this.assignmentQuery(db, "session", sessionID)
        if (!current || recoveryAssignmentFingerprint(current) !== assignmentFingerprint) {
          stale = true
          return
        }
        while (index < dirty.length && done.length < RECONCILE_CHUNK_MESSAGES) {
          if (done.length > 0 && performance.now() - chunkStart > RECONCILE_SLICE_MS) break
          const item = dirty[index++]!
          this.reconcileMessageIn(db, current, item.raw)
          this.reconcileStats.messages++
          item.full = item.light === undefined ? undefined : messageFullFingerprint(item.raw)
          // Unusual retained data (no full fingerprint) is never stamped: it always reprocesses.
          if (item.light !== undefined && item.full !== undefined) {
            db.query(
              `INSERT INTO runner_progress_reconciled(project_directory,attempt_id,session_id,message_id,light,full)
               VALUES(?,?,?,?,?,?)
               ON CONFLICT(project_directory,attempt_id,message_id)
               DO UPDATE SET light=excluded.light,full=excluded.full`,
            ).run(
              this.store.repository.projectDirectory,
              current.attemptID,
              sessionID,
              item.id,
              item.light,
              item.full,
            )
          }
          done.push(item)
        }
      })
      if (stale) {
        this.reconcileStates.delete(sessionID)
        return
      }
      for (const item of done)
        if (item.light !== undefined && item.full !== undefined)
          state.stamps.set(item.id, { light: item.light, full: item.full })
      if (index < dirty.length) yield
    }

    // 4. Boundary gaps: once per warm session, again whenever messages changed.
    const needBound = hasMoreThanBound && !state.boundRecorded
    if (dirty.length > 0 || !state.gapsRecorded || needBound) {
      let stale = false
      this.store.atomic((db) => {
        const current = this.assignmentQuery(db, "session", sessionID)
        if (!current || recoveryAssignmentFingerprint(current) !== assignmentFingerprint) {
          stale = true
          return
        }
        if (hasMoreThanBound) {
          this.appendIn(db, current, {
            source: "recovery",
            kind: "gap",
            dedupeKey: `recovery-gap:${current.attemptID}:message-bound`,
            at: Date.now(),
            payload: { reason: "Retained public session context exceeded the recovery bound." },
          })
        }
        this.appendIn(db, current, {
          source: "recovery",
          kind: "gap",
          dedupeKey: `recovery-gap:${current.attemptID}:public-context-only`,
          at: Date.now(),
          payload: {
            reason:
              "The native event stream has no durable cursor and session.context is not guaranteed complete; facts outside retained public messages cannot be reconstructed.",
          },
        })
      })
      if (stale) {
        this.reconcileStates.delete(sessionID)
        return
      }
      state.gapsRecorded = true
      if (hasMoreThanBound) state.boundRecorded = true
    }
  }

  /** Record one retained message's durable facts; the unit of incremental work. */
  private reconcileMessageIn(db: Database, assignment: ProgressAssignment, raw: unknown): void {
    const sessionID = assignment.sessionID
    const message = object(raw)
    const messageID = text(message?.id)
    if (!message || !messageID) return
    const messageTime = object(message.time)
    const messageCreatedAt = dateMillis(messageTime?.created)
    const at = messageCreatedAt ?? Date.now()
    if (
      (message.type === "user" || message.type === "synthetic") &&
      isNativeInput(raw) &&
      typeof message.text === "string"
    ) {
      this.appendIn(db, assignment, {
        source: "recovery",
        sourceType: `retained-${message.type}-message.text`,
        kind: "visible-text",
        dedupeKey: `input:${sessionID}:${messageID}`,
        at,
        messageID,
        payload: {
          text: safeText(message.text, privacyStats()),
          messageType: message.type,
          createdAt: messageCreatedAt ?? null,
        },
      })
    }
    if (message.type === "assistant") {
      const parts = Array.isArray(message.content) ? message.content : []
      for (const [index, rawPart] of parts.entries()) {
        const part = object(rawPart)
        if (!part) continue
        this.reconcileStats.parts++
        const stats = privacyStats()
        if (part.type === "text" && typeof part.text === "string") {
          this.appendIn(db, assignment, {
            source: "recovery",
            sourceType: "retained-assistant-message.text",
            kind: "visible-text",
            dedupeKey: `text:${sessionID}:${messageID}:${index}`,
            at,
            messageID,
            payload: { text: safeText(part.text, stats) },
          })
        } else if (part.type === "tool") {
          this.recordRecoveredToolIn(db, assignment, messageID, part, at)
        }
      }
      const tokens = object(message.tokens)
      const messageCost = number(message.cost)
      const streamedAt = dateMillis(messageTime?.streamed)
      const completedAt = dateMillis(messageTime?.completed)
      const status = message.error
        ? "failed"
        : completedAt !== undefined
          ? "ended"
          : streamedAt !== undefined
            ? "streamed"
            : messageCreatedAt !== undefined
              ? "started"
              : "unknown"
      const assistantTiming = factTiming({
        startedAt: timedEndpoint(
          messageTime?.created,
          "recovery",
          "retained-assistant-message.time.created",
          "Retained assistant message start time",
        ),
        streamedAt: timedEndpoint(
          messageTime?.streamed,
          "recovery",
          "retained-assistant-message.time.streamed",
          "Retained assistant provider response-body end before tool settlement",
        ),
        completedAt: timedEndpoint(
          messageTime?.completed,
          "recovery",
          "retained-assistant-message.time.completed",
          "Retained assistant completion after tool settlement",
        ),
      })
      const routeEvidence = Object.hasOwn(message, "model")
        ? routeEvidenceFromModel(message.model, privacyStats())
        : undefined
      const route = object(routeEvidence?.route)
      if (
        assistantTiming ||
        tokens ||
        messageCost !== undefined ||
        message.error ||
        routeEvidence
      ) {
        const payload: Record<string, unknown> = {
          status,
          ...(routeEvidence ? { routeEvidence } : {}),
          ...(route ? { route } : {}),
          ...(tokens || messageCost !== undefined
            ? {
                measurementBasis: "additive-step-measurement",
                usage: measuredUsage(tokens, messageCost),
              }
            : {}),
          observations: [
            {
              source: "recovery",
              eventType: "retained-assistant-message",
              at: messageCreatedAt ?? null,
              unit: EPOCH_MILLIS,
              meaning: "Retained assistant message creation when available; endpoints are separate",
              status,
              messageID,
              ...(route ? { route } : {}),
              ...(routeEvidence ? { routeEvidence } : {}),
            },
          ],
          ...(assistantTiming ? { timing: assistantTiming } : {}),
          ...(message.error ? { error: errorView(message.error, privacyStats()) } : {}),
        }
        this.appendIn(db, assignment, {
          source: "recovery",
          sourceType: "retained-assistant-message",
          kind: "step",
          dedupeKey: `step:${sessionID}:${messageID}`,
          at,
          messageID,
          payload,
        })
      }
      const retry = object(message.retry)
      if (retry) {
        const retryAttempt = number(retry.attempt)
        const error = errorView(retry.error, privacyStats())
        const retryAt = dateMillis(retry.at)
        const retryTiming = factTiming({
          scheduledAt: timedEndpoint(
            retry.at,
            "recovery",
            "retained-assistant-message.retry.at",
            "Retained provider retry scheduled time",
          ),
        })
        this.appendIn(db, assignment, {
          source: "recovery",
          sourceType: "retained-assistant-message.retry",
          kind: "provider-retry",
          dedupeKey: `retry:${sessionID}:${messageID}:${retryAttempt ?? "unknown"}`,
          at: retryAt ?? at,
          messageID,
          payload: {
            ...(retryAttempt !== undefined ? { attempt: retryAttempt } : {}),
            ...(error !== undefined ? { error } : {}),
            ...(retryTiming ? { timing: retryTiming } : {}),
          },
        })
      }
      if (message.error) {
        this.appendIn(db, assignment, {
          source: "recovery",
          sourceType: "retained-assistant-message.error",
          kind: "execution-outcome",
          dedupeKey: `assistant-error:${sessionID}:${messageID}`,
          at,
          messageID,
          payload: { outcome: "failed", error: errorView(message.error, privacyStats()) },
        })
      }
      return
    }
    if (message.type === "shell") {
      const stats = privacyStats()
      const shellID = text(message.shellID)
      if (shellID) {
        const output = object(message.output)
        const shellOutput = text(output?.output)
        const shellTiming = factTiming({
          createdAt: timedEndpoint(
            messageTime?.created,
            "recovery",
            "retained-shell-message.time.created",
            "Retained shell message creation; not process start",
          ),
          completedAt: timedEndpoint(
            messageTime?.completed,
            "recovery",
            "retained-shell-message.time.completed",
            "Retained shell completion time",
          ),
        })
        this.appendIn(db, assignment, {
          source: "recovery",
          sourceType: "retained-shell-message",
          kind: "shell",
          dedupeKey: `shell:${sessionID}:${shellID}`,
          at,
          messageID,
          payload: {
            shellID,
            status: text(message.status) ?? "unknown",
            ...(text(message.command) ? { command: safeText(text(message.command)!, stats) } : {}),
            ...(number(message.exit) !== undefined ? { exit: number(message.exit) } : {}),
            ...(shellOutput ? { output: safeText(shellOutput, stats) } : {}),
            ...(output?.truncated === true ? { truncated: true } : {}),
            ...(shellTiming ? { timing: shellTiming } : {}),
          },
        })
      }
      return
    }
    if (message.type === "idle") {
      const outcome = text(message.outcome)
      const error = errorView(message.error, privacyStats())
      this.appendIn(db, assignment, {
        source: "recovery",
        sourceType: "retained-session-idle-message",
        kind: "execution-outcome",
        dedupeKey: `turn:${sessionID}:${messageID}`,
        at,
        messageID,
        payload: {
          outcome:
            outcome && ["succeeded", "failed", "interrupted"].includes(outcome)
              ? outcome
              : "unknown",
          ...(error !== undefined ? { error } : {}),
          basis: "retained-session-turn-marker",
        },
      })
      return
    }
    if (message.type === "compaction") {
      this.appendIn(db, assignment, {
        source: "recovery",
        sourceType: "retained-compaction-message",
        kind: "gap",
        dedupeKey: `compaction-gap:${sessionID}:${messageID}`,
        at,
        messageID,
        payload: {
          reason:
            "Session compaction may omit earlier public messages; the private summary is not retained in progress facts.",
        },
      })
    }
  }

  private recordRecoveredToolIn(
    db: Database,
    assignment: ProgressAssignment,
    messageID: string,
    part: JsonObject,
    at: number,
  ) {
    const toolID = text(part.id)
    if (!toolID) return
    const state = object(part.state)
    const status = text(state?.status)
    const executed = typeof part.executed === "boolean" ? part.executed : undefined
    const stats = privacyStats()
    const projectedStatus =
      executed === false
        ? "not-executed"
        : status === "completed"
          ? "succeeded"
          : status === "error"
            ? "failed"
            : status === "running" || status === "streaming"
              ? "running"
              : "unknown"
    const partTime = object(part.time)
    const phase =
      status === "completed" || status === "error"
        ? 2
        : status === "running" ||
            status === "streaming" ||
            dateMillis(partTime?.ran) !== undefined ||
            executed !== undefined
          ? 1
          : 0
    const timing = factTiming({
      inputAt: timedEndpoint(
        partTime?.created,
        "recovery",
        "retained-assistant-tool.time.created",
        "Retained assistant tool input creation boundary",
      ),
      calledAt: timedEndpoint(
        partTime?.ran,
        "recovery",
        "retained-assistant-tool.time.ran",
        "Retained assistant tool call boundary; not proof that the tool executed",
      ),
      completedAt: timedEndpoint(
        partTime?.completed,
        "recovery",
        "retained-assistant-tool.time.completed",
        "Retained assistant tool result terminal boundary",
      ),
    })
    const payload: Record<string, unknown> = {
      ...(text(part.name) ? { tool: safeText(text(part.name)!, stats, 160) } : {}),
      status: projectedStatus,
      ...(dateMillis(partTime?.ran) !== undefined || executed !== undefined
        ? { callStatus: "called" }
        : {}),
      ...(typeof executed === "boolean"
        ? {
            execution: {
              status: executed ? "executed" : "not-executed",
              source: "recovery",
              sourceType: "retained-assistant-tool.executed",
              phase,
              meaning: "Retained explicit executed flag; timing alone is not execution proof",
            },
          }
        : {}),
      ...(timing ? { timing } : {}),
      observations: [
        {
          source: "recovery",
          eventType: "retained-tool-message",
          at: null,
          unit: EPOCH_MILLIS,
          meaning: "Retained tool state; timing endpoints are separate",
          status: projectedStatus,
          phase,
          messageID,
          ...(text(part.name) ? { tool: safeText(text(part.name)!, stats, 160) } : {}),
        },
      ],
    }
    if ((status === "completed" || status === "error") && !targetOnlyTool(text(part.name))) {
      const content = visibleContent(state?.content, stats)
      if (content !== undefined) payload.content = content
    }
    if (status === "error") {
      const error = errorView(state?.error, stats)
      if (error !== undefined) payload.error = error
    }
    const fact: Fact = {
      source: "recovery",
      sourceType: "retained-assistant-tool",
      kind: "tool",
      dedupeKey: `tool:${assignment.sessionID}:${toolID}`,
      at,
      callID: toolID,
      messageID,
      payload,
    }
    this.appendToolCallIn(db, assignment.sessionID, fact)
    this.appendIn(db, assignment, fact)
  }

  recordSessionSnapshot(sessionID: string, value: unknown): number | undefined {
    const session = object(value)
    if (!session) return undefined
    const tokens = object(session.tokens)
    const cost = number(session.cost)
    if (!tokens && cost === undefined) return undefined
    const at = dateMillis(object(session.time)?.updated) ?? Date.now()
    return this.appendForSession(sessionID, {
      source: "recovery",
      kind: "usage-snapshot",
      dedupeKey: `usage-snapshot:${sessionID}`,
      at,
      payload: {
        measurementBasis: "cumulative-session-snapshot",
        usage: measuredUsage(tokens, cost),
      },
    })
  }

  recordSessionOutcome(sessionID: string, value: unknown): number | undefined {
    const session = object(value)
    const outcome = text(session?.outcome)
    if (!outcome || !["succeeded", "failed", "interrupted"].includes(outcome)) return undefined
    const at = dateMillis(object(session?.time)?.idle)
    if (at === undefined)
      return this.markRecoveryGap(
        sessionID,
        "Session outcome has no native idle boundary; no execution identity is inferred.",
        "outcome-identity",
      )
    return this.appendForSession(sessionID, {
      source: "recovery",
      kind: "outcome-snapshot",
      dedupeKey: `outcome-snapshot:${sessionID}`,
      at,
      // A session aggregate exposes no terminal event ID. Keep it non-additive,
      // separate from identified executions; time.idle can advance within 1 ms.
      payload: {
        outcome,
        basis: "cumulative-session-outcome-snapshot",
        additive: false,
        turnIdentity: "unavailable",
      },
    })
  }

  markRecoveryGap(sessionID: string, reason: string, category = "unavailable"): number | undefined {
    const stats = privacyStats()
    return this.store.atomic((db) => {
      const assignment = this.assignmentQuery(db, "session", sessionID)
      if (!assignment) return undefined
      const reminder = db
        .query<{ message_id: string | null; status: string }, [string, string]>(
          "SELECT message_id,status FROM runner_progress_reminders WHERE attempt_id=? AND session_id=?",
        )
        .get(assignment.attemptID, sessionID)
      if (reminder?.message_id && reminder.status === "dispatching")
        this.completeReminderIn(
          db,
          assignment.attemptID,
          sessionID,
          reminder.message_id,
          "unknown",
          Date.now(),
        )
      return this.appendIn(db, assignment, {
        source: "recovery",
        kind: "gap",
        dedupeKey: `recovery-gap:${assignment.attemptID}:${category}`,
        at: Date.now(),
        payload: { reason: safeText(reason, stats, 500) },
      })
    })
  }

  recordVerification(attemptID: string, effectID: string, receipt: unknown): number | undefined {
    const assignment = this.store.atomic((db) => this.assignmentQuery(db, "attempt", attemptID))
    const result = object(receipt)
    if (!assignment || !result) return undefined
    const exitCode = number(result.exitCode)
    const timedOut = typeof result.timedOut === "boolean" ? result.timedOut : null
    const unchanged = typeof result.unchanged === "boolean" ? result.unchanged : null
    const passed = exitCode === 0 && timedOut === false
    const startedAt = dateMillis(result.startedAt)
    const endedAt = dateMillis(result.endedAt)
    const timing = factTiming({
      startedAt: timedEndpoint(
        result.startedAt,
        "runtime",
        "verification.receipt.startedAt",
        "LAZERS verification command start time",
      ),
      completedAt: timedEndpoint(
        result.endedAt,
        "runtime",
        "verification.receipt.endedAt",
        "LAZERS verification command completion time",
      ),
    })
    return this.store.atomic((db) =>
      this.appendIn(db, assignment, {
        source: "runtime",
        sourceType: "verification.receipt",
        kind: "verification",
        dedupeKey: `verification:${attemptID}:${effectID}`,
        at: endedAt ?? Date.now(),
        payload: {
          checkID: text(result.id) ?? "unknown",
          result: passed ? "passed" : "failed",
          exitCode: exitCode ?? null,
          timedOut,
          unchanged,
          ...(text(result.artifact) ? { artifact: text(result.artifact) } : {}),
          ...(text(result.command)
            ? { command: safeText(text(result.command)!, privacyStats()) }
            : {}),
          startedAt,
          endedAt,
          ...(timing ? { timing } : {}),
        },
      }),
    )
  }

  recordVerificationError(
    attemptID: string,
    effectID: string,
    checkID: string,
    error: unknown,
  ): number | undefined {
    const assignment = this.store.atomic((db) => this.assignmentQuery(db, "attempt", attemptID))
    if (!assignment) return undefined
    const stats = privacyStats()
    return this.store.atomic((db) =>
      this.appendIn(db, assignment, {
        source: "runtime",
        kind: "verification",
        dedupeKey: `verification:${attemptID}:${effectID}`,
        at: Date.now(),
        payload: {
          checkID: safeText(checkID, stats, 120),
          result: "unknown",
          error: safeError(error, stats),
        },
      }),
    )
  }

  recordArtifact(attemptID: string, commit: string): number | undefined {
    const assignment = this.store.atomic((db) => this.assignmentQuery(db, "attempt", attemptID))
    if (!assignment) return undefined
    return this.store.atomic((db) =>
      this.appendIn(db, assignment, {
        source: "runtime",
        kind: "artifact",
        dedupeKey: `artifact:${attemptID}:${commit}`,
        at: Date.now(),
        payload: { commit: safeText(commit, privacyStats(), 128) },
      }),
    )
  }

  recordAttemptOutcome(attemptID: string, outcome: string, reason?: string): number | undefined {
    const assignment = this.store.atomic((db) => this.assignmentQuery(db, "attempt", attemptID))
    if (!assignment) return undefined
    const stats = privacyStats()
    return this.store.atomic((db) =>
      this.appendIn(db, assignment, {
        source: "runtime",
        kind: "execution-outcome",
        dedupeKey: `runtime-outcome:${attemptID}:${outcome}`,
        at: Date.now(),
        payload: {
          outcome: safeText(outcome, stats, 120),
          ...(reason ? { reason: safeText(reason, stats, 500) } : {}),
          basis: "runtime observation; not acceptance authority",
        },
      }),
    )
  }

  claimReminder(sessionID: string, message: string, messageID: string): ReminderClaim | undefined {
    const stats = privacyStats()
    const safeMessage = safeText(message, stats, 500)
    return this.store.atomic((db) => {
      const assignment = this.assignmentQuery(db, "session", sessionID)
      if (!assignment || !activeAttempt(assignment.attemptState)) return undefined
      const existing = db
        .query<
          {
            session_id: string
            message_id: string | null
            ownership_json: string | null
            attempts: number
            status: string
          },
          [string]
        >(
          "SELECT session_id,message_id,ownership_json,attempts,status FROM runner_progress_reminders WHERE attempt_id=?",
        )
        .get(assignment.attemptID)
      let attemptNumber = 1
      let stableMessageID = messageID
      if (existing) {
        if (
          existing.session_id !== sessionID ||
          !existing.message_id ||
          existing.status !== "rejected" ||
          existing.attempts >= 2
        )
          return undefined
        stableMessageID = existing.message_id
      }
      const ownership: ReminderOwnership = {
        lazersKind: "worker-progress-reminder",
        lazersAssignedMessageID: assignment.assignedMessageID,
        lazersProjectID: assignment.projectID,
        lazersProjectDirectory: this.store.repository.projectDirectory,
        lazersPlanID: assignment.planID,
        lazersTaskID: assignment.taskID,
        lazersAttemptID: assignment.attemptID,
        lazersSessionID: assignment.sessionID,
        lazersMessageID: stableMessageID,
      }
      if (existing) {
        let existingOwnership: unknown
        try {
          existingOwnership = existing.ownership_json
            ? JSON.parse(existing.ownership_json)
            : undefined
        } catch {
          return undefined
        }
        if (!sameReminderOwnership(existingOwnership, ownership)) return undefined
        attemptNumber = existing.attempts + 1
        const changed = db
          .query(
            `UPDATE runner_progress_reminders SET status='dispatching',attempts=?,updated_at=?
             WHERE attempt_id=? AND session_id=? AND message_id=? AND status='rejected' AND attempts=?`,
          )
          .run(
            attemptNumber,
            Date.now(),
            assignment.attemptID,
            sessionID,
            stableMessageID,
            existing.attempts,
          ).changes
        if (!changed) return undefined
      } else {
        const now = Date.now()
        const inserted = db
          .query(
            `INSERT OR IGNORE INTO runner_progress_reminders
             (attempt_id,session_id,message_id,ownership_json,created_at,updated_at,attempts,status)
             VALUES(?,?,?,?,?,?,1,'dispatching')`,
          )
          .run(
            assignment.attemptID,
            sessionID,
            stableMessageID,
            JSON.stringify(ownership),
            now,
            now,
          ).changes
        if (!inserted) return undefined
      }
      const sequence = this.appendIn(db, assignment, {
        source: "reminder",
        kind: "reminder",
        dedupeKey: `reminder:${assignment.attemptID}`,
        at: Date.now(),
        messageID: stableMessageID,
        payload: {
          text: safeMessage,
          delivery: "dispatching",
          attempt: attemptNumber,
          nativeMessageID: stableMessageID,
          ownership,
        },
      })
      return {
        attemptID: assignment.attemptID,
        sessionID,
        messageID: stableMessageID,
        sequence,
        attemptNumber,
        ownership,
      }
    })
  }

  finishReminder(claim: ReminderClaim, status: ReminderDelivery, error?: unknown): boolean {
    return this.store.atomic((db) => {
      const assignment = this.assignmentQuery(db, "attempt", claim.attemptID)
      if (
        !assignment ||
        assignment.sessionID !== claim.sessionID ||
        claim.ownership.lazersAttemptID !== claim.attemptID ||
        claim.ownership.lazersMessageID !== claim.messageID
      )
        return false
      const row = db
        .query<{ seq: number; payload: string }, [string, string, string, string]>(
          "SELECT seq,payload FROM runner_progress WHERE project_directory=? AND attempt_id=? AND dedupe_key=? AND message_id=?",
        )
        .get(
          this.store.repository.projectDirectory,
          claim.attemptID,
          `reminder:${claim.attemptID}`,
          claim.messageID,
        )
      if (!row) return false
      const changed = db
        .query(
          `UPDATE runner_progress_reminders SET status=?,updated_at=?
           WHERE attempt_id=? AND session_id=? AND message_id=? AND ownership_json=?
             AND status='dispatching'`,
        )
        .run(
          status,
          Date.now(),
          claim.attemptID,
          claim.sessionID,
          claim.messageID,
          JSON.stringify(claim.ownership),
        ).changes
      if (!changed) return false
      const payload = object(JSON.parse(row.payload)) ?? {}
      payload.delivery = status
      payload.deliveryAttempt = claim.attemptNumber
      if (error !== undefined) payload.deliveryError = safeError(error, privacyStats())
      else if (status === "admitted") delete payload.deliveryError
      this.updateProgressPayloadIn(db, row.seq, payload)
      return true
    })
  }

  private reminderClaimIn(db: Database, attemptID: string, sessionID: string, messageID: string) {
    const row = db
      .query<{ ownership_json: string; status: string }, [string, string, string]>(
        `SELECT ownership_json,status FROM runner_progress_reminders
         WHERE attempt_id=? AND session_id=? AND message_id=?`,
      )
      .get(attemptID, sessionID, messageID)
    if (!row) return undefined
    let ownership: unknown
    try {
      ownership = JSON.parse(row.ownership_json)
    } catch {
      return undefined
    }
    const parsedOwnership = object(ownership)
    if (
      !parsedOwnership ||
      parsedOwnership.lazersKind !== "worker-progress-reminder" ||
      parsedOwnership.lazersAttemptID !== attemptID ||
      parsedOwnership.lazersSessionID !== sessionID ||
      parsedOwnership.lazersMessageID !== messageID
    )
      return undefined
    return { ownership: parsedOwnership as unknown as ReminderOwnership, status: row.status }
  }

  private completeReminderIn(
    db: Database,
    attemptID: string,
    sessionID: string,
    messageID: string,
    status: ReminderDelivery,
    at: number,
    eventID?: string,
  ) {
    const assignment = this.assignmentQuery(db, "attempt", attemptID)
    const claim = this.reminderClaimIn(db, attemptID, sessionID, messageID)
    if (
      !assignment ||
      assignment.sessionID !== sessionID ||
      !claim ||
      claim.ownership.lazersProjectID !== assignment.projectID ||
      claim.ownership.lazersProjectDirectory !== this.store.repository.projectDirectory ||
      claim.ownership.lazersPlanID !== assignment.planID ||
      claim.ownership.lazersTaskID !== assignment.taskID
    )
      return undefined
    const nextStatus = claim.status === "admitted" && status === "unknown" ? "admitted" : status
    const existingProgress = db
      .query<{ seq: number; payload: string }, [string, string, string, string]>(
        "SELECT seq,payload FROM runner_progress WHERE project_directory=? AND attempt_id=? AND dedupe_key=? AND message_id=?",
      )
      .get(this.store.repository.projectDirectory, attemptID, `reminder:${attemptID}`, messageID)
    if (!existingProgress) return undefined
    let previousPayload: JsonObject = {}
    try {
      previousPayload = object(JSON.parse(existingProgress.payload)) ?? {}
    } catch {
      // The safe current projection will repair malformed legacy JSON below.
    }
    const previousAt = number(previousPayload.reconciledAt)
    const reconciledAt =
      previousPayload.delivery === nextStatus && previousAt !== undefined ? previousAt : at
    if (claim.status !== nextStatus) {
      const changed = db
        .query(
          `UPDATE runner_progress_reminders SET status=?,updated_at=?
           WHERE attempt_id=? AND session_id=? AND message_id=? AND ownership_json=?
             AND status IN ('dispatching','unknown','admitted')`,
        )
        .run(
          nextStatus,
          Date.now(),
          attemptID,
          sessionID,
          messageID,
          JSON.stringify(claim.ownership),
        ).changes
      if (!changed) return undefined
    }
    const sequence = this.appendIn(db, assignment, {
      source: eventID ? "native-event" : "recovery",
      kind: "reminder",
      dedupeKey: `reminder:${attemptID}`,
      at: reconciledAt,
      ...(eventID ? { eventID } : {}),
      messageID,
      payload: {
        delivery: nextStatus,
        reconciledAt,
        ...(eventID ? { nativeEventID: eventID } : {}),
      },
    })
    const row = db
      .query<{ payload: string }, [number]>("SELECT payload FROM runner_progress WHERE seq=?")
      .get(sequence)
    if (row) {
      const payload = object(JSON.parse(row.payload)) ?? {}
      delete payload.deliveryError
      this.updateProgressPayloadIn(db, sequence, payload)
    }
    return sequence
  }

  observeReminderAdmission(
    sessionID: string,
    metadata: unknown,
    eventID: string,
    at: number,
  ): number | undefined {
    const value = object(metadata)
    if (
      value?.lazersKind !== "worker-progress-reminder" ||
      typeof value.lazersAttemptID !== "string" ||
      typeof value.lazersMessageID !== "string"
    )
      return undefined
    return this.store.atomic((db) =>
      (() => {
        const attemptID = value.lazersAttemptID as string
        const messageID = value.lazersMessageID as string
        const claim = this.reminderClaimIn(db, attemptID, sessionID, messageID)
        if (!claim || !sameReminderOwnership(value, claim.ownership)) return undefined
        return this.completeReminderIn(db, attemptID, sessionID, messageID, "admitted", at, eventID)
      })(),
    )
  }

  reconcileReminder(sessionID: string, messages: readonly unknown[]): void {
    this.store.atomic((db) => {
      const assignment = this.assignmentQuery(db, "session", sessionID)
      if (!assignment) return
      const reminder = db
        .query<{ message_id: string | null; status: string }, [string, string]>(
          "SELECT message_id,status FROM runner_progress_reminders WHERE attempt_id=? AND session_id=?",
        )
        .get(assignment.attemptID, sessionID)
      if (!reminder) return
      if (!reminder.message_id) {
        this.appendIn(db, assignment, {
          source: "recovery",
          kind: "reminder",
          dedupeKey: `reminder:${assignment.attemptID}`,
          at: Date.now(),
          payload: {
            delivery: "unknown",
            recoveryGap: "The prior reminder claim has no stable native message ID.",
          },
        })
        this.markRecoveryGapIn(
          db,
          assignment,
          "A legacy reminder claim has no persisted native message ID; admission cannot be determined or resent safely.",
          "reminder-identity",
        )
        return
      }
      let matching: JsonObject | undefined
      for (const candidate of messages) {
        const message = object(candidate)
        if (message?.type === "synthetic" && message.id === reminder.message_id) {
          matching = message
          break
        }
      }
      const metadata = object(matching?.metadata)
      const claim = this.reminderClaimIn(db, assignment.attemptID, sessionID, reminder.message_id)
      const matchesOwnership = Boolean(claim && sameReminderOwnership(metadata, claim.ownership))
      if (matchesOwnership) {
        this.completeReminderIn(
          db,
          assignment.attemptID,
          sessionID,
          reminder.message_id,
          "admitted",
          Date.now(),
        )
      } else if (reminder.status === "dispatching") {
        this.completeReminderIn(
          db,
          assignment.attemptID,
          sessionID,
          reminder.message_id,
          "unknown",
          Date.now(),
        )
      }
    })
  }

  private markRecoveryGapIn(
    db: Database,
    assignment: ProgressAssignment,
    reason: string,
    category: string,
  ) {
    const stats = privacyStats()
    return this.appendIn(db, assignment, {
      source: "recovery",
      kind: "gap",
      dedupeKey: `recovery-gap:${assignment.attemptID}:${category}`,
      at: Date.now(),
      payload: { reason: safeText(reason, stats, 500) },
    })
  }
}
