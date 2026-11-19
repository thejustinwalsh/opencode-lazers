import { EPOCH_ATTRIBUTION } from "./source-schema.ts"
import { z } from "zod"
import type {
  ModelComparisonCandidateSchema,
  ModelComparisonSourceSchema,
} from "./comparison-schema.ts"
import type {
  ModelDecisionCohortCounts,
  ModelDecisionEfficiency,
  ModelDecisionEstimate,
} from "./decision-contract.ts"
import type { ModelDecisionReferenceEstimate } from "./reference-estimate.ts"

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

export type CurrentMarketEstimateSummary = {
  amount: string
  context: string
  title: string
}

const compactMarketCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumSignificantDigits: 1,
  maximumSignificantDigits: 3,
})
const scientificMarketCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "scientific",
  maximumSignificantDigits: 3,
})

export function formatMarketAmount(value: number) {
  return value !== 0 && (Math.abs(value) < 0.000001 || Math.abs(value) >= 1_000_000_000_000)
    ? scientificMarketCurrency.format(value).replace("E", "e")
    : compactMarketCurrency.format(value)
}

export function formatMarketRange(range: { minimum: number; maximum: number }) {
  return range.minimum === range.maximum
    ? formatMarketAmount(range.minimum)
    : `${formatMarketAmount(range.minimum)}–${formatMarketAmount(range.maximum)}`
}

/** "current" or "stale"; absent when the age is not known, so callers omit the segment. */
function marketFreshness(value: "current" | "stale" | "unknown" | "unavailable") {
  return value === "current" ? "current" : value === "stale" ? "stale" : undefined
}

/** Joins the segments that exist; a missing fact removes its segment instead of naming the gap. */
export function joinSegments(
  segments: ReadonlyArray<string | null | undefined | false>,
  separator = " · ",
) {
  return segments.filter((segment): segment is string => Boolean(segment)).join(separator)
}

function referenceMarketSummary(estimate: ModelDecisionReferenceEstimate) {
  const freshness = marketFreshness(estimate.provenance.freshness)
  const age = freshness ? ` · ${freshness}` : ""
  const retrievedAt = estimate.provenance.retrievedAt
    ? ` · retrieved ${estimate.provenance.retrievedAt}`
    : ""
  const denominator = `${estimate.acceptedTaskCount} accepted task${estimate.acceptedTaskCount === 1 ? "" : "s"}`

  if (estimate.acceptedTaskCount < 1) return undefined

  if (estimate.status === "exact" && estimate.valueUSDPerAcceptedTask !== null) {
    return {
      amount: `≈${formatMarketAmount(estimate.valueUSDPerAcceptedTask)} / accepted task`,
      context: `OpenRouter model catalog${age}`,
      title: `OpenRouter model catalog scalar reference · exact USD per accepted task ${String(estimate.valueUSDPerAcceptedTask)} · denominator ${denominator} · published model catalog reference cost per accepted task ${age}${retrievedAt}`,
    }
  }
  if (estimate.status === "conditional" && estimate.rangeUSDPerAcceptedTask !== null) {
    return {
      amount: `≈${formatMarketRange(estimate.rangeUSDPerAcceptedTask)} / accepted task`,
      context: `OpenRouter model catalog · range${age}`,
      title: `OpenRouter model catalog conditional range · exact USD per accepted task ${String(estimate.rangeUSDPerAcceptedTask.minimum)}–${String(estimate.rangeUSDPerAcceptedTask.maximum)} · denominator ${denominator} · published model catalog reference cost per accepted task ${age}${retrievedAt}`,
    }
  }
  if (estimate.status !== "partial") return undefined

  if (estimate.knownSubtotalUSDPerAcceptedTask !== null) {
    return {
      amount: `≈${formatMarketAmount(estimate.knownSubtotalUSDPerAcceptedTask)} priced portion / accepted task`,
      context: `OpenRouter model catalog${age}`,
      title: `OpenRouter model catalog known subtotal · exact USD per accepted task ${String(estimate.knownSubtotalUSDPerAcceptedTask)} · total and remainder unknown · denominator ${denominator} · published model catalog reference cost per accepted task ${age}${retrievedAt}`,
    }
  }
  if (estimate.knownSubtotalRangeUSDPerAcceptedTask !== null) {
    return {
      amount: `≈${formatMarketRange(estimate.knownSubtotalRangeUSDPerAcceptedTask)} priced portion / accepted task`,
      context: `OpenRouter model catalog${age}`,
      title: `OpenRouter model catalog known subtotal range · exact USD per accepted task ${String(estimate.knownSubtotalRangeUSDPerAcceptedTask.minimum)}–${String(estimate.knownSubtotalRangeUSDPerAcceptedTask.maximum)} · total and remainder unknown · denominator ${denominator} · published model catalog reference cost per accepted task ${age}${retrievedAt}`,
    }
  }
  return undefined
}

/** Prefer the producer's configured market valuation, then its OpenRouter reference. */
export function currentMarketEstimateSummary(input: {
  estimate: ModelDecisionEstimate
  referenceEstimate?: ModelDecisionReferenceEstimate
  acceptedTaskCount: number
  priceSource: "openrouter" | "opencode" | "mixed" | "unavailable"
  priceFreshness: "current" | "stale" | "unavailable"
}): CurrentMarketEstimateSummary | undefined {
  if (input.acceptedTaskCount < 1) return undefined

  const currentMarket = input.estimate.range.currentMarketUSD
  if (currentMarket) {
    const freshness = marketFreshness(input.priceFreshness)
    const age = freshness ? ` · ${freshness}` : ""
    const source =
      input.priceSource === "openrouter"
        ? "OpenRouter model catalog"
        : input.priceSource === "opencode"
          ? "OpenCode model catalog"
          : input.priceSource === "mixed"
            ? "Configured price sources"
            : "Configured price source"
    const partial = input.estimate.status === "partial"
    const amount = formatMarketRange(currentMarket)
    const isRange = currentMarket.minimum !== currentMarket.maximum
    const missing =
      input.estimate.status === "partial" ? ` · missing ${input.estimate.missing.join(", ")}` : ""
    return {
      amount: `≈${amount}${partial ? " priced portion" : ""} / accepted task`,
      context: `${source}${isRange ? " · range" : ""}${age}`,
      title: `Producer current-market estimate · exact USD per accepted task ${String(currentMarket.minimum)}${isRange ? `–${String(currentMarket.maximum)}` : ""} · ${input.estimate.observationCount} observation(s) · denominator ${input.acceptedTaskCount} accepted task${input.acceptedTaskCount === 1 ? "" : "s"} · ${source}${age}${partial ? " · partial observed cohort" : ""}${missing}`,
    }
  }

  return input.referenceEstimate ? referenceMarketSummary(input.referenceEstimate) : undefined
}

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
  const uniqueName = (names: readonly string[]) => {
    const unique = new Set(names.map((name) => name.trim()).filter(Boolean))
    return unique.size === 1 ? unique.values().next().value : undefined
  }
  const catalogName = uniqueName(
    catalog
      .filter((entry) => entry.providerID === route.providerID && entry.id === route.modelID)
      .map((entry) => entry.name),
  )
  if (catalogName) return catalogName

  const candidateName = uniqueName(
    candidates
      .filter(
        (candidate) =>
          candidate.identity.providerID === route.providerID &&
          candidate.identity.modelID === route.modelID,
      )
      .flatMap((candidate) => (candidate.native.name ? [candidate.native.name] : [])),
  )
  return candidateName || route.modelID
}

/** Keep duplicate catalog names distinguishable without losing the exact catalog name. */
export function modelDisplayLabel(
  route: ModelDisplayRoute,
  routes: readonly ModelDisplayRoute[],
  candidates: readonly CandidateDisplayMetadata[],
  catalog: readonly CatalogDisplayMetadata[],
) {
  const name = modelDisplayName(route, candidates, catalog)
  const routeKey = (candidate: ModelDisplayRoute) =>
    `${candidate.providerID}\u0000${candidate.modelID}\u0000${candidate.variant ?? ""}`
  const matchingRoutes = new Map(
    routes
      .filter((candidate) => modelDisplayName(candidate, candidates, catalog) === name)
      .map((candidate) => [routeKey(candidate), candidate]),
  )
  if (matchingRoutes.size < 2) return name

  return `${name} · ${routeLabel(route)}`
}

/** Bound visible model labels while preserving full names and routes for accessible names/tooltips. */
export function boundedModelLabel(value: string, maximumLength = 36) {
  const characters = Array.from(value)
  if (characters.length <= maximumLength) return value
  return `${characters.slice(0, Math.max(1, maximumLength - 1)).join("")}…`
}

/** Remove route disambiguation from a display label, then retain the selected effort. */
export function modelEffortLabel(value: string, route?: ModelDisplayRoute) {
  if (!route) return value
  const exactRouteSuffix = ` · ${routeLabel(route)}`
  const modelName = value.endsWith(exactRouteSuffix)
    ? value.slice(0, -exactRouteSuffix.length)
    : value
  if (
    route.variant &&
    modelName.toLocaleLowerCase().endsWith(` · ${route.variant}`.toLocaleLowerCase())
  )
    return modelName
  return route.variant ? `${modelName} · ${route.variant}` : modelName
}

/** Bound chart labels without dropping the selected effort at narrow widths. */
export function boundedModelEffortLabel(value: string, maximumLength = 36) {
  const characters = Array.from(value)
  if (characters.length <= maximumLength) return value

  const separator = value.lastIndexOf(" · ")
  if (separator < 0) return boundedModelLabel(value, maximumLength)

  const modelName = value.slice(0, separator)
  const effort = value.slice(separator + 3)
  const effortBudget = Math.max(1, maximumLength - 5)
  const visibleEffort =
    Array.from(effort).length <= effortBudget
      ? effort
      : effortBudget === 1
        ? "…"
        : `…${Array.from(effort)
            .slice(-(effortBudget - 1))
            .join("")}`
  const suffix = ` · ${visibleEffort}`
  const nameBudget = Math.max(1, maximumLength - Array.from(suffix).length - 1)
  return `${Array.from(modelName).slice(0, nameBudget).join("")}…${suffix}`
}

/** Bound both lines of the visible identity badge; the full exact route stays in accessible detail. */
export function chartModelEffortLabel(
  value: string,
  route?: ModelDisplayRoute,
  maximumLineLength = 18,
) {
  const label = modelEffortLabel(value, route)
  if (!route?.variant) return boundedModelLabel(label, maximumLineLength)

  const suffix = ` · ${route.variant}`
  const modelName = label.endsWith(suffix) ? label.slice(0, -suffix.length) : label
  return `${boundedModelLabel(modelName, maximumLineLength)}\n${boundedModelLabel(route.variant, maximumLineLength)}`
}

export function sourceTitle(source: ModelSource["source"]) {
  switch (source) {
    case "native-catalog":
      return "Native OpenCode catalog"
    case "openrouter-models":
      return "OpenRouter model metadata"
    case "openrouter-benchmarks":
      return "External coding benchmarks"
    case "models-dev":
      return "models.dev prices and model info"
    case "epoch-benchmarks":
      return "Epoch AI coding benchmarks"
  }
}

/** "retrieved <date>", or nothing when the date is missing. */
export function retrievedLabel(value: string | null | undefined) {
  const date = formatDate(value)
  return date ? `retrieved ${date}` : undefined
}

export function sourceState(source: ModelSource) {
  if (source.storage === "missing-both-tables") return "No snapshot or refresh history"
  if (source.storage === "missing-snapshot-table") return "No snapshot storage"
  if (source.snapshotState === "missing-table") return "No snapshot storage"
  if (source.storage === "missing-refresh-table") {
    if (source.snapshot)
      return joinSegments([
        `${source.snapshot.recordCount.toLocaleString()} records`,
        retrievedLabel(source.snapshot.retrievedAt),
        "no refresh history",
      ])
    return "No cached snapshot · no refresh history"
  }
  if (source.snapshotState === "missing-snapshot" || source.snapshotState === "none")
    return source.refresh?.state === "failed"
      ? "No cached snapshot · latest refresh failed"
      : "No cached snapshot"
  if (!source.snapshot) return "No snapshot"
  const clock = (value: string) =>
    new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  const day = (value: string) =>
    new Date(value).toLocaleDateString([], { day: "numeric", month: "short" })
  // A model list carries prices (fetched hourly) and model info (kept a week): two times. The
  // benchmark rows are info only.
  const isList = source.source !== "openrouter-benchmarks" && source.source !== "epoch-benchmarks"
  const times = isList
    ? [
        `prices ${clock(source.snapshot.retrievedAt)}`,
        `model info ${day(source.snapshot.asOf ?? source.snapshot.retrievedAt)}`,
      ]
    : [`retrieved ${day(source.snapshot.retrievedAt)}`]
  const failed =
    source.refresh?.state === "failed" && source.refresh.completedAt
      ? `refresh failed ${clock(source.refresh.completedAt)} · using ${day(source.snapshot.retrievedAt)} data`
      : undefined
  return joinSegments([
    `${source.snapshot.recordCount.toLocaleString()} records`,
    // CC BY 4.0 requires the source and authors wherever the data is shown.
    source.source === "epoch-benchmarks" ? EPOCH_ATTRIBUTION : undefined,
    ...times,
    failed,
  ])
}

/** A local date and time; absent when there is none. */
export function formatDate(value: string | null | undefined) {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toLocaleString()
}

/** A localized number; absent when there is none. */
export function numericValue(value: number | null | undefined) {
  return value === null || value === undefined ? undefined : value.toLocaleString()
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

/** `$0.35 – 0.67`: one currency sign, the rounded range, no caveats. */
export function formatPriceRange(range: { minimum: number; maximum: number }) {
  return range.minimum === range.maximum
    ? formatMarketAmount(range.minimum)
    : `${formatMarketAmount(range.minimum)} – ${formatMarketAmount(range.maximum).replace(/^\$/, "")}`
}

/** `6.2M`, `840k`, `930`. */
export function compactCount(value: number) {
  if (Math.abs(value) >= 1_000_000) return `${trimCount(value / 1_000_000)}M`
  if (Math.abs(value) >= 1_000) return `${trimCount(value / 1_000)}k`
  return String(Math.round(value))
}

function trimCount(value: number) {
  return (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10).toString()
}

/** `45s`, `14m`, `2h 10m`. */
export function compactDuration(milliseconds: number) {
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

export type SelectedModelFacts = {
  /** Rounded price range per accepted task; absent when no complete price exists. */
  price?: string
  /** The same range unrounded, for the pane's two-decimal headline. */
  priceRange?: { minimum: number; maximum: number }
  accepted?: number
  terminal?: number
  tokens?: string
  /** Median time per accepted task, e.g. "14m"; absent when no duration was recorded. */
  time?: string
  attempts?: string
}

/** The facts the first view of a selected model shows; a missing fact is absent, never labelled. */
export function selectedModelFacts(input: {
  estimate: ModelDecisionEstimate
  referenceEstimate?: ModelDecisionReferenceEstimate
  efficiency: ModelDecisionEfficiency
  cohort: ModelDecisionCohortCounts
  medianDurationMs?: number
}): SelectedModelFacts {
  const { estimate, referenceEstimate, efficiency, cohort } = input
  const facts: SelectedModelFacts = {}
  if (cohort.acceptedTaskCount < 1) return facts

  let range: { minimum: number; maximum: number } | undefined
  if (estimate.status === "available" || estimate.status === "single-observation")
    range = estimate.range.currentMarketUSD
  else if (
    referenceEstimate?.status === "exact" &&
    referenceEstimate.valueUSDPerAcceptedTask !== null
  )
    range = {
      minimum: referenceEstimate.valueUSDPerAcceptedTask,
      maximum: referenceEstimate.valueUSDPerAcceptedTask,
    }
  else if (referenceEstimate?.status === "conditional" && referenceEstimate.rangeUSDPerAcceptedTask)
    range = referenceEstimate.rangeUSDPerAcceptedTask
  if (range) {
    facts.price = formatPriceRange(range)
    facts.priceRange = range
  }

  facts.accepted = cohort.acceptedTaskCount
  facts.terminal = cohort.terminalTaskCount
  if (efficiency.tokensPerAcceptedTask !== null)
    facts.tokens = compactCount(efficiency.tokensPerAcceptedTask)
  if (input.medianDurationMs !== undefined) facts.time = compactDuration(input.medianDurationMs)
  facts.attempts = (
    Math.round((cohort.attemptCount / cohort.acceptedTaskCount) * 10) / 10
  ).toString()
  return facts
}
