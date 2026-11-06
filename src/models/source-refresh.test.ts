import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ENDPOINT_PRICING_PRODUCTS, parseEndpointPricingResponse } from "./endpoint-pricing.ts"
import { ModelEvidenceRefresher } from "./source-refresh.ts"
import type { ModelEvidenceFetcher } from "./source-refresh.ts"
import { ModelEvidenceStore } from "./source-store.ts"

const projectDirectory = "/source-refresh-project"
const syntheticKey = "sk-or-v1-synthetic-test-secret-value"

function directory() {
  return mkdtempSync(join(tmpdir(), "lazers-model-evidence-refresh-"))
}

function nativeModel(id: string) {
  return {
    providerID: "openai",
    id,
    name: `Native ${id}`,
    enabled: true,
    type: "language",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 128_000 },
    variants: [{ id: "high" }, { id: "max" }],
    cost: [
      {
        input: 2,
        output: 8,
        cache: { read: 0.2, write: 2 },
        tier: { size: 200_000 },
      },
    ],
  }
}

function modelResponse() {
  return {
    data: [
      {
        id: "openai/gpt-source-test",
        canonical_slug: "openai/gpt-source-test-20261102",
        name: "OpenAI: GPT Source Test",
        context_length: 200_000,
        architecture: {
          modality: "text->text",
          input_modalities: ["text"],
          output_modalities: ["text"],
          tokenizer: "GPT",
          instruct_type: "chatml",
          arbitrary_secret: "synthetic-extra-secret",
        },
        supported_parameters: ["tools", "reasoning_effort"],
        pricing: {
          prompt: "0.000002",
          completion: "0.000008",
          input_cache_read: "0.0000002",
          input_cache_write: "0.000002",
          overrides: [
            {
              min_prompt_tokens: 100_000,
              prompt: "0.000004",
              completion: "0.000016",
              input_cache_read: "0.0000004",
              input_cache_write: "0.000004",
              ignored_private_field: syntheticKey,
            },
          ],
          ignored_private_field: syntheticKey,
        },
        ignored_private_field: syntheticKey,
      },
    ],
    ignored_private_field: syntheticKey,
  }
}

function benchmarkResponse() {
  return {
    data: [
      {
        source: "artificial-analysis",
        model_permaslug: "openai/gpt-source-test-20261102",
        display_name: "GPT Source Test (high)",
        coding_index: 78.25,
        agentic_index: 49.5,
        intelligence_index: null,
        pricing: { prompt: "0.000002", completion: "0.000008" },
        unsupported_effort: syntheticKey,
      },
    ],
    meta: {
      as_of: "2026-11-02T12:00:09.958Z",
      version: "v1",
      source: "artificial-analysis",
      source_url: "https://artificialanalysis.ai",
      citation: "Source: Artificial Analysis via OpenRouter.",
      task_type: "coding",
      ignored_private_field: syntheticKey,
    },
    ignored_private_field: syntheticKey,
  }
}

function endpointResponse(productID: string) {
  const base = (input: {
    provider: string
    tag: string
    serviceTier?: string | null
    pricing: Record<string, unknown>
    supportsImplicitCaching?: boolean | null
  }) => ({
    name: `${input.provider} | ${productID}`,
    model_id: productID,
    provider_name: input.provider,
    tag: input.tag,
    service_tier: input.serviceTier ?? null,
    status: 0,
    context_length: 1_000_000,
    pricing: input.pricing,
    supported_parameters: ["tools", "reasoning_effort"],
    supports_implicit_caching: input.supportsImplicitCaching ?? false,
  })

  const endpoints =
    productID === "moonshotai/kimi-k3.1-pro"
      ? [
          base({
            provider: "Moonshot AI",
            tag: "moonshotai/mxfp4",
            pricing: {
              prompt: "0.000002",
              completion: "0.00001",
              input_cache_read: "0.0000002",
              discount: 0,
            },
            supportsImplicitCaching: true,
          }),
          base({
            provider: "Moonshot AI",
            tag: "moonshotai/highspeed",
            serviceTier: "priority",
            pricing: {
              prompt: "0.000004",
              completion: "0.00002",
              input_cache_read: "0.0000002",
              input_cache_write: null,
            },
            supportsImplicitCaching: true,
          }),
          base({
            provider: "Moonshot AI",
            tag: "moonshotai/mxfp4",
            serviceTier: "priority",
            pricing: {
              prompt: "0.000003",
              completion: "0.000015",
              input_cache_read: "0.0000003",
            },
            supportsImplicitCaching: true,
          }),
        ]
      : productID === "qwen/qwen3.8-flash"
        ? [
            base({
              provider: "Alibaba",
              tag: "alibaba",
              pricing: {
                prompt: "0.00000015",
                completion: "0.00000047",
                input_cache_read: "0.000000016",
                input_cache_write: "0.0000002",
                discount: 0,
              },
            }),
            base({
              provider: "Alibaba",
              tag: "alibaba/us-east-1",
              pricing: {
                prompt: "0.00000015",
                completion: "0.00000047",
                input_cache_read: "0.000000016",
              },
            }),
          ]
        : [
            base({
              provider: "OpenAI",
              tag: "openai",
              pricing: {
                prompt: "0.0000001",
                completion: "0.0000005",
                web_search: "0.01",
                input_cache_read: "0.00000001",
                input_cache_write: "0.000000125",
                overrides: [
                  {
                    min_prompt_tokens: 272_000,
                    prompt: "0.0000002",
                    completion: "0.00000075",
                    input_cache_read: "0.00000002",
                    input_cache_write: "0.00000025",
                  },
                ],
              },
            }),
            base({
              provider: "OpenAI",
              tag: "openai/flex",
              serviceTier: "flex",
              pricing: {
                prompt: "0.00000005",
                completion: "0.00000025",
                input_cache_read: "0.000000005",
                input_cache_write: "0.0000000625",
                overrides: [
                  {
                    min_prompt_tokens: 272_000,
                    prompt: "0.0000001",
                    completion: "0.000000375",
                    input_cache_read: "0.00000001",
                    input_cache_write: "0.000000125",
                  },
                ],
              },
            }),
            base({
              provider: "OpenAI",
              tag: "openai/fast",
              serviceTier: "priority",
              pricing: {
                prompt: "0.0000002",
                completion: "0.000001",
                input_cache_read: "0.00000002",
                input_cache_write: "0.00000025",
                overrides: [
                  {
                    min_prompt_tokens: 272_000,
                    prompt: "0.0000004",
                    completion: "0.0000015",
                    input_cache_read: "0.00000004",
                    input_cache_write: "0.0000005",
                  },
                ],
              },
            }),
          ]

  return { data: { id: productID, endpoints } }
}

function productFromEndpointURL(url: string): string | null {
  return ENDPOINT_PRICING_PRODUCTS.find(({ sourceURL }) => sourceURL === url)?.productID ?? null
}

function context(options: {
  key?: string | null
  credentialType?: "key" | "oauth" | "external"
  onModelList?: () => void
  onActive?: () => void
}) {
  const calls = { active: 0, resolve: 0 }
  const native = {
    integration: {
      connection: {
        active: (integrationID: string) => {
          expect(integrationID).toBe("openrouter")
          calls.active += 1
          options.onActive?.()
          return Effect.succeed({
            type: "credential",
            id: "credential-id",
            label: "Configured connection",
            method: "key",
          })
        },
        resolve: () => {
          calls.resolve += 1
          if (options.key === null) return Effect.succeed(undefined)
          return Effect.succeed({
            type: options.credentialType ?? "key",
            key: options.key ?? syntheticKey,
            metadata: { access: "must-not-persist" },
          })
        },
      },
    },
    location: { directory: projectDirectory },
    model: {
      list: () => {
        options.onModelList?.()
        return Effect.succeed({ data: [nativeModel("gpt-source-test")] })
      },
    },
  }
  return { native: native as never, calls }
}

function rowsFromDatabase(path: string) {
  const db = new Database(path, { readonly: true, strict: true })
  try {
    return [
      ...db
        .query<{ body: string }, []>("SELECT body FROM model_evidence_snapshots ORDER BY source")
        .all(),
      ...db
        .query<{ body: string }, []>(
          "SELECT body FROM model_endpoint_pricing_snapshots ORDER BY product_id",
        )
        .all(),
    ].map((row) => row.body)
  } finally {
    db.close()
  }
}

test("refresh records allowlisted native, OpenRouter catalog and dated benchmark evidence", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const store = new ModelEvidenceStore(path, projectDirectory)
  const { native, calls } = context({})
  const requests: Array<{ url: string; method: string; redirect: string; authorization: string }> =
    []
  const fetcher: ModelEvidenceFetcher = async (input, init) => {
    const url = String(input)
    requests.push({
      url,
      method: init?.method ?? "",
      redirect: init?.redirect ?? "",
      authorization: new Headers(init?.headers).get("authorization") ?? "",
    })
    const productID = productFromEndpointURL(url)
    return new Response(
      JSON.stringify(
        productID
          ? endpointResponse(productID)
          : url.includes("benchmarks")
            ? benchmarkResponse()
            : modelResponse(),
      ),
      { headers: { "x-synthetic-secret": syntheticKey } },
    )
  }
  try {
    const output = await new ModelEvidenceRefresher(native, store, fetcher).refresh(
      new AbortController().signal,
    )
    expect(output.sources.map(({ source, state }) => [source, state])).toEqual([
      ["native-catalog", "succeeded"],
      ["openrouter-models", "succeeded"],
      ["openrouter-benchmarks", "succeeded"],
    ])
    expect(calls).toEqual({ active: 1, resolve: 1 })
    expect(requests).toHaveLength(5)
    expect(requests).toEqual(
      expect.arrayContaining([
        {
          url: "https://openrouter.ai/api/v1/models",
          method: "GET",
          redirect: "error",
          authorization: `Bearer ${syntheticKey}`,
        },
        {
          url: "https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis&task_type=coding",
          method: "GET",
          redirect: "error",
          authorization: `Bearer ${syntheticKey}`,
        },
        ...ENDPOINT_PRICING_PRODUCTS.map(({ sourceURL }) => ({
          url: sourceURL,
          method: "GET",
          redirect: "error",
          authorization: `Bearer ${syntheticKey}`,
        })),
      ]),
    )

    const snapshots = Object.fromEntries(
      await Promise.all(
        output.sources.map(async ({ source, latestSnapshotID }) => {
          const page = store.read({ snapshotID: latestSnapshotID, limit: 100 }).snapshot!
          return [source, page]
        }),
      ),
    )
    expect(snapshots["native-catalog"]).toMatchObject({
      snapshot: { source: "native-catalog", citation: "OpenCode native model catalog" },
      records: [
        {
          providerID: "openai",
          id: "gpt-source-test",
          variants: ["high", "max"],
          prices: {
            unit: "USD per million tokens",
            tiers: [{ contextTierTokens: 200_000, input: 2, output: 8 }],
          },
        },
      ],
    })
    expect(snapshots["openrouter-models"]).toMatchObject({
      snapshot: { source: "openrouter-models", version: null, asOf: null },
      records: [
        {
          id: "openai/gpt-source-test",
          canonicalSlug: "openai/gpt-source-test-20261102",
          supportedParameters: ["tools", "reasoning_effort"],
          prices: {
            unit: "USD per token",
            tiers: [
              { minPromptTokens: null, prompt: "0.000002", completion: "0.000008" },
              { minPromptTokens: 100_000, prompt: "0.000004", completion: "0.000016" },
            ],
          },
        },
      ],
    })
    expect(snapshots["openrouter-benchmarks"]).toMatchObject({
      snapshot: {
        source: "openrouter-benchmarks",
        asOf: "2026-11-02T12:00:09.958Z",
        version: "v1",
        citation: "Source: Artificial Analysis via OpenRouter.",
        upstreamSourceURL: "https://artificialanalysis.ai/",
      },
      records: [
        {
          modelPermaslug: "openai/gpt-source-test-20261102",
          effort: null,
          codingIndex: 78.25,
          agenticIndex: 49.5,
          intelligenceIndex: null,
          prices: { unit: "USD per token", prompt: "0.000002", completion: "0.000008" },
        },
      ],
    })

    const endpointPricing = output.endpointPricing!
    expect(endpointPricing).toMatchObject({ state: "succeeded", complete: true, generation: 1 })
    const kimi = endpointPricing.scenarios.find(
      ({ productID }) => productID === "moonshotai/kimi-k3.1-pro",
    )!.snapshot!
    expect(kimi).toMatchObject({
      sourceURL: ENDPOINT_PRICING_PRODUCTS[0].sourceURL,
      httpStatus: 200,
      records: [
        {
          providerName: "Moonshot AI",
          tag: "moonshotai/mxfp4",
          serviceTier: null,
          status: 0,
          supportsImplicitCaching: true,
          pricing: {
            unit: "USD per token",
            prompt: "0.000002",
            completion: "0.00001",
            inputCacheRead: "0.0000002",
          },
          cacheWriteDocumentation: {
            field: "input_cache_write",
            supportedRate: "0",
            sourceURL: "https://openrouter.ai/docs/guides/best-practices/prompt-caching",
            statement: "Moonshot AI prompt caching documentation: cache writes have no cost.",
            policyID: "openrouter-moonshot-kimi-mxfp4-cache-write-zero-v1",
            scope: {
              productID: "moonshotai/kimi-k3.1-pro",
              providerName: "Moonshot AI",
              tag: "moonshotai/mxfp4",
              serviceTier: null,
            },
          },
        },
        {
          providerName: "Moonshot AI",
          tag: "moonshotai/highspeed",
          serviceTier: "priority",
          pricing: { inputCacheWrite: null },
          cacheWriteDocumentation: null,
        },
        {
          providerName: "Moonshot AI",
          tag: "moonshotai/mxfp4",
          serviceTier: "priority",
          cacheWriteDocumentation: null,
        },
      ],
    })
    expect(kimi.records[0]!.pricing).not.toHaveProperty("inputCacheWrite")
    expect(kimi.records[0]!.cacheWriteDocumentation?.retrievedAt).toBe("2026-11-05T23:11:25.854Z")
    expect(kimi.records[0]!.pricing.inputCacheRead).toBe("0.0000002")
    expect(kimi.records[2]!.pricing).not.toHaveProperty("inputCacheWrite")

    const explicitNullPayload = endpointResponse("moonshotai/kimi-k3.1-pro")
    explicitNullPayload.data.endpoints = [
      {
        ...explicitNullPayload.data.endpoints[0]!,
        pricing: { ...explicitNullPayload.data.endpoints[0]!.pricing, input_cache_write: null },
      },
    ]
    const explicitNull = parseEndpointPricingResponse(
      explicitNullPayload,
      "moonshotai/kimi-k3.1-pro",
    )[0]!
    expect(explicitNull.pricing.inputCacheWrite).toBeNull()
    expect(explicitNull.cacheWriteDocumentation).toBeNull()

    const qwen = endpointPricing.scenarios.find(
      ({ productID }) => productID === "qwen/qwen3.8-flash",
    )!.snapshot!
    expect(qwen.records).toMatchObject([
      {
        providerName: "Alibaba",
        tag: "alibaba",
        supportsImplicitCaching: false,
        pricing: { inputCacheWrite: "0.0000002" },
        cacheWriteDocumentation: null,
      },
      {
        providerName: "Alibaba",
        tag: "alibaba/us-east-1",
        supportsImplicitCaching: false,
        cacheWriteDocumentation: null,
      },
    ])
    expect(qwen.records[1]!.pricing).not.toHaveProperty("inputCacheWrite")

    const luna = endpointPricing.scenarios.find(
      ({ productID }) => productID === "openai/gpt-6-luna",
    )!.snapshot!
    expect(luna.records.map(({ tag, serviceTier }) => [tag, serviceTier])).toEqual([
      ["openai", null],
      ["openai/flex", "flex"],
      ["openai/fast", "priority"],
    ])
    expect(luna.records[0]!.pricing.overrides).toEqual([
      {
        minPromptTokens: 272_000,
        prompt: "0.0000002",
        completion: "0.00000075",
        inputCacheRead: "0.00000002",
        inputCacheWrite: "0.00000025",
      },
    ])
    expect(luna.records[1]!.pricing.prompt).toBe("0.00000005")
    expect(luna.records[2]!.pricing.prompt).toBe("0.0000002")
    expect(luna.records[0]!.pricing.webSearchUSDPerRequest).toBe("0.01")
    expect(store.read().endpointPricing).toEqual(endpointPricing)

    const outputText = JSON.stringify(output)
    const savedText = rowsFromDatabase(path).join("\n")
    for (const forbidden of [
      syntheticKey,
      "must-not-persist",
      "ignored_private_field",
      "unsupported_effort",
    ])
      expect(outputText).not.toContain(forbidden)
    for (const forbidden of [
      syntheticKey,
      "must-not-persist",
      "ignored_private_field",
      "unsupported_effort",
    ])
      expect(savedText).not.toContain(forbidden)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("public model metadata refreshes without credentials while benchmark credential status stays explicit", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const store = new ModelEvidenceStore(path, projectDirectory)
  const requests: Array<{ url: string; authorization: string }> = []
  const fetcher: ModelEvidenceFetcher = async (input, init) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization") ?? "",
    })
    return new Response(JSON.stringify(modelResponse()))
  }
  try {
    const missing = context({ key: null })
    const noKey = await new ModelEvidenceRefresher(missing.native, store, fetcher).refresh(
      new AbortController().signal,
    )
    expect(noKey.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "openrouter-models", state: "succeeded" }),
        expect.objectContaining({
          source: "openrouter-benchmarks",
          state: "failed",
          errorCode: "missing-credentials",
        }),
      ]),
    )
    expect(noKey.endpointPricing).toMatchObject({
      state: "failed",
      complete: false,
      scenarios: ENDPOINT_PRICING_PRODUCTS.map(({ productID, sourceURL }) => ({
        productID,
        sourceURL,
        state: "failed",
        errorCode: "missing-credentials",
        httpStatus: null,
        snapshot: null,
      })),
    })
    const unsupported = context({ credentialType: "oauth" })
    const noSupportedCredential = await new ModelEvidenceRefresher(
      unsupported.native,
      store,
      fetcher,
    ).refresh(new AbortController().signal)
    expect(noSupportedCredential.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "openrouter-models", state: "succeeded" }),
        expect.objectContaining({
          source: "openrouter-benchmarks",
          state: "failed",
          errorCode: "unsupported-credentials",
        }),
      ]),
    )
    expect(noSupportedCredential.endpointPricing?.scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "failed", errorCode: "unsupported-credentials" }),
      ]),
    )
    expect(requests).toEqual([
      { url: "https://openrouter.ai/api/v1/models", authorization: "" },
      { url: "https://openrouter.ai/api/v1/models", authorization: "" },
    ])
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("HTTP failures, malformed and oversized bodies are bounded and retain the previous successful snapshot", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const store = new ModelEvidenceStore(path, projectDirectory)
  const { native } = context({})
  let failBenchmarks: number | "malformed" | "oversized" | "exception" | null = null
  let fetchCount = 0
  const fetcher: ModelEvidenceFetcher = async (input) => {
    fetchCount += 1
    const url = String(input)
    const productID = productFromEndpointURL(url)
    if (productID) return new Response(JSON.stringify(endpointResponse(productID)))
    if (!url.includes("benchmarks")) return new Response(JSON.stringify(modelResponse()))
    if (failBenchmarks === "malformed") return new Response("{invalid json")
    if (failBenchmarks === "oversized")
      return new Response(JSON.stringify({ data: ["x".repeat(4 * 1024 * 1024)] }))
    if (failBenchmarks === "exception") throw new Error(`Authorization: Bearer ${syntheticKey}`)
    if (typeof failBenchmarks === "number")
      return new Response(syntheticKey, { status: failBenchmarks })
    return new Response(JSON.stringify(benchmarkResponse()))
  }
  try {
    const refresher = () => new ModelEvidenceRefresher(native, store, fetcher)
    const first = await refresher().refresh(new AbortController().signal)
    const firstBenchmarkID = first.sources[2]!.latestSnapshotID
    expect(first.sources[2]!.state).toBe("succeeded")

    for (const [code, expected] of [
      [401, "unauthorized"],
      [429, "rate-limited"],
      [500, "server-error"],
      ["malformed", "malformed-response"],
      ["oversized", "response-too-large"],
      ["exception", "network-error"],
    ] as const) {
      failBenchmarks = code
      const result = await refresher().refresh(new AbortController().signal)
      expect(result.sources[2]).toMatchObject({
        state: "failed",
        errorCode: expected,
        latestSnapshotID: firstBenchmarkID,
      })
    }
    expect(fetchCount).toBe(35)
    expect(rowsFromDatabase(path).join("\n")).not.toContain(syntheticKey)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("endpoint failures, malformed product selection and ambiguous records preserve last-good evidence", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const store = new ModelEvidenceStore(path, projectDirectory)
  const { native } = context({})
  let failure:
    | number
    | "malformed-json"
    | "oversized"
    | "duplicate"
    | "wrong-product"
    | "conflicting-record"
    | "invalid-rate"
    | "exception"
    | null = null
  const fetcher: ModelEvidenceFetcher = async (input) => {
    const url = String(input)
    const productID = productFromEndpointURL(url)
    if (productID === "moonshotai/kimi-k3.1-pro") {
      if (failure === "malformed-json") return new Response("{invalid json")
      if (failure === "oversized")
        return new Response(JSON.stringify({ data: "x".repeat(4 * 1024 * 1024) }))
      if (failure === "exception") throw new Error(`Authorization: Bearer ${syntheticKey}`)
      if (typeof failure === "number") return new Response("upstream", { status: failure })
      const payload = endpointResponse(productID)
      if (failure === "duplicate") payload.data.endpoints.push({ ...payload.data.endpoints[0]! })
      if (failure === "wrong-product") payload.data.id = "qwen/qwen3.8-flash"
      if (failure === "conflicting-record")
        payload.data.endpoints[0]!.model_id = "qwen/qwen3.8-flash"
      if (failure === "invalid-rate") payload.data.endpoints[0]!.pricing.prompt = syntheticKey
      return new Response(JSON.stringify(payload))
    }
    if (productID) return new Response(JSON.stringify(endpointResponse(productID)))
    return new Response(
      JSON.stringify(url.includes("benchmarks") ? benchmarkResponse() : modelResponse()),
    )
  }
  try {
    const refresh = () =>
      new ModelEvidenceRefresher(native, store, fetcher).refresh(new AbortController().signal)
    const first = await refresh()
    const firstKimi = first.endpointPricing!.scenarios[0]!
    expect(firstKimi.state).toBe("succeeded")
    const firstSnapshotID = firstKimi.latestSnapshotID

    for (const [fault, errorCode, httpStatus] of [
      [503, "server-error", 503],
      ["malformed-json", "malformed-response", 200],
      ["oversized", "response-too-large", 200],
      ["duplicate", "malformed-response", 200],
      ["wrong-product", "malformed-response", 200],
      ["conflicting-record", "malformed-response", 200],
      ["invalid-rate", "malformed-response", 200],
      ["exception", "network-error", null],
    ] as const) {
      failure = fault
      const result = await refresh()
      expect(result.endpointPricing).toMatchObject({ state: "partial", complete: false })
      expect(result.endpointPricing?.scenarios[0]).toMatchObject({
        productID: "moonshotai/kimi-k3.1-pro",
        sourceURL: ENDPOINT_PRICING_PRODUCTS[0].sourceURL,
        state: "failed",
        errorCode,
        httpStatus,
        latestSnapshotID: firstSnapshotID,
        snapshot: { snapshotID: firstSnapshotID },
      })
      expect(result.endpointPricing?.scenarios[0]?.snapshot?.records).toEqual(
        firstKimi.snapshot?.records,
      )
    }
    expect(rowsFromDatabase(path).join("\n")).not.toContain(syntheticKey)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("cached reads remain immediate and report refreshing while metadata requests are pending", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const store = new ModelEvidenceStore(path, projectDirectory)
  const { native } = context({})
  let release!: () => void
  let entered!: () => void
  let requests = 0
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const fetcher: ModelEvidenceFetcher = async (input) => {
    requests += 1
    if (requests === 2) entered()
    await waiting
    const url = String(input)
    const productID = productFromEndpointURL(url)
    return new Response(
      JSON.stringify(
        productID
          ? endpointResponse(productID)
          : url.includes("benchmarks")
            ? benchmarkResponse()
            : modelResponse(),
      ),
    )
  }
  try {
    const pending = new ModelEvidenceRefresher(native, store, fetcher).refresh(
      new AbortController().signal,
    )
    await started
    expect(store.read().sources.map(({ state }) => state)).toEqual([
      "refreshing",
      "refreshing",
      "refreshing",
    ])
    expect(store.read().sources.map(({ latestSnapshotID }) => latestSnapshotID)).toEqual([
      null,
      null,
      null,
    ])
    expect(store.read().endpointPricing?.state).toBe("refreshing")
    release()
    const refreshed = await pending
    expect(refreshed.sources.map(({ state }) => state)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ])
    expect(refreshed.endpointPricing).toMatchObject({ state: "succeeded", complete: true })
  } finally {
    release()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("cancellation before credential access or commit records cancellation without snapshots", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const store = new ModelEvidenceStore(path, projectDirectory)
  const controller = new AbortController()
  const { native, calls } = context({ onModelList: () => controller.abort() })
  let fetches = 0
  const fetcher: ModelEvidenceFetcher = async () => {
    fetches += 1
    return new Response(JSON.stringify(modelResponse()))
  }
  try {
    const output = await new ModelEvidenceRefresher(native, store, fetcher).refresh(
      controller.signal,
    )
    expect(output.sources.map(({ state }) => state)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ])
    expect(output.endpointPricing).toMatchObject({ state: "cancelled", complete: false })
    expect(output.endpointPricing?.scenarios.map(({ state }) => state)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ])
    expect(calls).toEqual({ active: 0, resolve: 0 })
    expect(fetches).toBe(0)
    expect(rowsFromDatabase(path)).toEqual([])
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("cancellation after fetching but before persistence prevents any successful snapshot commit", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const store = new ModelEvidenceStore(path, projectDirectory)
  const controller = new AbortController()
  const { native } = context({})
  const fetcher: ModelEvidenceFetcher = async (input) => {
    if (String(input).includes("benchmarks")) controller.abort()
    return new Response(
      JSON.stringify(String(input).includes("benchmarks") ? benchmarkResponse() : modelResponse()),
    )
  }
  try {
    const output = await new ModelEvidenceRefresher(native, store, fetcher).refresh(
      controller.signal,
    )
    expect(output.sources.map(({ state }) => state)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ])
    expect(output.endpointPricing).toMatchObject({ state: "cancelled", complete: false })
    expect(rowsFromDatabase(path)).toEqual([])
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("cancellation during endpoint fetch keeps last-good scenarios and commits none of the cancelled generation", async () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const store = new ModelEvidenceStore(path, projectDirectory)
  const { native } = context({})
  const fetcher: ModelEvidenceFetcher = async (input) => {
    const url = String(input)
    const productID = productFromEndpointURL(url)
    return new Response(
      JSON.stringify(
        productID
          ? endpointResponse(productID)
          : url.includes("benchmarks")
            ? benchmarkResponse()
            : modelResponse(),
      ),
    )
  }
  try {
    const first = await new ModelEvidenceRefresher(native, store, fetcher).refresh(
      new AbortController().signal,
    )
    const firstSnapshots = first.endpointPricing!.scenarios.map(
      ({ latestSnapshotID }) => latestSnapshotID,
    )
    const controller = new AbortController()
    const cancellingFetcher: ModelEvidenceFetcher = async (input) => {
      const url = String(input)
      if (url === ENDPOINT_PRICING_PRODUCTS[0].sourceURL) controller.abort()
      const productID = productFromEndpointURL(url)
      return new Response(
        JSON.stringify(
          productID
            ? endpointResponse(productID)
            : url.includes("benchmarks")
              ? benchmarkResponse()
              : modelResponse(),
        ),
      )
    }
    const cancelled = await new ModelEvidenceRefresher(native, store, cancellingFetcher).refresh(
      controller.signal,
    )
    expect(cancelled.endpointPricing).toMatchObject({ state: "cancelled", complete: false })
    expect(cancelled.endpointPricing?.scenarios.map(({ state }) => state)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ])
    expect(cancelled.endpointPricing?.scenarios[0]?.httpStatus).toBe(200)
    expect(
      cancelled.endpointPricing?.scenarios.map(({ latestSnapshotID }) => latestSnapshotID),
    ).toEqual(firstSnapshots)
    const db = new Database(path, { readonly: true, strict: true })
    try {
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM model_endpoint_pricing_snapshots",
          )
          .get()!.count,
      ).toBe(3)
    } finally {
      db.close()
    }
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("real router quote sentinel remains unknown without dropping normal or explicitly free records", async () => {
  const root = directory()
  const store = new ModelEvidenceStore(root + "/fixture.sqlite", "/price-regression")
  try {
    const context = {
      location: { directory: "/price-regression" },
      model: { list: () => Effect.succeed({ data: [] }) },
      integration: { connection: { active: () => Effect.succeed(null) } },
    }
    const fetcher = async () =>
      Response.json({
        data: [
          { id: "normal/model", pricing: { prompt: "0.000001", completion: "0.000004" } },
          { id: "openrouter/auto", pricing: { prompt: "-1", completion: -1 } },
          { id: "normal/free", pricing: { prompt: "0", completion: "0" } },
        ],
      })
    const output = await new ModelEvidenceRefresher(context as never, store, fetcher).refresh(
      AbortSignal.timeout(5000),
    )
    const source = output.sources.find((x) => x.source === "openrouter-models")!
    expect(source.state).toBe("succeeded")
    expect(source.latestRecordCount).toBe(3)
    const records = store.read({ snapshotID: source.latestSnapshotID!, limit: 10 }).snapshot!
      .records
    const quotes = records
      .filter((x) => x.kind === "openrouter-model")
      .map((x) => ({
        id: x.id,
        prompt: x.prices?.tiers[0]?.prompt,
        completion: x.prices?.tiers[0]?.completion,
      }))
    expect(quotes).toEqual([
      { id: "normal/model", prompt: "0.000001", completion: "0.000004" },
      { id: "openrouter/auto", prompt: null, completion: null },
      { id: "normal/free", prompt: "0", completion: "0" },
    ])
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("published UTC price overrides are retained separately from context thresholds", async () => {
  const root = directory()
  const store = new ModelEvidenceStore(root + "/fixture.sqlite", "/price-regression")
  try {
    const context = {
      location: { directory: "/price-regression" },
      model: { list: () => Effect.succeed({ data: [] }) },
      integration: { connection: { active: () => Effect.succeed(null) } },
    }
    const fetcher = async () =>
      Response.json({
        data: [
          {
            id: "minimax/minimax-m3.1-flash",
            pricing: {
              prompt: "0.000000075",
              completion: "0.0000003",
              overrides: [
                { utc_start: 1500, utc_end: 100, prompt: "0.000000075", completion: "0.0000003" },
                { utc_start: 100, utc_end: 1500, prompt: "0.00000015", completion: "0.0000006" },
              ],
            },
          },
        ],
      })
    const output = await new ModelEvidenceRefresher(context as never, store, fetcher).refresh(
      AbortSignal.timeout(5000),
    )
    const source = output.sources.find((x) => x.source === "openrouter-models")!
    expect(source.state).toBe("succeeded")
    const record = store.read({ snapshotID: source.latestSnapshotID!, limit: 10 }).snapshot!
      .records[0]!
    expect(record).toMatchObject({
      kind: "openrouter-model",
      prices: {
        tiers: [
          { minPromptTokens: null, utcStart: null, utcEnd: null, prompt: "0.000000075" },
          { minPromptTokens: null, utcStart: 1500, utcEnd: 100, prompt: "0.000000075" },
          { minPromptTokens: null, utcStart: 100, utcEnd: 1500, prompt: "0.00000015" },
        ],
      },
    })
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
