import { z } from "zod"

export const ENDPOINT_PRICING_PRODUCTS = [
  {
    productID: "moonshotai/kimi-k3.1-pro",
    sourceURL: "https://openrouter.ai/api/v1/models/moonshotai/kimi-k3.1-pro/endpoints",
  },
  {
    productID: "qwen/qwen3.8-flash",
    sourceURL: "https://openrouter.ai/api/v1/models/qwen/qwen3.8-flash/endpoints",
  },
  {
    productID: "openai/gpt-6-luna",
    sourceURL: "https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints",
  },
] as const

export type EndpointPricingProductID = (typeof ENDPOINT_PRICING_PRODUCTS)[number]["productID"]
export const EndpointPricingProductIDSchema = z.enum([
  "moonshotai/kimi-k3.1-pro",
  "qwen/qwen3.8-flash",
  "openai/gpt-6-luna",
])

export function endpointPricingProduct(productID: EndpointPricingProductID) {
  return ENDPOINT_PRICING_PRODUCTS.find((product) => product.productID === productID)!
}

const BoundedText = z.string().min(1).max(512)
const NullableText = z.string().max(512).nullable()
const FiniteNonnegative = z.number().finite().nonnegative()
const EndpointRate = z
  .string()
  .max(64)
  .regex(/^(?:-1|(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/)
const OptionalEndpointRate = EndpointRate.nullable().optional()

const EndpointPricingCacheWriteDocumentationSchema = z.strictObject({
  field: z.literal("input_cache_write"),
  supportedRate: z.literal("0"),
  sourceURL: z.literal("https://openrouter.ai/docs/guides/best-practices/prompt-caching"),
  retrievedAt: z.iso.datetime(),
  statement: z.literal("Moonshot AI prompt caching documentation: cache writes have no cost."),
  policyID: z.literal("openrouter-moonshot-kimi-mxfp4-cache-write-zero-v1"),
  scope: z.strictObject({
    productID: z.literal("moonshotai/kimi-k3.1-pro"),
    providerName: z.literal("Moonshot AI"),
    tag: z.literal("moonshotai/mxfp4"),
    serviceTier: z.null(),
  }),
})

const EndpointPricingOverrideSchema = z.strictObject({
  minPromptTokens: FiniteNonnegative.nullable().optional(),
  utcStart: FiniteNonnegative.nullable().optional(),
  utcEnd: FiniteNonnegative.nullable().optional(),
  prompt: OptionalEndpointRate,
  completion: OptionalEndpointRate,
  inputCacheRead: OptionalEndpointRate,
  inputCacheWrite: OptionalEndpointRate,
  webSearchUSDPerRequest: OptionalEndpointRate,
})

const EndpointPricingRatesSchema = z.strictObject({
  unit: z.literal("USD per token"),
  prompt: OptionalEndpointRate,
  completion: OptionalEndpointRate,
  inputCacheRead: OptionalEndpointRate,
  inputCacheWrite: OptionalEndpointRate,
  webSearchUSDPerRequest: OptionalEndpointRate,
  discount: z.number().finite().nonnegative().nullable().optional(),
  overrides: z.array(EndpointPricingOverrideSchema).max(99).nullable().optional(),
})

export const EndpointPricingRecordSchema = z
  .strictObject({
    productID: EndpointPricingProductIDSchema,
    name: BoundedText,
    providerName: BoundedText,
    tag: NullableText.optional(),
    serviceTier: NullableText.optional(),
    status: z.number().finite().nullable().optional(),
    contextLength: FiniteNonnegative.nullable().optional(),
    supportedParameters: z.array(BoundedText).max(100).nullable().optional(),
    supportsImplicitCaching: z.boolean().nullable().optional(),
    pricing: EndpointPricingRatesSchema,
    cacheWriteDocumentation: EndpointPricingCacheWriteDocumentationSchema.nullable(),
  })
  .superRefine((record, context) => {
    if (
      record.cacheWriteDocumentation &&
      (record.productID !== record.cacheWriteDocumentation.scope.productID ||
        record.providerName !== record.cacheWriteDocumentation.scope.providerName ||
        record.tag !== record.cacheWriteDocumentation.scope.tag ||
        record.serviceTier !== record.cacheWriteDocumentation.scope.serviceTier ||
        Object.hasOwn(record.pricing, "inputCacheWrite"))
    )
      context.addIssue({
        code: "custom",
        path: ["cacheWriteDocumentation"],
        message: "Documentation support is inapplicable to this endpoint field",
      })
  })
export type EndpointPricingRecord = z.infer<typeof EndpointPricingRecordSchema>

const EndpointPricingSnapshotFields = {
  snapshotID: z.uuid(),
  projectDirectory: z.string().min(1).max(2048),
  productID: EndpointPricingProductIDSchema,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  retrievedAt: z.iso.datetime(),
  sourceURL: z.url().max(2048),
  httpStatus: z.number().int().min(100).max(599),
}

export const EndpointPricingSnapshotSchema = z
  .strictObject({
    ...EndpointPricingSnapshotFields,
    records: z.array(EndpointPricingRecordSchema).max(200),
  })
  .superRefine((snapshot, context) => {
    const product = endpointPricingProduct(snapshot.productID)
    if (snapshot.sourceURL !== product.sourceURL)
      context.addIssue({ code: "custom", path: ["sourceURL"], message: "Unexpected endpoint URL" })
    if (snapshot.records.some((record) => record.productID !== snapshot.productID))
      context.addIssue({ code: "custom", path: ["records"], message: "Endpoint product mismatch" })
    const identities = snapshot.records.map((record) =>
      JSON.stringify([record.providerName, record.tag ?? null, record.serviceTier ?? null]),
    )
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        path: ["records"],
        message: "Duplicate endpoint scenario",
      })
  })
export type EndpointPricingSnapshot = z.infer<typeof EndpointPricingSnapshotSchema>

const EndpointPricingErrorCodeSchema = z.enum([
  "missing-credentials",
  "unsupported-credentials",
  "reauthentication-required",
  "credential-unavailable",
  "native-unavailable",
  "unauthorized",
  "rate-limited",
  "server-error",
  "http-error",
  "malformed-response",
  "response-too-large",
  "timeout",
  "network-error",
])

export const EndpointPricingScenarioSchema = z
  .strictObject({
    productID: EndpointPricingProductIDSchema,
    sourceURL: z.url().max(2048),
    state: z.enum(["never", "refreshing", "succeeded", "failed", "cancelled"]),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    latestSnapshotID: z.uuid().nullable(),
    latestRetrievedAt: z.iso.datetime().nullable(),
    latestRecordCount: z.number().int().nonnegative().max(200).nullable(),
    errorCode: EndpointPricingErrorCodeSchema.nullable(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    snapshot: EndpointPricingSnapshotSchema.nullable(),
  })
  .superRefine((scenario, context) => {
    const product = endpointPricingProduct(scenario.productID)
    if (scenario.sourceURL !== product.sourceURL)
      context.addIssue({ code: "custom", path: ["sourceURL"], message: "Unexpected endpoint URL" })
    if (scenario.snapshot) {
      const snapshot = scenario.snapshot
      if (
        snapshot.productID !== scenario.productID ||
        snapshot.snapshotID !== scenario.latestSnapshotID ||
        snapshot.retrievedAt !== scenario.latestRetrievedAt ||
        snapshot.records.length !== scenario.latestRecordCount ||
        snapshot.generation > scenario.generation
      )
        context.addIssue({
          code: "custom",
          path: ["snapshot"],
          message: "Endpoint snapshot mismatch",
        })
    } else if (
      scenario.latestSnapshotID !== null ||
      scenario.latestRetrievedAt !== null ||
      scenario.latestRecordCount !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["snapshot"],
        message: "Endpoint snapshot is unavailable",
      })
    }
    if (
      scenario.state === "succeeded" &&
      (!scenario.snapshot || scenario.snapshot.generation !== scenario.generation)
    )
      context.addIssue({
        code: "custom",
        path: ["snapshot"],
        message: "Successful endpoint refresh requires its current snapshot",
      })
  })
export type EndpointPricingScenario = z.infer<typeof EndpointPricingScenarioSchema>

export const EndpointPricingReadSchema = z
  .strictObject({
    state: z.enum(["never", "refreshing", "succeeded", "partial", "failed", "cancelled"]),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    complete: z.boolean(),
    scenarios: z.array(EndpointPricingScenarioSchema).length(ENDPOINT_PRICING_PRODUCTS.length),
  })
  .superRefine((read, context) => {
    const states = read.scenarios.map(({ state }) => state)
    const expectedState = states.every((state) => state === "never")
      ? "never"
      : states.some((state) => state === "refreshing")
        ? "refreshing"
        : states.every((state) => state === "succeeded")
          ? "succeeded"
          : states.every((state) => state === "cancelled")
            ? "cancelled"
            : states.every((state) => state === "failed")
              ? "failed"
              : "partial"
    const expectedComplete = read.scenarios.every(
      ({ state, generation, snapshot }) =>
        state === "succeeded" && snapshot?.generation === generation,
    )
    const expectedGeneration = Math.max(...read.scenarios.map(({ generation }) => generation))
    if (read.state !== expectedState || read.complete !== expectedComplete)
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "Endpoint refresh state mismatch",
      })
    if (read.generation !== expectedGeneration)
      context.addIssue({
        code: "custom",
        path: ["generation"],
        message: "Endpoint generation mismatch",
      })
  })
export type EndpointPricingRead = z.infer<typeof EndpointPricingReadSchema>

/** The one state that stands for every scenario's state: a shared state, else `refreshing`, else `partial`. */
export function aggregateEndpointState(
  states: EndpointPricingRead["state"][],
): EndpointPricingRead["state"] {
  return states.every((value) => value === "never")
    ? "never"
    : states.some((value) => value === "refreshing")
      ? "refreshing"
      : states.every((value) => value === "succeeded")
        ? "succeeded"
        : states.every((value) => value === "cancelled")
          ? "cancelled"
          : states.every((value) => value === "failed")
            ? "failed"
            : "partial"
}

const SENSITIVE_TEXT =
  /(?:authorization|bearer|api[\s_-]*key|secret|token(?:\b|[_=-])|password|sk-(?:or-)?[a-z0-9_-]{8,})/i

function malformed(): never {
  throw new Error("malformed-response")
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed()
  return value as Record<string, unknown>
}

function safeText(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) return malformed()
  if (SENSITIVE_TEXT.test(value)) return malformed()
  return value
}

function optionalSafeText(value: unknown, maximum = 512): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || value.length > maximum) return malformed()
  if (value !== "" && SENSITIVE_TEXT.test(value)) return malformed()
  return value
}

function endpointRate(value: unknown): string | null {
  if (value === null) return null
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^(?:-1|(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(value)
  )
    return malformed()
  return value
}

function optionalRate(source: Record<string, unknown>, sourceKey: string, targetKey: string) {
  if (!Object.hasOwn(source, sourceKey)) return {}
  return { [targetKey]: endpointRate(source[sourceKey]) }
}

function optionalFinite(source: Record<string, unknown>, sourceKey: string, targetKey: string) {
  if (!Object.hasOwn(source, sourceKey)) return {}
  const value = source[sourceKey]
  if (value === null) return { [targetKey]: null }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return malformed()
  return { [targetKey]: value }
}

function pricingOverride(value: unknown) {
  const override = object(value)
  return {
    ...optionalFinite(override, "min_prompt_tokens", "minPromptTokens"),
    ...optionalFinite(override, "utc_start", "utcStart"),
    ...optionalFinite(override, "utc_end", "utcEnd"),
    ...optionalRate(override, "prompt", "prompt"),
    ...optionalRate(override, "completion", "completion"),
    ...optionalRate(override, "input_cache_read", "inputCacheRead"),
    ...optionalRate(override, "input_cache_write", "inputCacheWrite"),
    ...optionalRate(override, "web_search", "webSearchUSDPerRequest"),
  }
}

function endpointPricing(value: unknown) {
  const rawPricing = object(value)
  const rawOverrides = rawPricing.overrides
  let overrides: Record<string, unknown>[] | null | undefined
  if (Object.hasOwn(rawPricing, "overrides")) {
    if (rawOverrides === null) overrides = null
    else {
      if (!Array.isArray(rawOverrides) || rawOverrides.length > 99) return malformed()
      overrides = rawOverrides.map(pricingOverride)
    }
  }
  const discount = Object.hasOwn(rawPricing, "discount")
    ? rawPricing.discount === null
      ? null
      : typeof rawPricing.discount === "number" &&
          Number.isFinite(rawPricing.discount) &&
          rawPricing.discount >= 0
        ? rawPricing.discount
        : malformed()
    : undefined
  return {
    unit: "USD per token" as const,
    ...optionalRate(rawPricing, "prompt", "prompt"),
    ...optionalRate(rawPricing, "completion", "completion"),
    ...optionalRate(rawPricing, "input_cache_read", "inputCacheRead"),
    ...optionalRate(rawPricing, "input_cache_write", "inputCacheWrite"),
    ...optionalRate(rawPricing, "web_search", "webSearchUSDPerRequest"),
    ...(discount !== undefined ? { discount } : {}),
    ...(Object.hasOwn(rawPricing, "overrides") ? { overrides } : {}),
  }
}

const MOONSHOT_WRITE_DOCUMENTATION = {
  field: "input_cache_write",
  supportedRate: "0",
  sourceURL: "https://openrouter.ai/docs/guides/best-practices/prompt-caching",
  // This citation is a checked policy observation; refreshes do not refetch documentation.
  retrievedAt: "2026-11-05T23:11:25.854Z",
  statement: "Moonshot AI prompt caching documentation: cache writes have no cost.",
  policyID: "openrouter-moonshot-kimi-mxfp4-cache-write-zero-v1",
  scope: {
    productID: "moonshotai/kimi-k3.1-pro",
    providerName: "Moonshot AI",
    tag: "moonshotai/mxfp4",
    serviceTier: null,
  },
} as const

/** Parse only the exact requested product, rejecting malformed or ambiguous provider scenarios. */
export function parseEndpointPricingResponse(
  payload: unknown,
  productID: EndpointPricingProductID,
): EndpointPricingRecord[] {
  const data = object(object(payload).data)
  if (data.id !== productID || !Array.isArray(data.endpoints) || data.endpoints.length > 200)
    return malformed()

  const seen = new Set<string>()
  const records = data.endpoints.map((value) => {
    const endpoint = object(value)
    if (endpoint.model_id !== productID) return malformed()
    const providerName = safeText(endpoint.provider_name)
    const tag = optionalSafeText(endpoint.tag)
    const serviceTier = optionalSafeText(endpoint.service_tier)
    const identity = JSON.stringify([providerName, tag, serviceTier])
    if (seen.has(identity)) return malformed()
    seen.add(identity)

    const rawPricing = object(endpoint.pricing)
    const pricing = endpointPricing(rawPricing)
    const hasCacheWrite = Object.hasOwn(rawPricing, "input_cache_write")
    const support =
      productID === "moonshotai/kimi-k3.1-pro" &&
      providerName === "Moonshot AI" &&
      tag === "moonshotai/mxfp4" &&
      serviceTier === null &&
      !hasCacheWrite
        ? MOONSHOT_WRITE_DOCUMENTATION
        : null

    const rawParameters = endpoint.supported_parameters
    let supportedParameters: string[] | null | undefined
    if (Object.hasOwn(endpoint, "supported_parameters")) {
      if (rawParameters === null) supportedParameters = null
      else {
        if (!Array.isArray(rawParameters) || rawParameters.length > 100) return malformed()
        supportedParameters = rawParameters.map((item) => safeText(item))
      }
    }

    const rawCaching = endpoint.supports_implicit_caching
    if (rawCaching !== undefined && rawCaching !== null && typeof rawCaching !== "boolean")
      return malformed()

    const contextLength = Object.hasOwn(endpoint, "context_length")
      ? endpoint.context_length === null
        ? null
        : typeof endpoint.context_length === "number" &&
            Number.isFinite(endpoint.context_length) &&
            endpoint.context_length >= 0
          ? endpoint.context_length
          : malformed()
      : undefined
    const status = Object.hasOwn(endpoint, "status")
      ? endpoint.status === null
        ? null
        : typeof endpoint.status === "number" && Number.isFinite(endpoint.status)
          ? endpoint.status
          : malformed()
      : undefined

    return EndpointPricingRecordSchema.parse({
      productID,
      name: safeText(endpoint.name),
      providerName,
      ...(Object.hasOwn(endpoint, "tag") ? { tag } : {}),
      ...(Object.hasOwn(endpoint, "service_tier") ? { serviceTier } : {}),
      ...(Object.hasOwn(endpoint, "status") ? { status } : {}),
      ...(Object.hasOwn(endpoint, "context_length") ? { contextLength } : {}),
      ...(Object.hasOwn(endpoint, "supported_parameters") ? { supportedParameters } : {}),
      ...(Object.hasOwn(endpoint, "supports_implicit_caching")
        ? { supportsImplicitCaching: rawCaching }
        : {}),
      pricing,
      cacheWriteDocumentation: support,
    })
  })
  return records
}
