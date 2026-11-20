import { expect, test } from "bun:test"
import { makeLedgerFixture } from "../../test/models-observation-ledger/fixtures/ledger.ts"
import { ModelDecisionReadInputSchema } from "./decision-contract.ts"
import { createModelDecisionReader } from "./decision-read.ts"
import { acquireDecisionWorker, decisionWorkerSnapshot } from "./decision-worker-registry.ts"
import { openReadOnlyObservationLedger } from "./observation-ledger-read.ts"
import { defaultModelPriceSourcePolicy } from "./price-source-settings.ts"
import { readDecisionPriceState, readPriceIdentity } from "./price-state.ts"
import type { PriceInputs } from "./price-state.ts"
import { MODEL_EVIDENCE_QUERIES, MODEL_EVIDENCE_SOURCE_URLS } from "./source-schema.ts"
import { ModelEvidenceSnapshotSchema } from "./source-schema.ts"
import { ModelEvidenceStore, clearParsedSnapshotCache } from "./source-store.ts"

const inputs = (): PriceInputs => ({
  policy: defaultModelPriceSourcePolicy(),
  openrouter: "configured",
})

function inputFor(projectDirectory: string) {
  return ModelDecisionReadInputSchema.parse({
    schemaVersion: 2,
    scope: { projectDirectory },
    filters: { persona: null, taskKind: null, period: { from: null, to: null } },
  })
}

/** A native catalog large enough that rebuilding or cloning it per request would show. */
function seedCatalog(path: string, projectDirectory: string, records: number) {
  const store = new ModelEvidenceStore(path, projectDirectory)
  try {
    const generations = store.beginRefresh(["native-catalog"])
    store.saveSnapshot(
      ModelEvidenceSnapshotSchema.parse({
        snapshotID: crypto.randomUUID(),
        projectDirectory,
        source: "native-catalog",
        generation: generations["native-catalog"],
        retrievedAt: new Date().toISOString(),
        asOf: null,
        version: null,
        citation: "Test source",
        upstreamSourceURL: null,
        sourceURL: MODEL_EVIDENCE_SOURCE_URLS["native-catalog"],
        query: MODEL_EVIDENCE_QUERIES["native-catalog"],
        records: Array.from({ length: records }, (_, index) => ({
          kind: "native-model",
          providerID: "openai",
          id: `catalog-model-${index}`,
          name: `Catalog model ${index} with a descriptive display name`,
          enabled: true,
          type: "language",
          contextTokens: 128_000,
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: ["high", "max"],
          prices: {
            unit: "USD per million tokens",
            tiers: [
              { contextTierTokens: null, input: 1, output: 2, cacheRead: 0.2, cacheWrite: 1.5 },
            ],
          },
        })),
      }),
    )
  } finally {
    store.close()
  }
}

test("every plugin copy shares one decision worker per database and the last release closes it", async () => {
  const fixture = makeLedgerFixture()
  const other = makeLedgerFixture()
  try {
    const before = decisionWorkerSnapshot().length
    // Forty-four plugin copies register against one database; each brings its own provider.
    const leases = Array.from({ length: 44 }, () =>
      acquireDecisionWorker({ path: fixture.path, readPriceInputs: async () => inputs() }),
    )
    const otherLease = acquireDecisionWorker({
      path: other.path,
      readPriceInputs: async () => inputs(),
    })
    const live = decisionWorkerSnapshot()
    expect(live.length).toBe(before + 2)
    expect(live.filter((entry) => entry.refs === 44 && entry.providers === 44)).toHaveLength(1)

    // Any copy's reader reaches the same worker, for its project and for the database's others.
    const first = await leases[0]!
      .reader(fixture.projectDirectory)
      .overview(inputFor(fixture.projectDirectory))
    const second = await leases[43]!
      .reader(fixture.projectDirectory)
      .overview(inputFor(fixture.projectDirectory))
    expect(second.context.snapshotID).toBe(first.context.snapshotID)

    // Only one location prewarms a project, however many register.
    expect(leases.filter((lease) => lease.claimPrewarm(fixture.projectDirectory))).toHaveLength(1)

    // The remaining copies keep serving after most of them release.
    for (const lease of leases.slice(0, 43)) lease.release()
    expect(decisionWorkerSnapshot().length).toBe(before + 2)
    const still = await leases[43]!
      .reader(fixture.projectDirectory)
      .overview(inputFor(fixture.projectDirectory))
    expect(still.context.snapshotID).toBe(first.context.snapshotID)

    leases[43]!.release()
    otherLease.release()
    expect(decisionWorkerSnapshot().length).toBe(before)
  } finally {
    other.close()
    fixture.close()
  }
}, 60_000)

test("a decision read sends price inputs, not evidence, to the worker and reads no evidence body when nothing changed", async () => {
  clearParsedSnapshotCache()
  const fixture = makeLedgerFixture()
  seedCatalog(fixture.path, fixture.projectDirectory, 1_900)
  const sizes: number[] = []
  const lease = acquireDecisionWorker({
    path: fixture.path,
    readPriceInputs: async () => {
      const value = inputs()
      sizes.push(JSON.stringify(value).length)
      return value
    },
  })
  try {
    const reader = lease.reader(fixture.projectDirectory)
    const input = inputFor(fixture.projectDirectory)
    await reader.overview(input)
    await reader.overview(input)
    await reader.overview(input)

    // Before: every read structured-cloned the whole price state (catalog bodies, price index,
    // endpoint pricing) from the main thread to the worker.
    const priorPayload = JSON.stringify(
      readDecisionPriceState({
        path: fixture.path,
        projectDirectory: fixture.projectDirectory,
        inputs: inputs(),
        routes: [],
      }),
    ).length
    const sent = sizes.reduce((total, size) => total + size, 0)
    console.log(
      `price payload per read: before ${priorPayload} B, after ${Math.max(...sizes)} B (${sizes.length} requests, ${sent} B total)`,
    )
    expect(priorPayload).toBeGreaterThan(200_000)
    expect(Math.max(...sizes)).toBeLessThan(2_000)
    expect(sent).toBeLessThan(priorPayload / 50)
    // The first read builds (identity + state share one request); each later read is one
    // identity check.
    expect(sizes.length).toBe(3)
  } finally {
    lease.release()
    fixture.close()
  }
}, 60_000)

test("an unchanged snapshot is validated from row metadata without parsing any evidence", async () => {
  clearParsedSnapshotCache()
  const fixture = makeLedgerFixture()
  seedCatalog(fixture.path, fixture.projectDirectory, 1_900)
  const reader = createModelDecisionReader({
    projectDirectory: fixture.projectDirectory,
    openLedger: () => openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory),
    readPriceState: async (routes) =>
      readDecisionPriceState({
        path: fixture.path,
        projectDirectory: fixture.projectDirectory,
        inputs: inputs(),
        routes,
      }),
    readPriceIdentity: async () =>
      readPriceIdentity({
        path: fixture.path,
        projectDirectory: fixture.projectDirectory,
        inputs: inputs(),
      }),
  })
  const parse = JSON.parse
  let parsedBytes = 0
  JSON.parse = ((text: string, reviver?: never) => {
    parsedBytes += text.length
    return parse(text, reviver)
  }) as typeof JSON.parse
  try {
    const input = inputFor(fixture.projectDirectory)
    const first = await reader.overview(input)
    const built = parsedBytes
    parsedBytes = 0
    for (let read = 0; read < 10; read++) {
      const again = await reader.overview(input)
      expect(again.context.snapshotID).toBe(first.context.snapshotID)
    }
    console.log(`bytes parsed: first read ${built}, ten cached reads ${parsedBytes}`)
    expect(built).toBeGreaterThan(200_000)
    expect(parsedBytes).toBeLessThan(10_000)
  } finally {
    JSON.parse = parse
    reader.close()
    fixture.close()
  }
}, 60_000)
