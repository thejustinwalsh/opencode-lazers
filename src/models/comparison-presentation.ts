import { z } from "zod"
import type {
  ModelComparisonCandidateSchema,
  ModelComparisonSourceSchema,
} from "./comparison-schema.ts"

const NullableNumber = z.number().finite().nullable()
const Route = z
  .object({
    providerID: z.string(),
    modelID: z.string(),
    variant: z.string().nullable(),
  })
  .strip()
const UsageStatus = z.enum(["observed", "partial", "missing", "unavailable"])
const UsageCategory = z
  .object({
    value: NullableNumber,
    unit: z.literal("tokens"),
    status: UsageStatus,
    valueScope: z.string(),
    sources: z.array(z.string()).optional(),
    sourceTypes: z.array(z.string()).optional(),
    observationTimeBases: z.array(z.string()).optional(),
    observedAtRange: z.object({ earliest: NullableNumber, latest: NullableNumber }).optional(),
    observationCount: z.number().int().nonnegative().optional(),
    missingObservations: z.number().int().nonnegative().optional(),
    missingSessionIDs: z.array(z.string()).optional(),
    bySession: z
      .array(
        z
          .object({
            sessionID: z.string(),
            value: NullableNumber,
            status: UsageStatus,
            basis: z.string(),
            valueScope: z.string(),
            source: z.string().nullable().optional(),
            observedAt: NullableNumber.optional(),
          })
          .strip(),
      )
      .optional(),
  })
  .strip()

export const TaskEffortBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    basis: z.string(),
    attempts: z
      .object({
        count: z.number().int().nonnegative(),
        states: z.array(z.object({ attemptID: z.string(), state: z.string() }).strip()),
      })
      .strip(),
    usage: z
      .object({
        unit: z.literal("tokens"),
        categories: z
          .object({
            uncachedInput: UsageCategory,
            output: UsageCategory,
            reasoning: UsageCategory,
            cacheRead: UsageCategory,
            cacheWrite: UsageCategory,
          })
          .strip(),
        coverage: z
          .object({
            totalUniqueSessions: z.number().int().nonnegative(),
            nativeCumulativeSnapshots: z.number().int().nonnegative(),
            retainedCumulativeSnapshots: z.number().int().nonnegative(),
            additiveStepSubtotals: z.number().int().nonnegative(),
            missingSessions: z.array(z.string()),
            unavailableSessions: z.array(z.string()),
            progressTruncated: z.boolean(),
          })
          .strip(),
      })
      .strip(),
    routes: z
      .object({
        assignments: z.array(
          z
            .object({
              attemptID: z.string(),
              state: z.string(),
              planSelection: z
                .object({
                  route: Route.nullable(),
                  status: z.enum(["explicit", "inherited", "unavailable"]),
                  frozenComparison: z.string(),
                  source: z.string(),
                  meaning: z.string(),
                })
                .strip(),
              frozenAttemptRoute: z
                .object({
                  route: Route.nullable(),
                  status: z.enum(["recorded", "unavailable"]),
                  source: z.string().nullable(),
                  selectionSource: z.string(),
                })
                .strip(),
              persona: z
                .object({
                  requested: z.string().nullable(),
                  requestedStatus: z.string(),
                  frozen: z.string().nullable(),
                  frozenStatus: z.string(),
                  comparison: z.string(),
                })
                .strip(),
            })
            .strip(),
        ),
        assessments: z.array(
          z
            .object({
              attemptID: z.string(),
              sessionID: z.string(),
              requestedRoute: Route.nullable(),
              requestedRouteSource: z.string().nullable(),
              observedRoute: Route.nullable(),
              scope: z.enum(["session", "step"]),
              source: z.string(),
              sourceType: z.string(),
              observedAt: NullableNumber,
              status: z.enum(["match", "mismatch", "unavailable"]),
              frozenRouteStatus: z.enum(["match", "mismatch", "unavailable"]),
            })
            .strip(),
        ),
        usageAttribution: z.string(),
        mixedRoutes: z.boolean(),
        coverage: z
          .object({
            totalUniqueSessions: z.number().int().nonnegative(),
            observedSessionRouteCount: z.number().int().nonnegative(),
            sessionsWithoutCurrentRoute: z.array(z.string()),
            observedStepRouteCount: z.number().int().nonnegative(),
            stepContextsByStatus: z.object({
              available: z.number().int().nonnegative(),
              notRead: z.number().int().nonnegative(),
              unavailable: z.number().int().nonnegative(),
            }),
            progressTruncated: z.boolean(),
            truncatedContextSessionIDs: z.array(z.string()),
            missingSessionIDs: z.array(z.string()),
            unavailableSessionIDs: z.array(z.string()),
          })
          .strip(),
      })
      .strip(),
    cost: z
      .object({
        fullTaskCostUSD: z
          .object({ valueUSD: NullableNumber, status: z.string(), meaning: z.string() })
          .strip(),
        marketEquivalentCostUSD: z
          .object({ valueUSD: NullableNumber, status: z.string(), meaning: z.string() })
          .strip(),
      })
      .strip(),
    quality: z.object({ status: z.string(), value: z.unknown(), meaning: z.string() }).strip(),
  })
  .strip()

export type TaskEffortBasis = z.infer<typeof TaskEffortBasisSchema>
export type ModelCandidate = typeof ModelComparisonCandidateSchema._output
export type ModelSource = typeof ModelComparisonSourceSchema._output

/** Read only the versioned categorized projection; legacy scalar attempt tokens are not a fallback. */
export function readTaskEffortBasis(report: unknown): TaskEffortBasis | undefined {
  if (typeof report !== "object" || report === null || Array.isArray(report)) return undefined
  const effort = (report as Record<string, unknown>).effort
  if (typeof effort !== "object" || effort === null || Array.isArray(effort)) return undefined
  const basis = (effort as Record<string, unknown>).taskEffortBasis
  const result = TaskEffortBasisSchema.safeParse(basis)
  return result.success ? result.data : undefined
}

export function routeLabel(route: {
  providerID: string
  modelID: string
  variant?: string | null
}) {
  return `${route.providerID} / ${route.modelID}${route.variant ? ` · ${route.variant}` : ""}`
}

export function candidateLabel(candidate: ModelCandidate) {
  return routeLabel(candidate.identity)
}

type ModelDisplayRoute = { providerID: string; modelID: string; variant?: string | null }
type CandidateDisplayMetadata = {
  identity: ModelDisplayRoute
  native: { name: string | null }
}
type CatalogDisplayMetadata = { providerID: string; id: string; name: string }

/** Prefer the exact live native catalog entry, then exact cached candidate metadata. */
export function modelDisplayName(
  route: ModelDisplayRoute,
  candidates: readonly CandidateDisplayMetadata[],
  catalog: readonly CatalogDisplayMetadata[],
) {
  const catalogName = catalog.find(
    (entry) => entry.providerID === route.providerID && entry.id === route.modelID,
  )?.name
  if (catalogName?.trim()) return catalogName.trim()

  const candidateName = candidates.find(
    (candidate) =>
      candidate.identity.providerID === route.providerID &&
      candidate.identity.modelID === route.modelID,
  )?.native.name
  return candidateName?.trim() || route.modelID
}

/** Bound visible model labels while preserving full names and routes for accessible names/tooltips. */
export function boundedModelLabel(value: string, maximumLength = 36) {
  const characters = Array.from(value)
  if (characters.length <= maximumLength) return value
  return `${characters.slice(0, Math.max(1, maximumLength - 1)).join("")}…`
}

export function sourceTitle(source: ModelSource["source"]) {
  switch (source) {
    case "native-catalog":
      return "Native OpenCode catalog"
    case "openrouter-models":
      return "OpenRouter model metadata"
    case "openrouter-benchmarks":
      return "External coding benchmarks"
  }
}

export function sourceState(source: ModelSource) {
  if (source.storage === "missing-both-tables") return "Snapshot and refresh history unavailable"
  if (source.storage === "missing-snapshot-table") return "Snapshot storage unavailable"
  if (source.snapshotState === "missing-table") return "Snapshot storage unavailable"
  if (source.storage === "missing-refresh-table") {
    if (source.snapshot)
      return `${source.snapshot.recordCount.toLocaleString()} records · retrieved ${formatDate(source.snapshot.retrievedAt)} · refresh history unavailable`
    return "No cached snapshot · refresh history unavailable"
  }
  if (source.snapshotState === "missing-snapshot" || source.snapshotState === "none")
    return source.refresh?.state === "failed"
      ? "No cached snapshot · latest refresh failed"
      : "No cached snapshot"
  if (!source.snapshot) return "Snapshot unavailable"
  return `${source.snapshot.recordCount.toLocaleString()} records · retrieved ${formatDate(source.snapshot.retrievedAt)}`
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "Date unavailable"
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? "Date unavailable" : parsed.toLocaleString()
}

export function numericValue(value: number | null | undefined) {
  return value === null || value === undefined ? "Unknown" : value.toLocaleString()
}

export function exactRouteMatch(
  route: { providerID: string; modelID: string; variant: string | null } | null,
  candidate: ModelCandidate,
) {
  return Boolean(
    route &&
    route.providerID === candidate.identity.providerID &&
    route.modelID === candidate.identity.modelID &&
    route.variant === candidate.identity.variant,
  )
}

export function candidateFocusIndex(index: number, count: number, key: string) {
  if (count < 1 || !["ArrowUp", "ArrowDown", "Home", "End"].includes(key)) return undefined
  if (key === "Home") return 0
  if (key === "End") return count - 1
  return Math.max(0, Math.min(count - 1, index + (key === "ArrowDown" ? 1 : -1)))
}

export function recordReferenceLabel(reference: {
  source: string
  snapshotID: string
  generation: number
  recordIndex: number
  recordID: string
}) {
  return `${reference.source} · generation ${reference.generation} · record ${reference.recordIndex + 1} (${reference.recordID}) · snapshot ${reference.snapshotID}`
}
