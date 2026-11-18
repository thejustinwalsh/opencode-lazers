import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  INFO_TTL_MS,
  ModelEvidenceRefresher,
  PRICE_TTL_MS,
  createRefreshGate,
  dueSources,
} from "./source-refresh.ts"
import type { ModelEvidenceFetcher } from "./source-refresh.ts"
import { ModelEvidenceStore } from "./source-store.ts"

const projectDirectory = "/source-cache-project"
const MODELS_URL = "https://openrouter.ai/api/v1/models"

type Listing = Array<{ id: string; name: string; prompt: string; completion: string }>

/** A fetcher whose responses can be changed between refreshes; counts every request. */
function harness(options: { failModels?: () => boolean } = {}) {
  const state = {
    models: [
      { id: "acme/alpha", name: "Alpha", prompt: "0.000002", completion: "0.000008" },
    ] as Listing,
    requests: [] as string[],
  }
  const fetcher: ModelEvidenceFetcher = async (input) => {
    const url = String(input)
    state.requests.push(url)
    if (url === MODELS_URL && options.failModels?.()) return new Response("nope", { status: 500 })
    if (url === MODELS_URL)
      return new Response(
        JSON.stringify({
          data: state.models.map((model) => ({
            id: model.id,
            name: model.name,
            context_length: 100_000,
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            supported_parameters: ["tools"],
            pricing: { prompt: model.prompt, completion: model.completion },
          })),
        }),
      )
    if (url.includes("benchmarks"))
      return new Response(
        JSON.stringify({
          data: [
            {
              source: "artificial-analysis",
              model_permaslug: "acme/alpha",
              display_name: "Alpha",
              coding_index: 50,
              agentic_index: null,
              intelligence_index: null,
              pricing: null,
            },
          ],
          meta: {
            as_of: "2026-11-02T12:00:00.000Z",
            version: "v1",
            source: "artificial-analysis",
            task_type: "coding",
          },
        }),
      )
    // Endpoint pricing products: nothing to price.
    return new Response(JSON.stringify({ data: { endpoints: [] } }))
  }
  const native = {
    integration: {
      connection: {
        active: () => Effect.succeed({ type: "credential", id: "c", label: "c", method: "key" }),
        resolve: () => Effect.succeed({ type: "key", key: "sk-or-v1-test", metadata: {} }),
      },
    },
    location: { directory: projectDirectory },
    model: {
      list: () =>
        Effect.succeed({
          data: [
            {
              providerID: "acme",
              id: "alpha",
              name: "Native Alpha",
              enabled: true,
              type: "language",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 100_000 },
              variants: [],
              cost: [{ input: 2, output: 8 }],
            },
          ],
        }),
    },
  } as never
  const open = (path: string) => new ModelEvidenceStore(path, projectDirectory)
  const modelFetches = () => state.requests.filter((url) => url === MODELS_URL).length
  return { state, fetcher, native, open, modelFetches }
}

const path = () => join(mkdtempSync(join(tmpdir(), "lazers-source-cache-")), "tasks.sqlite")
const signal = () => new AbortController().signal

async function seeded(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options)
  const file = path()
  const store = h.open(file)
  await new ModelEvidenceRefresher(h.native, store, h.fetcher).refresh(signal())
  return { ...h, file, store }
}

const modelsSnapshot = (store: ModelEvidenceStore) => store.latestSnapshot("openrouter-models")!
const record = (store: ModelEvidenceStore, id: string) =>
  modelsSnapshot(store).records.find(
    (entry) => entry.kind === "openrouter-model" && entry.id === id,
  )

test("a cold start with a stored snapshot makes zero fetches and serves the full set", async () => {
  const { file, state, store, native, fetcher, open } = await seeded()
  store.close()
  const fetchesBefore = state.requests.length
  // A new store instance over the same file: the snapshot survived.
  const reopened = open(file)
  try {
    const refresher = new ModelEvidenceRefresher(native, reopened, fetcher)
    expect(refresher.due()).toEqual(new Map())
    await refresher.refresh(signal(), refresher.due())
    expect(state.requests).toHaveLength(fetchesBefore)
    expect(modelsSnapshot(reopened).records).toHaveLength(1)
    expect(reopened.read().sources.every((source) => source.latestRetrievedAt !== null)).toBe(true)
  } finally {
    reopened.close()
  }
})

test("prices are due after an hour, benchmark rows and model info only after a week", async () => {
  const { store } = await seeded()
  try {
    const refresher = new ModelEvidenceRefresher(harness().native, store, harness().fetcher)
    const now = Date.now()
    expect(refresher.due(false, now + PRICE_TTL_MS - 1000)).toEqual(new Map())
    expect(refresher.due(false, now + PRICE_TTL_MS + 1000)).toEqual(
      new Map([
        ["native-catalog", "prices"],
        ["openrouter-models", "prices"],
      ]),
    )
    expect(refresher.due(false, now + INFO_TTL_MS + 1000)).toEqual(
      new Map([
        ["native-catalog", "info"],
        ["openrouter-models", "info"],
        ["openrouter-benchmarks", "info"],
      ]),
    )
    // The manual refresh bypasses every TTL.
    expect(refresher.due(true, now)).toEqual(
      new Map([
        ["native-catalog", "info"],
        ["openrouter-models", "info"],
        ["openrouter-benchmarks", "info"],
      ]),
    )
  } finally {
    store.close()
  }
})

test("a stale price is served stale, then one background fetch replaces it and leaves info alone", async () => {
  const { store, state, native, fetcher } = await seeded()
  try {
    const refresher = new ModelEvidenceRefresher(native, store, fetcher)
    const before = modelsSnapshot(store)
    const infoTime = before.asOf ?? before.retrievedAt
    // Served stale: the stored snapshot is what a reader sees while the refresh is due.
    expect(store.latestSnapshot("openrouter-models")!.snapshotID).toBe(before.snapshotID)
    const due = refresher.due(false, Date.now() + PRICE_TTL_MS + 1000)
    const modelFetches = state.requests.filter((url) => url === MODELS_URL).length
    // The provider renames the model and changes its price.
    state.models = [
      { id: "acme/alpha", name: "Renamed", prompt: "0.000001", completion: "0.000004" },
    ]
    await refresher.refresh(signal(), due)
    expect(state.requests.filter((url) => url === MODELS_URL)).toHaveLength(modelFetches + 1)
    const after = modelsSnapshot(store)
    expect(after.snapshotID).not.toBe(before.snapshotID)
    expect(after.retrievedAt >= before.retrievedAt).toBe(true)
    // Prices moved; info did not: same name, same info time.
    const alpha = record(store, "acme/alpha")!
    expect(alpha).toMatchObject({
      name: "Alpha",
      prices: { tiers: [{ prompt: "0.000001", completion: "0.000004" }] },
    })
    expect(after.asOf).toBe(infoTime)
    // The benchmark rows were not fetched at all.
    expect(state.requests.filter((url) => url.includes("benchmarks"))).toHaveLength(1)
    // A second price refresh keeps the original info time.
    await refresher.refresh(signal(), refresher.due(false, Date.now() + 2 * PRICE_TTL_MS + 5000))
    expect(modelsSnapshot(store).asOf).toBe(infoTime)
  } finally {
    store.close()
  }
})

test("a model first listed by a price refresh is added; one no longer listed is kept until the next info refresh", async () => {
  const { store, state, native, fetcher } = await seeded()
  try {
    const refresher = new ModelEvidenceRefresher(native, store, fetcher)
    state.models = [
      { id: "acme/newcomer", name: "Newcomer", prompt: "0.000003", completion: "0.000009" },
    ]
    await refresher.refresh(signal(), refresher.due(false, Date.now() + PRICE_TTL_MS + 1000))
    expect(record(store, "acme/newcomer")).toMatchObject({ name: "Newcomer" })
    // Alpha vanished from the response but stays, with its old rates.
    expect(record(store, "acme/alpha")).toMatchObject({
      name: "Alpha",
      prices: { tiers: [{ prompt: "0.000002" }] },
    })
    // After a week the info refresh replaces the records: Alpha is dropped.
    const due = refresher.due(false, Date.now() + INFO_TTL_MS + 1000)
    expect(due.get("openrouter-models")).toBe("info")
    await refresher.refresh(signal(), due)
    expect(record(store, "acme/alpha")).toBeUndefined()
    expect(record(store, "acme/newcomer")).toBeDefined()
    // The info time moved to the new fetch.
    expect(modelsSnapshot(store).asOf).toBeNull()
  } finally {
    store.close()
  }
})

test("a failed refresh keeps the old snapshot and records why and when", async () => {
  let failing = false
  const { store, native, fetcher } = await seeded({ failModels: () => failing })
  try {
    const refresher = new ModelEvidenceRefresher(native, store, fetcher)
    const before = modelsSnapshot(store)
    failing = true
    await refresher.refresh(signal(), refresher.due(false, Date.now() + PRICE_TTL_MS + 1000))
    expect(modelsSnapshot(store).snapshotID).toBe(before.snapshotID)
    const status = store.read().sources.find((source) => source.source === "openrouter-models")!
    expect(status).toMatchObject({ state: "failed", errorCode: "server-error", httpStatus: 500 })
    expect(status.completedAt).not.toBeNull()
    expect(status.latestSnapshotID).toBe(before.snapshotID)
    // It is not retried at once: a source that failed a minute ago waits out its retry delay,
    // even though its snapshot is past the TTL.
    const failedAMinuteAgo = [
      {
        ...status,
        completedAt: new Date(Date.now() - 60_000).toISOString(),
        latestRetrievedAt: new Date(Date.now() - 2 * PRICE_TTL_MS).toISOString(),
      },
    ]
    expect(dueSources(failedAMinuteAgo, {}, Date.now()).has("openrouter-models")).toBe(false)
    const failedLongAgo = [
      { ...failedAMinuteAgo[0]!, completedAt: new Date(Date.now() - 600_000).toISOString() },
    ]
    expect(dueSources(failedLongAgo, {}, Date.now()).get("openrouter-models")).toBe("prices")
  } finally {
    store.close()
  }
})

test("concurrent readers share one refresh", async () => {
  const gate = createRefreshGate()
  let fetches = 0
  let release!: () => void
  const slow = () =>
    new Promise<void>((resolve) => {
      fetches += 1
      release = resolve
    })
  const first = gate.start(slow)
  const second = gate.start(slow)
  const third = gate.start(slow)
  expect(gate.busy).toBe(true)
  expect(fetches).toBe(1)
  release()
  await Promise.all([first, second, third])
  expect(gate.busy).toBe(false)
  // After it finishes the next caller starts a new one.
  const next = gate.start(async () => {
    fetches += 1
  })
  await next
  expect(fetches).toBe(2)
  // A failing refresh does not wedge the gate.
  await gate.start(async () => {
    throw new Error("boom")
  })
  expect(gate.busy).toBe(false)
})
