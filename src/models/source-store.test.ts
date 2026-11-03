import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MODEL_EVIDENCE_QUERIES,
  MODEL_EVIDENCE_SOURCE_URLS,
  ModelEvidenceSnapshotSchema,
} from "./source-schema.ts"
import type { ModelEvidenceSource } from "./source-schema.ts"
import { ModelEvidenceReadStore, ModelEvidenceStore } from "./source-store.ts"

const projectDirectory = "/source-store-project"

function directory() {
  return mkdtempSync(join(tmpdir(), "lazers-model-evidence-store-"))
}

function snapshot(
  source: ModelEvidenceSource,
  project: string,
  generation: number,
  records: unknown[] = [],
) {
  return ModelEvidenceSnapshotSchema.parse({
    snapshotID: crypto.randomUUID(),
    projectDirectory: project,
    source,
    generation,
    retrievedAt: new Date().toISOString(),
    asOf: null,
    version: null,
    citation: "Test source",
    upstreamSourceURL: null,
    sourceURL: MODEL_EVIDENCE_SOURCE_URLS[source],
    query: MODEL_EVIDENCE_QUERIES[source],
    records,
  })
}

function nativeRecord(id: string) {
  return {
    kind: "native-model",
    providerID: "openai",
    id,
    name: id,
    enabled: true,
    type: "language",
    contextTokens: 128_000,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: ["high", "max"],
    prices: {
      unit: "USD per million tokens",
      tiers: [
        {
          contextTierTokens: null,
          input: 1,
          output: 2,
          cacheRead: 0.2,
          cacheWrite: 1.5,
        },
      ],
    },
  }
}

test("source snapshots persist by retained ID and cached records paginate within project", () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  let store = new ModelEvidenceStore(path, projectDirectory)
  let retainedID!: string
  try {
    expect(store.read().sources[0]).toMatchObject({
      source: "native-catalog",
      state: "never",
      latestSnapshotID: null,
    })
    const generations = store.beginRefresh()
    expect(store.read().sources[0]!.state).toBe("refreshing")
    const saved = snapshot("native-catalog", projectDirectory, generations["native-catalog"], [
      nativeRecord("one"),
      nativeRecord("two"),
      nativeRecord("three"),
    ])
    retainedID = saved.snapshotID
    store.saveSnapshot(saved)

    const firstPage = store.read({ snapshotID: saved.snapshotID, limit: 2 })
    expect(firstPage.sources[0]).toMatchObject({
      state: "succeeded",
      latestSnapshotID: saved.snapshotID,
      latestRecordCount: 3,
    })
    expect(firstPage.snapshot).toMatchObject({
      snapshot: {
        snapshotID: saved.snapshotID,
        source: "native-catalog",
        sourceURL: MODEL_EVIDENCE_SOURCE_URLS["native-catalog"],
        query: MODEL_EVIDENCE_QUERIES["native-catalog"],
        recordCount: 3,
      },
      records: [{ id: "one", variants: ["high", "max"] }, { id: "two" }],
      nextCursor: "2",
    })
    expect(
      store.read({ snapshotID: saved.snapshotID, cursor: "2", limit: 2 }).snapshot,
    ).toMatchObject({ records: [{ id: "three" }], nextCursor: null })
  } finally {
    store.close()
  }

  store = new ModelEvidenceStore(path, projectDirectory)
  try {
    const dbRead = store.read({ snapshotID: retainedID, limit: 1 })
    expect(dbRead.snapshot?.records).toMatchObject([nativeRecord("one")])
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("empty success, failures, and stale refresh completion keep status and selected data distinct", () => {
  const root = directory()
  const store = new ModelEvidenceStore(join(root, "tasks.sqlite"), projectDirectory)
  try {
    const first = store.beginRefresh()["openrouter-models"]
    const empty = snapshot("openrouter-models", projectDirectory, first, [])
    store.saveSnapshot(empty)
    expect(store.read().sources[1]).toMatchObject({
      state: "succeeded",
      latestSnapshotID: empty.snapshotID,
      latestRecordCount: 0,
      errorCode: null,
    })

    const failedGeneration = store.beginRefresh()["openrouter-models"]
    store.failRefresh("openrouter-models", failedGeneration, "rate-limited", 429)
    expect(store.read().sources[1]).toMatchObject({
      state: "failed",
      latestSnapshotID: empty.snapshotID,
      latestRecordCount: 0,
      errorCode: "rate-limited",
      httpStatus: 429,
    })

    const older = store.beginRefresh()["openrouter-models"]
    const newer = store.beginRefresh()["openrouter-models"]
    const newest = snapshot("openrouter-models", projectDirectory, newer, [])
    store.saveSnapshot(newest)
    store.saveSnapshot(snapshot("openrouter-models", projectDirectory, older, []))
    store.failRefresh("openrouter-models", older, "server-error", 500)
    expect(store.read().sources[1]).toMatchObject({
      state: "succeeded",
      generation: newer,
      latestSnapshotID: newest.snapshotID,
      latestRetrievedAt: newest.retrievedAt,
      latestRecordCount: 0,
      errorCode: null,
    })

    const cancelled = store.beginRefresh()["openrouter-models"]
    store.cancelRefresh("openrouter-models", cancelled)
    expect(store.read().sources[1]).toMatchObject({
      state: "cancelled",
      latestSnapshotID: newest.snapshotID,
      latestRecordCount: 0,
    })
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("a retained snapshot ID cannot be read by a foreign project", () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const owner = new ModelEvidenceStore(path, projectDirectory)
  const foreign = new ModelEvidenceStore(path, "/foreign-project")
  try {
    const generation = owner.beginRefresh()["native-catalog"]
    const saved = snapshot("native-catalog", projectDirectory, generation, [
      nativeRecord("private"),
    ])
    owner.saveSnapshot(saved)
    expect(() => foreign.read({ snapshotID: saved.snapshotID })).toThrow(
      "Model evidence snapshot is unavailable in this project",
    )
    expect(() => owner.read({ snapshotID: saved.snapshotID, cursor: "999999999" })).toThrow(
      "Model evidence page cursor is unavailable",
    )
  } finally {
    owner.close()
    foreign.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("comparison reader reports missing tables without initializing source storage", () => {
  const root = directory()
  const path = join(root, "empty.sqlite")
  const empty = new Database(path, { create: true, strict: true })
  empty.close()
  const reader = new ModelEvidenceReadStore(path, projectDirectory)
  try {
    expect(
      reader.readComparisonSources().map(({ source, storage, snapshotState, refresh }) => ({
        source,
        storage,
        snapshotState,
        refresh,
      })),
    ).toEqual([
      {
        source: "native-catalog",
        storage: "missing-both-tables",
        snapshotState: "missing-table",
        refresh: null,
      },
      {
        source: "openrouter-models",
        storage: "missing-both-tables",
        snapshotState: "missing-table",
        refresh: null,
      },
      {
        source: "openrouter-benchmarks",
        storage: "missing-both-tables",
        snapshotState: "missing-table",
        refresh: null,
      },
    ])
    const check = new Database(path, { readonly: true, strict: true })
    try {
      expect(
        check
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'model_evidence_%'",
          )
          .all(),
      ).toEqual([])
    } finally {
      check.close()
    }
  } finally {
    reader.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("comparison reader pins snapshots and scopes selected IDs to the project", () => {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const owner = new ModelEvidenceStore(path, projectDirectory)
  const foreign = new ModelEvidenceReadStore(path, "/foreign-project")
  const reader = new ModelEvidenceReadStore(path, projectDirectory)
  try {
    const firstGeneration = owner.beginRefresh()["native-catalog"]
    const first = snapshot("native-catalog", projectDirectory, firstGeneration, [
      nativeRecord("first"),
    ])
    owner.saveSnapshot(first)
    const selected = Object.fromEntries(
      reader.readComparisonSources().map(({ source, snapshotID }) => [source, snapshotID]),
    ) as Record<ModelEvidenceSource, string | null>
    const nextGeneration = owner.beginRefresh()["native-catalog"]
    owner.saveSnapshot(
      snapshot("native-catalog", projectDirectory, nextGeneration, [nativeRecord("second")]),
    )

    expect(reader.readComparisonSources(selected)[0]).toMatchObject({
      snapshotID: first.snapshotID,
      snapshot: { snapshotID: first.snapshotID, generation: firstGeneration },
    })
    expect(foreign.readComparisonSources(selected)[0]).toMatchObject({
      snapshotState: "missing-snapshot",
      snapshotID: first.snapshotID,
      snapshot: null,
      refresh: { state: "never" },
    })
  } finally {
    reader.close()
    foreign.close()
    owner.close()
    rmSync(root, { recursive: true, force: true })
  }
})
