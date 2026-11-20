import { createHmac, timingSafeEqual } from "node:crypto"
import { canonical, fingerprint } from "../identity.ts"
import {
  ManagedUsageAssociationSchema,
  ManagedUsageReadInputSchema,
  ManagedUsageScopeSchema,
  type ManagedUsageAssociation,
  type ManagedUsageReadInput,
  type ManagedUsageScope,
} from "./contract.ts"
import type {
  ManagedUsageCallValuation,
  ManagedUsagePriceProvider,
} from "../models/managed-usage-valuation.ts"
import {
  ManagedUsageCallValuationSchema,
  ManagedUsageCurrentPriceSchema,
  managedUsageTotals,
  ManagedUsageTotalsSchema,
} from "../models/managed-usage-valuation.ts"
import { managedUsageGenerations } from "./projection.ts"
import type { ManagedUsageGeneration } from "./projection.ts"
import type { ManagedUsageSnapshot, ManagedUsageStore } from "./store.ts"
import { z } from "zod"

const MAX_GENERATIONS = 100_000
const MAX_ALLOCATION_SUMMARIES = 2_000
const MAX_GAP_SAMPLES = 100

const CursorSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scopeFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  captureRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  priceSnapshotFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().nonnegative().max(MAX_GENERATIONS),
})
type Cursor = z.infer<typeof CursorSchema>

const CaptureGapSchema = z.strictObject({
  sessionID: z.string().min(1).max(256),
  kind: z.enum([
    "listener-started",
    "stream-failed",
    "stream-ended",
    "listener-stopped",
    "authority-changed",
    "observation-failed",
    "unidentified-event",
    "unsequenced-event",
    "buffer-overflow",
  ]),
  recordedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})

const AllocationSummarySchema = z.strictObject({
  association: ManagedUsageAssociationSchema,
  totals: ManagedUsageTotalsSchema,
})

export const ManagedUsageReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: ManagedUsageScopeSchema,
  capture: z.strictObject({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    storedFactCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    factConflictCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    boundaryCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    truncated: z.boolean(),
  }),
  coverage: z.strictObject({
    status: z.enum(["observed", "partial", "missing", "unavailable"]),
    generationCount: z.number().int().nonnegative().max(MAX_GENERATIONS),
    observedGenerationCount: z.number().int().nonnegative().max(MAX_GENERATIONS),
    partialGenerationCount: z.number().int().nonnegative().max(MAX_GENERATIONS),
    missingGenerationCount: z.number().int().nonnegative().max(MAX_GENERATIONS),
    unavailableGenerationCount: z.number().int().nonnegative().max(MAX_GENERATIONS),
    unallocatedGenerationCount: z.number().int().nonnegative().max(MAX_GENERATIONS),
    pendingGenerationCount: z.number().int().nonnegative().max(MAX_GENERATIONS),
    conflictingGenerationCount: z.number().int().nonnegative().max(MAX_GENERATIONS),
    captureGapCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    captureGapSampleCount: z.number().int().nonnegative().max(MAX_GAP_SAMPLES),
    captureGapsTruncated: z.boolean(),
    allocationSummariesTruncated: z.boolean(),
    snapshotTruncated: z.boolean(),
  }),
  totals: ManagedUsageTotalsSchema,
  allocationSummaries: z.array(AllocationSummarySchema).max(MAX_ALLOCATION_SUMMARIES),
  calls: z.array(ManagedUsageCallValuationSchema).max(100),
  currentPrice: ManagedUsageCurrentPriceSchema.nullable(),
  captureGaps: z.array(CaptureGapSchema).max(MAX_GAP_SAMPLES),
  nextCursor: z.string().max(4_096).nullable(),
})
export type ManagedUsageReport = z.infer<typeof ManagedUsageReportSchema>

type ScopedSnapshot = {
  generations: ManagedUsageGeneration[]
  generationsTruncated: boolean
  sessionIDs: Set<string>
  gaps: ManagedUsageSnapshot["listenerGaps"]
  gapCount: number
  gapsTruncated: boolean
}

function associationMatchesScope(association: ManagedUsageAssociation, scope: ManagedUsageScope) {
  if (scope.kind === "project") return true
  if (association.kind === "unallocated" || association.planID !== scope.planID) return false
  return (
    scope.kind === "plan" || (association.kind === "task" && association.taskID === scope.taskID)
  )
}

function scopedSnapshot(snapshot: ManagedUsageSnapshot, scope: ManagedUsageScope): ScopedSnapshot {
  const sessionIDs = new Set(
    snapshot.boundaries
      .filter((boundary) => associationMatchesScope(boundary.association, scope))
      .map((boundary) => boundary.sessionID),
  )
  const allGenerations = managedUsageGenerations(snapshot)
  const matched = allGenerations.filter(
    (generation) =>
      scope.kind === "project" || associationMatchesScope(generation.association, scope),
  )
  const generations = matched.slice(0, MAX_GENERATIONS)
  const gaps = snapshot.listenerGaps.filter((gap) => sessionIDs.has(gap.sessionID))
  const scopedGapCount = snapshot.listenerGapCounts
    .filter((item) => sessionIDs.has(item.sessionID))
    .reduce((total, item) => total + item.count, 0)
  return {
    generations,
    generationsTruncated: matched.length > MAX_GENERATIONS,
    sessionIDs,
    gaps: gaps.slice(0, MAX_GAP_SAMPLES),
    gapCount: scopedGapCount,
    gapsTruncated:
      snapshot.gapsTruncated ||
      scopedGapCount > MAX_GAP_SAMPLES ||
      snapshot.listenerGapCountsTruncated,
  }
}

function encodeCursor(cursor: Cursor, secret: Uint8Array) {
  const body = Buffer.from(canonical(cursor)).toString("base64url")
  const signature = createHmac("sha256", secret).update(body).digest("base64url")
  return `${body}.${signature}`
}

function decodeCursor(value: string, secret: Uint8Array): Cursor {
  const [body, signature, extra] = value.split(".")
  if (!body || !signature || extra !== undefined) throw new Error("Managed usage cursor is invalid")
  const expected = createHmac("sha256", secret).update(body).digest()
  let supplied: Buffer
  try {
    supplied = Buffer.from(signature, "base64url")
  } catch {
    throw new Error("Managed usage cursor is invalid")
  }
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied))
    throw new Error("Managed usage cursor is invalid")
  try {
    return CursorSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")))
  } catch {
    throw new Error("Managed usage cursor is invalid")
  }
}

function allocationKey(association: ManagedUsageAssociation) {
  return canonical(association)
}

function statusForCoverage(input: {
  generationCount: number
  observed: number
  gaps: number
  truncated: boolean
}): ManagedUsageReport["coverage"]["status"] {
  if (input.truncated) return "unavailable"
  if (input.generationCount === 0) return input.gaps > 0 ? "partial" : "missing"
  if (input.gaps === 0 && input.observed === input.generationCount) return "observed"
  return "partial"
}

function allocationSummaries(calls: readonly ManagedUsageCallValuation[]) {
  const groups = new Map<
    string,
    { association: ManagedUsageAssociation; calls: ManagedUsageCallValuation[] }
  >()
  for (const call of calls) {
    const key = allocationKey(call.association)
    const group = groups.get(key) ?? { association: call.association, calls: [] }
    group.calls.push(call)
    groups.set(key, group)
  }
  const values = [...groups.values()].sort((left, right) =>
    allocationKey(left.association).localeCompare(allocationKey(right.association)),
  )
  return {
    values: values.slice(0, MAX_ALLOCATION_SUMMARIES).map(({ association, calls: grouped }) => ({
      association,
      totals: managedUsageTotals(grouped),
    })),
    truncated: values.length > MAX_ALLOCATION_SUMMARIES,
  }
}

export async function readManagedUsageReport(input: {
  store: ManagedUsageStore
  priceProvider: ManagedUsagePriceProvider
  request: ManagedUsageReadInput
  cursorSecret: Uint8Array
  signal: AbortSignal
}): Promise<ManagedUsageReport> {
  const request = ManagedUsageReadInputSchema.parse(input.request)
  const scopeFingerprint = fingerprint(request.scope)
  const cursor = request.cursor ? decodeCursor(request.cursor, input.cursorSecret) : null
  if (cursor && (cursor.scopeFingerprint !== scopeFingerprint || cursor.limit !== request.limit))
    throw new Error("Managed usage cursor does not match this scope or page size")

  input.signal.throwIfAborted()
  const snapshot = input.store.snapshot()
  if (cursor && cursor.captureRevision !== snapshot.revision)
    throw new Error("Managed usage capture changed; restart the report without its cursor")
  const scoped = scopedSnapshot(snapshot, request.scope)
  input.signal.throwIfAborted()
  const valuation = await input.priceProvider(scoped.generations, input.signal)
  input.signal.throwIfAborted()
  const priceSnapshotFingerprint = valuation.currentPrice
    ? fingerprint({
        indexID: valuation.currentPrice.indexID,
        freshness: valuation.currentPrice.freshness,
        policy: valuation.currentPrice.policy,
        access: valuation.currentPrice.access,
        pins: valuation.currentPrice.pins,
      })
    : null
  if (cursor && cursor.priceSnapshotFingerprint !== priceSnapshotFingerprint)
    throw new Error("Managed usage current prices changed; restart the report without its cursor")
  const offset = cursor?.offset ?? 0
  if (offset > valuation.calls.length)
    throw new Error("Managed usage cursor is beyond the current report")
  const page = valuation.calls.slice(offset, offset + request.limit)
  const endOffset = offset + page.length
  const nextCursor =
    endOffset < valuation.calls.length
      ? encodeCursor(
          CursorSchema.parse({
            schemaVersion: 1,
            scopeFingerprint,
            captureRevision: snapshot.revision,
            priceSnapshotFingerprint,
            limit: request.limit,
            offset: endOffset,
          }),
          input.cursorSecret,
        )
      : null
  const counts = {
    observed: valuation.calls.filter((call) => call.status === "observed").length,
    partial: valuation.calls.filter((call) => call.status === "partial").length,
    missing: valuation.calls.filter((call) => call.status === "missing").length,
    unavailable: valuation.calls.filter((call) => call.status === "unavailable").length,
    unallocated: valuation.calls.filter((call) => call.association.kind === "unallocated").length,
    pending: valuation.calls.filter((call) => call.outcome === "pending").length,
    conflicting: valuation.calls.filter((call) => call.outcome === "conflicting").length,
  }
  const snapshotTruncated =
    snapshot.factsTruncated ||
    snapshot.factConflictsTruncated ||
    snapshot.boundariesTruncated ||
    scoped.gapsTruncated ||
    scoped.generationsTruncated
  const allocations = allocationSummaries(valuation.calls)
  return ManagedUsageReportSchema.parse({
    schemaVersion: 1,
    scope: request.scope,
    capture: {
      revision: snapshot.revision,
      storedFactCount: snapshot.factCount,
      factConflictCount: snapshot.factConflictCount,
      boundaryCount: snapshot.boundaryCount,
      truncated: snapshotTruncated,
    },
    coverage: {
      status: statusForCoverage({
        generationCount: valuation.calls.length,
        observed: counts.observed,
        gaps: scoped.gapCount,
        truncated: snapshotTruncated,
      }),
      generationCount: valuation.calls.length,
      observedGenerationCount: counts.observed,
      partialGenerationCount: counts.partial,
      missingGenerationCount: counts.missing,
      unavailableGenerationCount: counts.unavailable,
      unallocatedGenerationCount: counts.unallocated,
      pendingGenerationCount: counts.pending,
      conflictingGenerationCount: counts.conflicting,
      captureGapCount: scoped.gapCount,
      captureGapSampleCount: scoped.gaps.length,
      captureGapsTruncated: scoped.gapsTruncated,
      allocationSummariesTruncated: allocations.truncated,
      snapshotTruncated,
    },
    totals: managedUsageTotals(valuation.calls),
    allocationSummaries: allocations.values,
    calls: page,
    currentPrice: valuation.currentPrice,
    captureGaps: scoped.gaps,
    nextCursor,
  })
}
