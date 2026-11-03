import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import {
  MODEL_EVIDENCE_QUERIES,
  MODEL_EVIDENCE_SOURCE_URLS,
  ModelEvidenceSnapshotSchema,
} from "./source-schema.ts"
import type {
  ModelEvidenceErrorCode,
  ModelEvidenceSnapshot,
  ModelEvidenceSource,
} from "./source-schema.ts"
import { ModelEvidenceStore } from "./source-store.ts"

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
const OPENROUTER_BENCHMARKS_URL =
  "https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis&task_type=coding"
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const SENSITIVE_TEXT =
  /(?:authorization|bearer|api[\s_-]*key|secret|token(?:\b|[_=-])|password|sk-(?:or-)?[a-z0-9_-]{8,})/i

type SourceContext = Pick<Plugin.Context, "integration" | "location" | "model">
export type ModelEvidenceFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>

type Outcome =
  | { state: "success"; snapshot: ModelEvidenceSnapshot }
  | { state: "failed"; errorCode: ModelEvidenceErrorCode; httpStatus: number | null }
  | { state: "cancelled" }

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
          if (
            minimum === null &&
            optionalFinite(override.utc_start) === null &&
            optionalFinite(override.utc_end) === null
          )
            return malformed()
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

async function boundedJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length")
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES)
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
      if (bytes > MAX_RESPONSE_BYTES) {
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

function httpFailure(status: number): SourceFailure {
  if (status === 401) return new SourceFailure("unauthorized", status)
  if (status === 429) return new SourceFailure("rate-limited", status)
  if (status >= 500) return new SourceFailure("server-error", status)
  return new SourceFailure("http-error", status)
}

export class ModelEvidenceRefresher {
  constructor(
    private readonly context: SourceContext,
    private readonly store: ModelEvidenceStore,
    private readonly fetcher: ModelEvidenceFetcher = fetch,
  ) {}

  async refresh(signal: AbortSignal) {
    signal.throwIfAborted()
    const generations = this.store.beginRefresh()
    if (signal.aborted) {
      this.cancelAll(generations)
      return this.store.read()
    }

    const [native, credential] = await Promise.all([
      this.nativeOutcome(generations["native-catalog"], signal),
      this.openRouterCredential(signal),
    ])
    if (signal.aborted) {
      this.cancelAll(generations)
      return this.store.read()
    }

    const models = this.openRouterOutcome(
      "openrouter-models",
      generations["openrouter-models"],
      OPENROUTER_MODELS_URL,
      "key" in credential ? credential.key : null,
      signal,
    )
    const benchmarks =
      "key" in credential
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
    const [modelsOutcome, benchmarkOutcome] = await Promise.all([models, benchmarks])

    if (signal.aborted) {
      this.cancelAll(generations)
      return this.store.read()
    }
    const outcomes = [
      ["native-catalog", native],
      ["openrouter-models", modelsOutcome],
      ["openrouter-benchmarks", benchmarkOutcome],
    ] as const
    for (const [source, outcome] of outcomes) {
      if (signal.aborted) {
        this.cancelAll(generations)
        return this.store.read()
      }
      this.commit(source, generations[source], outcome)
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

  private commit(source: ModelEvidenceSource, generation: number, outcome: Outcome): void {
    if (outcome.state === "success") {
      this.store.saveSnapshot(outcome.snapshot)
    } else if (outcome.state === "cancelled") {
      this.store.cancelRefresh(source, generation)
    } else {
      this.store.failRefresh(source, generation, outcome.errorCode, outcome.httpStatus)
    }
  }

  private cancelAll(generations: Record<ModelEvidenceSource, number>): void {
    for (const source of ["native-catalog", "openrouter-models", "openrouter-benchmarks"] as const)
      this.store.cancelRefresh(source, generations[source])
  }
}
