import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import {
  ENDPOINT_PRICING_PRODUCTS,
  EndpointPricingSnapshotSchema,
  parseEndpointPricingResponse,
} from "./endpoint-pricing.ts"
import type { EndpointPricingProductID, EndpointPricingSnapshot } from "./endpoint-pricing.ts"
import {
  MODEL_EVIDENCE_QUERIES,
  MODEL_EVIDENCE_SOURCES,
  MODEL_EVIDENCE_SOURCE_URLS,
  ModelEvidenceSnapshotSchema,
} from "./source-schema.ts"
import type {
  ModelEvidenceErrorCode,
  ModelEvidenceRefreshStatus,
  ModelEvidenceSnapshot,
  ModelEvidenceSource,
} from "./source-schema.ts"
import { ModelEvidenceStore } from "./source-store.ts"
import { parseEpochArchive } from "./epoch-parse.ts"
import { parseModelsDev } from "./models-dev-parse.ts"
import { EPOCH_ATTRIBUTION } from "./source-schema.ts"

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
const OPENROUTER_BENCHMARKS_URL =
  "https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis&task_type=coding"
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
/** The keyless public sources are larger files: models.dev is about 7 MB, the Epoch archive 2 MB. */
const MAX_MODELS_DEV_BYTES = 24 * 1024 * 1024
const MAX_EPOCH_ARCHIVE_BYTES = 16 * 1024 * 1024
/** Requests to the public sources carry nothing about the user, project or machine. */
const PUBLIC_SOURCE_HEADERS = { "User-Agent": "model-catalog-client" } as const
const REQUEST_TIMEOUT_MS = 15_000
const SENSITIVE_TEXT =
  /(?:authorization|bearer|api[\s_-]*key|secret|token(?:\b|[_=-])|password|sk-(?:or-)?[a-z0-9_-]{8,})/i

type SourceContext = Pick<Plugin.Context, "integration" | "location" | "model">
export type ModelEvidenceFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>

type Outcome =
  | { state: "success"; snapshot: ModelEvidenceSnapshot }
  | { state: "failed"; errorCode: ModelEvidenceErrorCode; httpStatus: number | null }
  | { state: "cancelled" }

type EndpointPricingOutcome =
  | { state: "success"; snapshot: EndpointPricingSnapshot }
  | { state: "failed"; errorCode: ModelEvidenceErrorCode; httpStatus: number | null }
  | { state: "cancelled"; httpStatus: number | null }

type CredentialResult = { key: string } | { errorCode: ModelEvidenceErrorCode }

class SourceFailure extends Error {
  constructor(
    readonly errorCode: ModelEvidenceErrorCode,
    readonly httpStatus: number | null = null,
  ) {
    super(errorCode)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function malformed(): never {
  throw new SourceFailure("malformed-response")
}

function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : malformed()
}

function requiredText(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) return malformed()
  if (SENSITIVE_TEXT.test(value)) return malformed()
  return value
}

function optionalText(value: unknown, maximum = 512): string | null {
  return value === undefined || value === null || value === "" ? null : requiredText(value, maximum)
}

function textList(value: unknown): string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.length > 100) return malformed()
  return value.map((item) => requiredText(item, 512))
}

function optionalFinite(value: unknown, minimum = 0): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) return malformed()
  return value
}

function optionalBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "boolean") return malformed()
  return value
}

function decimal(value: unknown): string | null {
  if (value === undefined || value === null) return null
  // Router prices are resolved after routing; OpenRouter publishes -1 for these quotes.
  if (value === -1 || value === "-1") return null
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value
  if (
    typeof text !== "string" ||
    text.length > 64 ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)
  )
    return malformed()
  return text
}

function isoDate(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value)) return malformed()
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return malformed()
  return parsed.toISOString()
}

function safeCitation(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || value.length > 1024) return malformed()
  if (SENSITIVE_TEXT.test(value)) return null
  return value
}

function safeBenchmarkSourceURL(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || value.length > 2048) return malformed()
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      !["artificialanalysis.ai", "www.artificialanalysis.ai"].includes(url.hostname) ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    )
      return null
    return url.toString()
  } catch {
    return malformed()
  }
}

function asFailure(error: unknown, signal: AbortSignal, timedOut: AbortSignal): Outcome {
  if (signal.aborted) return { state: "cancelled" }
  if (timedOut.aborted) return { state: "failed", errorCode: "timeout", httpStatus: null }
  if (error instanceof SourceFailure)
    return { state: "failed", errorCode: error.errorCode, httpStatus: error.httpStatus }
  return { state: "failed", errorCode: "network-error", httpStatus: null }
}

function asEndpointPricingFailure(
  error: unknown,
  signal: AbortSignal,
  timedOut: AbortSignal,
  responseStatus: number | null,
): EndpointPricingOutcome {
  if (signal.aborted) return { state: "cancelled", httpStatus: responseStatus }
  if (timedOut.aborted) return { state: "failed", errorCode: "timeout", httpStatus: responseStatus }
  if (error instanceof SourceFailure)
    return {
      state: "failed",
      errorCode: error.errorCode,
      httpStatus: error.httpStatus ?? responseStatus,
    }
  return { state: "failed", errorCode: "network-error", httpStatus: responseStatus }
}

function makeSnapshot(
  source: ModelEvidenceSource,
  projectDirectory: string,
  generation: number,
  data: {
    asOf: string | null
    version: string | null
    citation: string | null
    upstreamSourceURL: string | null
    records: ModelEvidenceSnapshot["records"]
  },
): ModelEvidenceSnapshot {
  return ModelEvidenceSnapshotSchema.parse({
    snapshotID: crypto.randomUUID(),
    projectDirectory,
    source,
    generation,
    retrievedAt: new Date().toISOString(),
    query: MODEL_EVIDENCE_QUERIES[source],
    sourceURL: MODEL_EVIDENCE_SOURCE_URLS[source],
    ...data,
  })
}

function nativeRecords(models: unknown): ModelEvidenceSnapshot["records"] {
  if (!Array.isArray(models) || models.length > 2_000) return malformed()
  return models.map((value) => {
    const model = object(value)
    const capabilities = object(model.capabilities ?? {})
    const cost = model.cost
    let prices: Extract<
      ModelEvidenceSnapshot,
      { source: "native-catalog" }
    >["records"][number]["prices"] = null
    if (cost !== undefined && cost !== null) {
      if (!Array.isArray(cost) || cost.length > 100) return malformed()
      if (cost.length) {
        prices = {
          unit: "USD per million tokens",
          tiers: cost.map((value) => {
            const tier = object(value)
            const cache = object(tier.cache ?? {})
            return {
              contextTierTokens: optionalFinite(object(tier.tier ?? {}).size),
              input: optionalFinite(tier.input),
              output: optionalFinite(tier.output),
              cacheRead: optionalFinite(cache.read),
              cacheWrite: optionalFinite(cache.write),
            }
          }),
        }
      }
    }
    const variants = model.variants
    if (variants !== undefined && variants !== null && !Array.isArray(variants)) return malformed()
    const variantIDs =
      variants === undefined || variants === null
        ? null
        : variants.map((value: unknown) => requiredText(isObject(value) ? value.id : value))
    const input = capabilities.input
    const output = capabilities.output
    return {
      kind: "native-model" as const,
      providerID: requiredText(model.providerID),
      id: requiredText(model.id),
      name: optionalText(model.name),
      enabled: optionalBoolean(model.enabled),
      type: optionalText(model.type),
      contextTokens: optionalFinite(object(model.limit ?? {}).context),
      capabilities: {
        tools: optionalBoolean(capabilities.tools),
        input: textList(input),
        output: textList(output),
      },
      variants: variantIDs,
      prices,
    }
  })
}

function openRouterPriceTier(value: unknown, minimum: number | null) {
  const pricing = object(value)
  return {
    minPromptTokens: minimum,
    utcStart: optionalFinite(pricing.utc_start),
    utcEnd: optionalFinite(pricing.utc_end),
    prompt: decimal(pricing.prompt),
    completion: decimal(pricing.completion),
    inputCacheRead: decimal(pricing.input_cache_read),
    inputCacheWrite: decimal(pricing.input_cache_write),
  }
}

function openRouterModelRecords(payload: unknown): ModelEvidenceSnapshot["records"] {
  const root = object(payload)
  if (!Array.isArray(root.data) || root.data.length > 2_000) return malformed()
  return root.data.map((value) => {
    const model = object(value)
    const architecture = object(model.architecture ?? {})
    let prices: Extract<
      ModelEvidenceSnapshot,
      { source: "openrouter-models" }
    >["records"][number]["prices"] = null
    if (model.pricing !== undefined && model.pricing !== null) {
      const pricing = object(model.pricing)
      const tiers = [openRouterPriceTier(pricing, null)]
      if (pricing.overrides !== undefined && pricing.overrides !== null) {
        if (!Array.isArray(pricing.overrides) || pricing.overrides.length > 99) return malformed()
        for (const overrideValue of pricing.overrides) {
          const override = object(overrideValue)
          const minimum = optionalFinite(override.min_prompt_tokens)
          // A schedule this record cannot express (for example weekend-only `utc_days`) is left
          // out rather than failing the whole catalog or being applied as a base rate.
          if (
            minimum === null &&
            optionalFinite(override.utc_start) === null &&
            optionalFinite(override.utc_end) === null
          )
            continue
          tiers.push(openRouterPriceTier(override, minimum))
        }
      }
      prices = { unit: "USD per token", tiers }
    }
    return {
      kind: "openrouter-model" as const,
      id: requiredText(model.id),
      canonicalSlug: optionalText(model.canonical_slug),
      name: optionalText(model.name),
      contextLength: optionalFinite(model.context_length),
      architecture: {
        modality: optionalText(architecture.modality),
        inputModalities: textList(architecture.input_modalities),
        outputModalities: textList(architecture.output_modalities),
        tokenizer: optionalText(architecture.tokenizer),
        instructType: optionalText(architecture.instruct_type),
      },
      supportedParameters: textList(model.supported_parameters),
      prices,
    }
  })
}

function benchmarkRecords(payload: unknown): {
  asOf: string | null
  version: string | null
  citation: string | null
  upstreamSourceURL: string | null
  records: ModelEvidenceSnapshot["records"]
} {
  const root = object(payload)
  const meta = object(root.meta)
  if (!Array.isArray(root.data) || root.data.length > 2_000) return malformed()
  if (meta.source !== "artificial-analysis" || meta.task_type !== "coding") return malformed()
  const records = root.data.map((value) => {
    const row = object(value)
    if (row.source !== "artificial-analysis") return malformed()
    const pricing = row.pricing === undefined || row.pricing === null ? null : object(row.pricing)
    return {
      kind: "openrouter-benchmark" as const,
      source: "artificial-analysis" as const,
      taskType: "coding" as const,
      modelPermaslug: requiredText(row.model_permaslug),
      displayName: optionalText(row.display_name),
      effort: null,
      codingIndex: optionalFinite(row.coding_index),
      agenticIndex: optionalFinite(row.agentic_index),
      intelligenceIndex: optionalFinite(row.intelligence_index),
      prices: pricing
        ? {
            unit: "USD per token" as const,
            prompt: decimal(pricing.prompt),
            completion: decimal(pricing.completion),
          }
        : null,
    }
  })
  return {
    asOf: isoDate(meta.as_of),
    version: optionalText(meta.version, 128),
    citation: safeCitation(meta.citation),
    upstreamSourceURL: safeBenchmarkSourceURL(meta.source_url),
    records,
  }
}

async function boundedJSON(
  response: Response,
  signal: AbortSignal,
  limit = MAX_RESPONSE_BYTES,
): Promise<unknown> {
  const length = response.headers.get("content-length")
  if (length && /^\d+$/.test(length) && Number(length) > limit)
    throw new SourceFailure("response-too-large")
  if (!response.body) throw new SourceFailure("malformed-response")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined)
        throw new SourceFailure("response-too-large")
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    return JSON.parse(text) as unknown
  } catch (error) {
    if (error instanceof SourceFailure) throw error
    if (signal.aborted) throw error
    throw new SourceFailure("malformed-response")
  } finally {
    reader.releaseLock()
  }
}

/** Let queued requests run between the large steps of a public-source refresh. */
const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

async function boundedBytes(
  response: Response,
  signal: AbortSignal,
  limit: number,
): Promise<Uint8Array> {
  const length = response.headers.get("content-length")
  if (length && /^\d+$/.test(length) && Number(length) > limit)
    throw new SourceFailure("response-too-large")
  if (!response.body) throw new SourceFailure("malformed-response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined)
        throw new SourceFailure("response-too-large")
      }
      chunks.push(chunk.value)
    }
  } catch (error) {
    if (error instanceof SourceFailure) throw error
    if (signal.aborted) throw error
    throw new SourceFailure("malformed-response")
  } finally {
    reader.releaseLock()
  }
  const all = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.byteLength
  }
  return all
}

function httpFailure(status: number): SourceFailure {
  if (status === 401) return new SourceFailure("unauthorized", status)
  if (status === 429) return new SourceFailure("rate-limited", status)
  if (status >= 500) return new SourceFailure("server-error", status)
  return new SourceFailure("http-error", status)
}

/**
 * What is cached, and for how long. Model info (identity, names, context windows, tool support
 * and the public benchmark rows) changes slowly and is kept for a week. Prices move faster and
 * are refreshed hourly. A source's list response carries both, so one fetch serves a price
 * refresh: it replaces the rates on the cached records, adds models it newly lists, and keeps
 * the rest, leaving the info time (`asOf`) alone. Only an info refresh replaces the records and
 * so drops models a source no longer lists.
 */
export const PRICE_TTL_MS = 60 * 60 * 1000
export const INFO_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** After a failed refresh, wait this long before trying that source again on its own. */
export const FAILED_RETRY_MS = 5 * 60 * 1000
/** A refresh row still "refreshing" after this long belongs to a crashed process. */
const STALE_REFRESHING_MS = 2 * 60 * 1000

export type RefreshKind = "info" | "prices"

/** Sources with no prices of their own: rows only, kept a week. */
const INFO_ONLY_SOURCES: ReadonlySet<ModelEvidenceSource> = new Set([
  "openrouter-benchmarks",
  "epoch-benchmarks",
])

/**
 * The sources to fetch now and why. `infoAt` is each source's info time (a model list's `asOf`).
 * A source already refreshing is not due; one that failed recently waits out `FAILED_RETRY_MS`;
 * `force` makes every source an info refresh. Reading never needs this: the stored snapshot is
 * always served first.
 */
export function dueSources(
  statuses: readonly ModelEvidenceRefreshStatus[],
  infoAt: Partial<Record<ModelEvidenceSource, string | null>>,
  now: number,
  force = false,
): Map<ModelEvidenceSource, RefreshKind> {
  const due = new Map<ModelEvidenceSource, RefreshKind>()
  for (const status of statuses) {
    const started = status.startedAt ? Date.parse(status.startedAt) : Number.NaN
    if (
      status.state === "refreshing" &&
      Number.isFinite(started) &&
      now - started < STALE_REFRESHING_MS
    )
      continue
    if (force) {
      due.set(status.source, "info")
      continue
    }
    const completed = status.completedAt ? Date.parse(status.completedAt) : Number.NaN
    if (
      status.state === "failed" &&
      Number.isFinite(completed) &&
      now - completed < FAILED_RETRY_MS
    )
      continue
    const retrieved = status.latestRetrievedAt ? Date.parse(status.latestRetrievedAt) : Number.NaN
    const info = Date.parse(infoAt[status.source] ?? status.latestRetrievedAt ?? "")
    if (!Number.isFinite(retrieved) || !Number.isFinite(info) || now - info >= INFO_TTL_MS)
      due.set(status.source, "info")
    // Benchmark rows are info only; the model lists also carry prices.
    else if (!INFO_ONLY_SOURCES.has(status.source) && now - retrieved >= PRICE_TTL_MS)
      due.set(status.source, "prices")
  }
  return due
}

type PriceBearing = { prices: unknown }
const recordKey = (record: ModelEvidenceSnapshot["records"][number]) =>
  record.kind === "native-model"
    ? `${record.providerID}\u0000${record.id}`
    : record.kind === "openrouter-model"
      ? record.id
      : record.kind === "models-dev-model"
        ? `${record.providerID}\u0000${record.id}`
        : ""

/**
 * A price refresh: the stored records keep their info and take the new rates; a model the
 * response lists for the first time is added; one it no longer lists is kept until the next
 * info refresh. The snapshot keeps its previous info time.
 */
export function mergePriceRefresh(
  previous: ModelEvidenceSnapshot,
  fresh: ModelEvidenceSnapshot,
): ModelEvidenceSnapshot {
  const incoming = new Map(fresh.records.map((record) => [recordKey(record), record] as const))
  const seen = new Set<string>()
  const records = previous.records.map((record) => {
    const key = recordKey(record)
    seen.add(key)
    const update = incoming.get(key)
    return update
      ? ({ ...record, prices: (update as PriceBearing).prices } as typeof record)
      : record
  })
  for (const record of fresh.records) if (!seen.has(recordKey(record))) records.push(record)
  return ModelEvidenceSnapshotSchema.parse({
    ...fresh,
    asOf: previous.asOf ?? previous.retrievedAt,
    records: records.slice(0, 2_000),
  })
}

/**
 * One source refresh at a time per project, shared by every panel and request: a second caller
 * gets the running refresh instead of starting another fetch.
 */
export function createRefreshGate() {
  let inFlight: Promise<void> | undefined
  return {
    get busy() {
      return inFlight !== undefined
    },
    /** Resolves when the refresh now running, if any, has finished. */
    wait: () => inFlight ?? Promise.resolve(),
    /** Run `task` unless a refresh is already running; either way, the running promise. */
    start(task: () => Promise<unknown>): Promise<void> {
      if (inFlight) return inFlight
      const run = task()
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          inFlight = undefined
        })
      inFlight = run
      return run
    },
  }
}

export class ModelEvidenceRefresher {
  constructor(
    private readonly context: SourceContext,
    private readonly store: ModelEvidenceStore,
    private readonly fetcher: ModelEvidenceFetcher = fetch,
  ) {}

  /** The sources due now and why, from the stored snapshots and refresh state. */
  due(force = false, now = Date.now()) {
    const infoAt: Partial<Record<ModelEvidenceSource, string | null>> = {}
    for (const source of MODEL_EVIDENCE_SOURCES) {
      const snapshot = this.store.latestSnapshot(source)
      // A model list's `asOf` is its info time; a benchmark's is the publisher's data date, so
      // its info time is when we fetched it.
      infoAt[source] = snapshot
        ? INFO_ONLY_SOURCES.has(source)
          ? snapshot.retrievedAt
          : (snapshot.asOf ?? snapshot.retrievedAt)
        : null
    }
    return dueSources(this.store.read().sources, infoAt, now, force)
  }

  /**
   * Refresh the given sources (all by default). A source not listed is left alone: its stored
   * snapshot stays what readers are served.
   */
  async refresh(
    signal: AbortSignal,
    plan: ReadonlyMap<ModelEvidenceSource, RefreshKind> = new Map(
      MODEL_EVIDENCE_SOURCES.map((source) => [source, "info" as const]),
    ),
  ) {
    signal.throwIfAborted()
    this.plan = plan
    const wanted = new Set(plan.keys())
    if (wanted.size === 0) return this.store.read()
    const generations = this.store.beginRefresh([...wanted])
    // Endpoint prices belong to the OpenRouter model list: they refresh with it.
    const endpointGenerations = wanted.has("openrouter-models")
      ? this.store.beginEndpointPricingRefresh()
      : undefined
    const openRouterWanted = wanted.has("openrouter-models") || wanted.has("openrouter-benchmarks")
    const skipped: Outcome = { state: "cancelled" }
    if (signal.aborted) {
      this.cancelAll(wanted, generations, endpointGenerations)
      return this.store.read()
    }

    const [native, credential] = await Promise.all([
      wanted.has("native-catalog")
        ? this.nativeOutcome(generations["native-catalog"], signal)
        : Promise.resolve(skipped),
      openRouterWanted
        ? this.openRouterCredential(signal)
        : Promise.resolve<CredentialResult>({ errorCode: "missing-credentials" }),
    ])
    if (signal.aborted) {
      this.cancelAll(wanted, generations, endpointGenerations)
      return this.store.read()
    }

    const models = wanted.has("openrouter-models")
      ? this.openRouterOutcome(
          "openrouter-models",
          generations["openrouter-models"],
          OPENROUTER_MODELS_URL,
          "key" in credential ? credential.key : null,
          signal,
        )
      : Promise.resolve(skipped)
    const benchmarks = !wanted.has("openrouter-benchmarks")
      ? Promise.resolve(skipped)
      : "key" in credential
        ? this.openRouterOutcome(
            "openrouter-benchmarks",
            generations["openrouter-benchmarks"],
            OPENROUTER_BENCHMARKS_URL,
            credential.key,
            signal,
          )
        : Promise.resolve<Outcome>({
            state: "failed",
            errorCode: credential.errorCode,
            httpStatus: null,
          })
    const endpointPricing = endpointGenerations
      ? Promise.all(
          ENDPOINT_PRICING_PRODUCTS.map(({ productID }) =>
            this.endpointPricingOutcome(
              productID,
              endpointGenerations[productID],
              "key" in credential ? credential.key : null,
              "key" in credential ? null : credential.errorCode,
              signal,
            ),
          ),
        )
      : Promise.resolve<EndpointPricingOutcome[]>([])
    const modelsDev = wanted.has("models-dev")
      ? this.modelsDevOutcome(generations["models-dev"], native, signal)
      : Promise.resolve(skipped)
    const epoch = wanted.has("epoch-benchmarks")
      ? this.epochOutcome(generations["epoch-benchmarks"], signal)
      : Promise.resolve(skipped)
    const [modelsOutcome, benchmarkOutcome, endpointOutcomes, modelsDevOutcome, epochOutcome] =
      await Promise.all([models, benchmarks, endpointPricing, modelsDev, epoch])

    if (signal.aborted) {
      this.cancelAll(wanted, generations, endpointGenerations, endpointOutcomes)
      return this.store.read()
    }
    const outcomes = [
      ["native-catalog", native],
      ["openrouter-models", modelsOutcome],
      ["openrouter-benchmarks", benchmarkOutcome],
      ["models-dev", modelsDevOutcome],
      ["epoch-benchmarks", epochOutcome],
    ] as const
    for (const [source, outcome] of outcomes) {
      if (!wanted.has(source)) continue
      if (signal.aborted) {
        this.cancelAll(wanted, generations, endpointGenerations, endpointOutcomes)
        return this.store.read()
      }
      this.commit(source, generations[source], outcome)
    }
    if (endpointGenerations)
      for (const [index, { productID }] of ENDPOINT_PRICING_PRODUCTS.entries()) {
        if (signal.aborted) {
          this.cancelAll(wanted, generations, endpointGenerations, endpointOutcomes)
          return this.store.read()
        }
        this.commitEndpointPricing(
          productID,
          endpointGenerations[productID],
          endpointOutcomes[index]!,
        )
      }
    return this.store.read()
  }

  private async nativeOutcome(generation: number, signal: AbortSignal): Promise<Outcome> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const requestSignal = AbortSignal.any([signal, timeout])
    try {
      signal.throwIfAborted()
      const { data } = await Effect.runPromise(
        this.context.model.list({ location: { directory: this.context.location.directory } }),
        { signal: requestSignal },
      )
      signal.throwIfAborted()
      if (timeout.aborted) throw new SourceFailure("timeout")
      const records = nativeRecords(data)
      return {
        state: "success",
        snapshot: makeSnapshot("native-catalog", this.store.projectDirectory, generation, {
          asOf: null,
          version: null,
          citation: "OpenCode native model catalog",
          upstreamSourceURL: null,
          records,
        }),
      }
    } catch (error) {
      if (signal.aborted) return { state: "cancelled" }
      if (timeout.aborted) return { state: "failed", errorCode: "timeout", httpStatus: null }
      return {
        state: "failed",
        errorCode: error instanceof SourceFailure ? error.errorCode : "native-unavailable",
        httpStatus: error instanceof SourceFailure ? error.httpStatus : null,
      }
    }
  }

  private async openRouterCredential(signal: AbortSignal): Promise<CredentialResult> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const requestSignal = AbortSignal.any([signal, timeout])
    try {
      signal.throwIfAborted()
      const connection = await Effect.runPromise(
        this.context.integration.connection.active("openrouter"),
        { signal: requestSignal },
      )
      signal.throwIfAborted()
      if (!connection) return { errorCode: "missing-credentials" }
      if (connection.status?.status === "needs_auth")
        return { errorCode: "reauthentication-required" }
      const credential = await Effect.runPromise(
        this.context.integration.connection.resolve(connection),
        { signal: requestSignal },
      )
      signal.throwIfAborted()
      if (!credential) return { errorCode: "missing-credentials" }
      if (credential.type !== "key" || typeof credential.key !== "string" || !credential.key.trim())
        return { errorCode: "unsupported-credentials" }
      return { key: credential.key }
    } catch {
      if (signal.aborted) return { errorCode: "missing-credentials" }
      if (timeout.aborted) return { errorCode: "timeout" }
      return { errorCode: "credential-unavailable" }
    }
  }

  private async openRouterOutcome(
    source: "openrouter-models" | "openrouter-benchmarks",
    generation: number,
    url: string,
    key: string | null,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const requestSignal = AbortSignal.any([signal, timeout])
    try {
      signal.throwIfAborted()
      const headers = new Headers({ Accept: "application/json" })
      if (key) headers.set("Authorization", `Bearer ${key}`)
      const response = await this.fetcher(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal: requestSignal,
      })
      signal.throwIfAborted()
      if (!response.ok) throw httpFailure(response.status)
      const payload = await boundedJSON(response, requestSignal)
      signal.throwIfAborted()
      if (timeout.aborted) throw new SourceFailure("timeout")
      if (source === "openrouter-models") {
        const records = openRouterModelRecords(payload)
        return {
          state: "success",
          snapshot: makeSnapshot(source, this.store.projectDirectory, generation, {
            asOf: null,
            version: null,
            citation: "OpenRouter model catalog",
            upstreamSourceURL: null,
            records,
          }),
        }
      }
      const data = benchmarkRecords(payload)
      return {
        state: "success",
        snapshot: makeSnapshot(source, this.store.projectDirectory, generation, data),
      }
    } catch (error) {
      return asFailure(error, signal, timeout)
    }
  }

  /** The providers this install routes, so models.dev keeps the lineups that matter to it. */
  private routedProviders(native: Outcome): Set<string> {
    const snapshot =
      native.state === "success" && native.snapshot.source === "native-catalog"
        ? native.snapshot
        : this.store.latestSnapshot("native-catalog")
    const providers = new Set<string>()
    if (snapshot?.source === "native-catalog")
      for (const record of snapshot.records) providers.add(record.providerID)
    return providers
  }

  private async modelsDevOutcome(
    generation: number,
    native: Outcome,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2)
    const requestSignal = AbortSignal.any([signal, timeout])
    try {
      signal.throwIfAborted()
      const response = await this.fetcher(MODEL_EVIDENCE_SOURCE_URLS["models-dev"], {
        method: "GET",
        headers: new Headers({ Accept: "application/json", ...PUBLIC_SOURCE_HEADERS }),
        redirect: "error",
        signal: requestSignal,
      })
      signal.throwIfAborted()
      if (!response.ok) throw httpFailure(response.status)
      const payload = await boundedJSON(response, requestSignal, MAX_MODELS_DEV_BYTES)
      signal.throwIfAborted()
      if (timeout.aborted) throw new SourceFailure("timeout")
      await yieldTurn()
      let records
      try {
        records = parseModelsDev(payload, this.routedProviders(native))
        if (!records.length) throw new Error("no models")
      } catch {
        throw new SourceFailure("malformed-response")
      }
      await yieldTurn()
      return {
        state: "success",
        snapshot: makeSnapshot("models-dev", this.store.projectDirectory, generation, {
          asOf: null,
          version: null,
          citation: "models.dev (MIT), the open model database OpenCode uses",
          upstreamSourceURL: null,
          records,
        }),
      }
    } catch (error) {
      return asFailure(error, signal, timeout)
    }
  }

  private async epochOutcome(generation: number, signal: AbortSignal): Promise<Outcome> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2)
    const requestSignal = AbortSignal.any([signal, timeout])
    try {
      signal.throwIfAborted()
      const response = await this.fetcher(MODEL_EVIDENCE_SOURCE_URLS["epoch-benchmarks"], {
        method: "GET",
        headers: new Headers({ Accept: "application/zip", ...PUBLIC_SOURCE_HEADERS }),
        redirect: "error",
        signal: requestSignal,
      })
      signal.throwIfAborted()
      if (!response.ok) throw httpFailure(response.status)
      const bytes = await boundedBytes(response, requestSignal, MAX_EPOCH_ARCHIVE_BYTES)
      signal.throwIfAborted()
      if (timeout.aborted) throw new SourceFailure("timeout")
      await yieldTurn()
      let records
      try {
        records = parseEpochArchive(bytes).slice(0, 2_000)
        if (!records.length) throw new Error("no rows")
      } catch {
        throw new SourceFailure("malformed-response")
      }
      return {
        state: "success",
        snapshot: makeSnapshot("epoch-benchmarks", this.store.projectDirectory, generation, {
          asOf: null,
          version: null,
          citation: `${EPOCH_ATTRIBUTION}. Epoch AI, Capabilities & benchmarking, epoch.ai/benchmarks`,
          upstreamSourceURL: "https://epoch.ai/benchmarks",
          records,
        }),
      }
    } catch (error) {
      return asFailure(error, signal, timeout)
    }
  }

  private async endpointPricingOutcome(
    productID: EndpointPricingProductID,
    generation: number,
    key: string | null,
    credentialError: ModelEvidenceErrorCode | null,
    signal: AbortSignal,
  ): Promise<EndpointPricingOutcome> {
    if (signal.aborted) return { state: "cancelled", httpStatus: null }
    if (!key)
      return {
        state: "failed",
        errorCode: credentialError ?? "missing-credentials",
        httpStatus: null,
      }

    const product = ENDPOINT_PRICING_PRODUCTS.find((item) => item.productID === productID)!
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const requestSignal = AbortSignal.any([signal, timeout])
    let responseStatus: number | null = null
    try {
      signal.throwIfAborted()
      const response = await this.fetcher(product.sourceURL, {
        method: "GET",
        headers: new Headers({ Accept: "application/json", Authorization: `Bearer ${key}` }),
        redirect: "error",
        signal: requestSignal,
      })
      responseStatus = response.status
      signal.throwIfAborted()
      if (!response.ok) throw httpFailure(response.status)
      const payload = await boundedJSON(response, requestSignal)
      signal.throwIfAborted()
      if (timeout.aborted) throw new SourceFailure("timeout")

      let records
      try {
        records = parseEndpointPricingResponse(payload, productID)
      } catch {
        throw new SourceFailure("malformed-response")
      }
      const snapshot = EndpointPricingSnapshotSchema.parse({
        snapshotID: crypto.randomUUID(),
        projectDirectory: this.store.projectDirectory,
        productID,
        generation,
        retrievedAt: new Date().toISOString(),
        sourceURL: product.sourceURL,
        httpStatus: response.status,
        records,
      })
      return { state: "success", snapshot }
    } catch (error) {
      return asEndpointPricingFailure(error, signal, timeout, responseStatus)
    }
  }

  private plan: ReadonlyMap<ModelEvidenceSource, RefreshKind> = new Map()

  private commit(source: ModelEvidenceSource, generation: number, outcome: Outcome): void {
    if (outcome.state === "success") {
      let snapshot = outcome.snapshot
      // An info refresh stores the response as it is (info time = retrieved time); a price
      // refresh merges it into the stored records and keeps the earlier info time in `asOf`.
      if (!INFO_ONLY_SOURCES.has(source) && this.plan.get(source) === "prices") {
        const previous = this.store.latestSnapshot(source)
        if (previous) snapshot = mergePriceRefresh(previous, snapshot)
      }
      this.store.saveSnapshot(snapshot)
    } else if (outcome.state === "cancelled") {
      this.store.cancelRefresh(source, generation)
    } else {
      this.store.failRefresh(source, generation, outcome.errorCode, outcome.httpStatus)
    }
  }

  private commitEndpointPricing(
    productID: EndpointPricingProductID,
    generation: number,
    outcome: EndpointPricingOutcome,
  ): void {
    if (outcome.state === "success") {
      this.store.saveEndpointPricingSnapshot(outcome.snapshot)
    } else if (outcome.state === "cancelled") {
      this.store.cancelEndpointPricingRefresh(productID, generation, outcome.httpStatus)
    } else {
      this.store.failEndpointPricingRefresh(
        productID,
        generation,
        outcome.errorCode,
        outcome.httpStatus,
      )
    }
  }

  private cancelAll(
    wanted: ReadonlySet<ModelEvidenceSource>,
    generations: Record<ModelEvidenceSource, number>,
    endpointGenerations: Record<EndpointPricingProductID, number> | undefined,
    endpointOutcomes?: readonly EndpointPricingOutcome[],
  ): void {
    for (const source of MODEL_EVIDENCE_SOURCES)
      if (wanted.has(source)) this.store.cancelRefresh(source, generations[source])
    if (!endpointGenerations) return
    for (const [index, { productID }] of ENDPOINT_PRICING_PRODUCTS.entries()) {
      const outcome = endpointOutcomes?.[index]
      const httpStatus =
        outcome?.state === "success" ? outcome.snapshot.httpStatus : (outcome?.httpStatus ?? null)
      this.store.cancelEndpointPricingRefresh(productID, endpointGenerations[productID], httpStatus)
    }
  }
}
