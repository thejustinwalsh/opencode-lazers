import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
    return db
      .query<{ body: string }, []>("SELECT body FROM model_evidence_snapshots ORDER BY source")
      .all()
      .map((row) => row.body)
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
    requests.push({
      url: String(input),
      method: init?.method ?? "",
      redirect: init?.redirect ?? "",
      authorization: new Headers(init?.headers).get("authorization") ?? "",
    })
    return new Response(
      JSON.stringify(String(input).includes("benchmarks") ? benchmarkResponse() : modelResponse()),
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
    expect(requests).toHaveLength(2)
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
    if (!String(input).includes("benchmarks")) return new Response(JSON.stringify(modelResponse()))
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
    expect(fetchCount).toBe(14)
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
    return new Response(
      JSON.stringify(String(input).includes("benchmarks") ? benchmarkResponse() : modelResponse()),
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
    release()
    expect((await pending).sources.map(({ state }) => state)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ])
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
    expect(rowsFromDatabase(path)).toEqual([])
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
