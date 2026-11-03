import { expect, test } from "bun:test"
import captured from "../../test/models-identity/fixtures/captured-20261103.json" with { type: "json" }
import capturedAnthropicAliases from "../../test/models-identity/fixtures/captured-anthropic-aliases-20261103.json" with { type: "json" }
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelEvidenceSnapshotSchema, type ModelEvidenceSnapshot } from "./source-schema.ts"
import { ModelEvidenceReadStore, ModelEvidenceStore } from "./source-store.ts"
import { readModelConfigurations, readModelGroups } from "./model-group-read.ts"
import { readModelComparison } from "./comparison-read.ts"

const nativeFixture = ModelEvidenceSnapshotSchema.parse(captured.native.snapshot)
const catalogFixture = ModelEvidenceSnapshotSchema.parse(captured.openrouter.snapshot)

if (nativeFixture.source !== "native-catalog" || catalogFixture.source !== "openrouter-models")
  throw new Error("Captured model group fixture has an unexpected source")

const nativeSnapshot = nativeFixture
const catalogSnapshot = catalogFixture
const capturedProject = captured.projectDirectory

function directory() {
  return mkdtempSync(join(tmpdir(), "lazers-model-groups-"))
}

function advanceToGenerationFive(store: ModelEvidenceStore) {
  for (let index = 0; index < 5; index += 1) store.beginRefresh()
}

function saveSnapshots(
  writer: ModelEvidenceStore,
  options: {
    native?: Extract<ModelEvidenceSnapshot, { source: "native-catalog" }>
    catalog?: Extract<ModelEvidenceSnapshot, { source: "openrouter-models" }>
  } = {},
) {
  const generation = writer.beginRefresh()
  if (options.native)
    writer.saveSnapshot({ ...options.native, generation: generation["native-catalog"] })
  if (options.catalog)
    writer.saveSnapshot({ ...options.catalog, generation: generation["openrouter-models"] })
  return generation
}

function createStores(
  projectDirectory = capturedProject,
  options: {
    native?: Extract<ModelEvidenceSnapshot, { source: "native-catalog" }>
    catalog?: Extract<ModelEvidenceSnapshot, { source: "openrouter-models" }>
    nativeRecordIndexes?: number[]
    catalogRecordIndexes?: number[]
    generationFive?: boolean
  } = {},
) {
  const root = directory()
  const path = join(root, "tasks.sqlite")
  const writer = new ModelEvidenceStore(path, projectDirectory)
  if (options.generationFive) {
    advanceToGenerationFive(writer)
    if (options.native) writer.saveSnapshot({ ...options.native, projectDirectory, generation: 5 })
    if (options.catalog)
      writer.saveSnapshot({ ...options.catalog, projectDirectory, generation: 5 })
  } else {
    saveSnapshots(writer, {
      ...(options.native ? { native: { ...options.native, projectDirectory } } : {}),
      ...(options.catalog ? { catalog: { ...options.catalog, projectDirectory } } : {}),
    })
  }
  const reader = new ModelEvidenceReadStore(path, projectDirectory)
  const indexMaps = new Map<string, number[]>([
    ...(options.native && options.nativeRecordIndexes
      ? [[options.native.snapshotID, options.nativeRecordIndexes] as const]
      : []),
    ...(options.catalog && options.catalogRecordIndexes
      ? [[options.catalog.snapshotID, options.catalogRecordIndexes] as const]
      : []),
  ])
  const store = {
    projectDirectory,
    readComparisonSources(
      selection?: Parameters<ModelEvidenceReadStore["readComparisonSources"]>[0],
    ) {
      return reader.readComparisonSources(selection).map((source) => {
        const recordIndexes = source.snapshotID ? indexMaps.get(source.snapshotID) : undefined
        return recordIndexes ? { ...source, recordIndexes } : source
      })
    },
    close: () => reader.close(),
  }
  return { root, path, writer, reader: store }
}

function newNativeSnapshot(
  records: Extract<ModelEvidenceSnapshot, { source: "native-catalog" }>["records"],
  projectDirectory = capturedProject,
): Extract<ModelEvidenceSnapshot, { source: "native-catalog" }> {
  return ModelEvidenceSnapshotSchema.parse({
    ...nativeSnapshot,
    snapshotID: crypto.randomUUID(),
    projectDirectory,
    generation: 1,
    retrievedAt: "2026-11-03T20:00:00.000Z",
    records,
  }) as Extract<ModelEvidenceSnapshot, { source: "native-catalog" }>
}

function nativeRow(index: number) {
  return nativeSnapshot.records[index]!
}

test("the six captured native rows form four source-backed product groups and 33 exact configurations", () => {
  const stores = createStores(capturedProject, {
    native: nativeSnapshot,
    catalog: catalogSnapshot,
    nativeRecordIndexes: captured.native.originalRecordIndices,
    catalogRecordIndexes: captured.openrouter.originalRecordIndices,
    generationFive: true,
  })
  try {
    const groups = readModelGroups(stores.reader, { limit: 100 })
    expect(groups).toMatchObject({ schemaVersion: 1, totalGroups: 4, nextCursor: null })
    expect(
      groups.groups.map(({ groupID, configurationCount }) => [groupID, configurationCount]),
    ).toEqual([
      ["anthropic/claude-fable-5", 10],
      ["anthropic/claude-haiku-5.5", 6],
      ["anthropic/claude-sonnet-5.5", 5],
      ["openai/gpt-6-luna", 12],
    ])
    expect(groups.groups.reduce((count, group) => count + group.configurationCount, 0)).toBe(33)
    expect(groups.groups.every((group) => group.identityStatus === "exact")).toBe(true)

    const configurations = readModelConfigurations(stores.reader, {
      groupID: "openai/gpt-6-luna",
      context: groups.context,
      limit: 100,
    })
    expect(configurations.totalConfigurations).toBe(12)
    expect(
      new Set(configurations.configurations.map(({ configurationID }) => configurationID)).size,
    ).toBe(12)
    const direct = configurations.configurations.find(
      ({ route }) => route.providerID === "openai" && route.variant === "none",
    )!
    const routed = configurations.configurations.find(
      ({ route }) => route.providerID === "openrouter" && route.variant === "none",
    )!
    expect(direct.configurationID).not.toBe(routed.configurationID)
    const legacy = readModelComparison(stores.reader, { limit: 100 }).candidates.find(
      ({ identity }) =>
        identity.providerID === "openai" &&
        identity.modelID === "gpt-6-luna" &&
        identity.variant === "none",
    )!
    expect(direct.candidateID).toBe(legacy.candidateID)
    expect(direct.configurationID).toBe(direct.candidateID)
    expect(direct).toMatchObject({
      native: { availableVariants: ["high", "low", "max", "medium", "none", "xhigh"] },
      benchmarkCorrespondence: { status: "unresolved", basis: null },
      effortApplicability: { status: "unknown" },
    })
    expect(direct).toMatchObject({
      groupID: "openai/gpt-6-luna",
      route: { providerID: "openai", modelID: "gpt-6-luna", variant: "none" },
      identity: {
        status: "exact",
        productID: "openai/gpt-6-luna",
        rules: [{ id: "provider-owner-qualified-local-id-v1", version: 1 }],
      },
      native: {
        source: "native-catalog",
        contextTokens: 400000,
        prices: null,
        evidence: {
          records: [
            expect.objectContaining({
              source: "native-catalog",
              snapshotID: nativeSnapshot.snapshotID,
              recordIndex: 67,
              recordID: "gpt-6-luna",
            }),
          ],
        },
      },
      externalCatalog: {
        source: "openrouter-models",
        model: {
          id: "openai/gpt-6-luna",
          contextLength: 1050000,
          prices: { unit: "USD per token" },
        },
        evidence: {
          records: [
            expect.objectContaining({
              source: "openrouter-models",
              snapshotID: catalogSnapshot.snapshotID,
              recordIndex: 51,
              recordID: "openai/gpt-6-luna",
            }),
          ],
        },
      },
    })
    expect(routed.native).toMatchObject({
      contextTokens: 1050000,
      prices: { unit: "USD per million tokens" },
    })
    expect(routed.externalCatalog.model?.prices?.unit).toBe("USD per token")
    expect(direct).not.toHaveProperty("benchmark")
    expect(direct).not.toHaveProperty("acceptance")
    expect(groups.sources[0]?.snapshot).toMatchObject({ snapshotID: nativeSnapshot.snapshotID })
  } finally {
    stores.reader.close()
    stores.writer.close()
    rmSync(stores.root, { recursive: true, force: true })
  }
})

test("generic owner and owner-qualified matching groups extra routes without model-specific rules", () => {
  const anthropicHaiku = {
    ...nativeRow(0),
    providerID: "anthropic",
    id: "claude-haiku-5.5",
    variants: ["high"],
  }
  const anthropicSonnet = {
    ...nativeRow(1),
    providerID: "anthropic",
    id: "claude-sonnet-5.5",
    variants: ["medium"],
  }
  const otherProvider = {
    ...nativeRow(0),
    providerID: "some-gateway",
    id: "anthropic/claude-haiku-5.5",
    variants: ["max"],
  }
  const extraNative = newNativeSnapshot([
    ...nativeSnapshot.records,
    anthropicHaiku,
    anthropicSonnet,
    otherProvider,
  ])
  const stores = createStores(capturedProject, {
    native: extraNative,
    catalog: catalogSnapshot,
    nativeRecordIndexes: [...captured.native.originalRecordIndices, 471, 472, 473],
    catalogRecordIndexes: captured.openrouter.originalRecordIndices,
  })
  try {
    const groups = readModelGroups(stores.reader, { limit: 100 })
    expect(groups.totalGroups).toBe(4)
    const haiku = readModelConfigurations(stores.reader, {
      groupID: "anthropic/claude-haiku-5.5",
      context: groups.context,
      limit: 100,
    })
    expect(haiku.totalConfigurations).toBe(8)
    expect(
      haiku.configurations
        .filter(({ route }) => route.providerID !== "openrouter")
        .map(({ route, identity }) => [
          route.providerID,
          route.modelID,
          identity.status,
          identity.rules[0]?.id,
        ])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    ).toEqual([
      ["anthropic", "claude-haiku-5.5", "exact", "provider-owner-qualified-local-id-v1"],
      ["some-gateway", "anthropic/claude-haiku-5.5", "exact", "owner-qualified-catalog-id-v1"],
    ])
    const sonnet = readModelConfigurations(stores.reader, {
      groupID: "anthropic/claude-sonnet-5.5",
      context: groups.context,
      limit: 100,
    })
    expect(
      sonnet.configurations.some((configuration) =>
        configuration.identity.rules.some(
          (rule) => rule.id === "provider-owner-qualified-local-id-v1",
        ),
      ),
    ).toBe(true)
  } finally {
    stores.reader.close()
    stores.writer.close()
    rmSync(stores.root, { recursive: true, force: true })
  }
})

test("adversarial shared-slug IDs remain distinct products and unsupported routes remain route-local", () => {
  const exactIDs = [
    "vendor/model",
    "vendor/model:fast",
    "vendor/model:batch",
    "vendor/model-20261002",
  ]
  const catalog = ModelEvidenceSnapshotSchema.parse({
    ...catalogSnapshot,
    snapshotID: crypto.randomUUID(),
    generation: 1,
    records: exactIDs.map((id) => ({
      ...catalogSnapshot.records[0]!,
      id,
      canonicalSlug: "vendor/shared-product-slug",
    })),
  })
  if (catalog.source !== "openrouter-models") throw new Error("Expected OpenRouter products")
  const routes = exactIDs.map((id) => ({
    ...nativeRow(0),
    providerID: "openrouter",
    id,
    variants: ["high"],
  }))
  const unsupported = ["gateway-a", "gateway-b"].map((providerID) => ({
    ...nativeRow(0),
    providerID,
    id: "unmapped-local-id",
    variants: ["low"],
  }))
  const native = newNativeSnapshot([...routes, ...unsupported])
  const stores = createStores(capturedProject, {
    native,
    catalog,
    nativeRecordIndexes: [0, 1, 2, 3, 4, 5],
    catalogRecordIndexes: [0, 1, 2, 3],
  })
  try {
    const groups = readModelGroups(stores.reader, { limit: 100 })
    const exactGroups = groups.groups.filter((group) => group.productID !== null)
    expect(
      exactGroups.map(({ groupID, productID, identityStatus }) => [
        groupID,
        productID,
        identityStatus,
      ]),
    ).toEqual([...exactIDs].sort().map((id) => [id, id, "exact"]))
    expect(new Set(exactGroups.map(({ groupID }) => groupID)).size).toBe(4)
    expect(
      exactGroups.map(
        ({ groupID }) =>
          readModelConfigurations(stores.reader, {
            groupID,
            context: groups.context,
            limit: 100,
          }).configurations[0]?.externalCatalog.model?.canonicalSlug,
      ),
    ).toEqual(Array(4).fill("vendor/shared-product-slug"))

    const unsupportedGroups = groups.groups.filter(
      (group) => group.identityStatus === "unsupported",
    )
    expect(unsupportedGroups).toHaveLength(2)
    expect(new Set(unsupportedGroups.map(({ groupID }) => groupID)).size).toBe(2)
    expect(unsupportedGroups.map(({ groupID }) => groupID).sort()).toEqual([
      "route:9:gateway-a:17:unmapped-local-id",
      "route:9:gateway-b:17:unmapped-local-id",
    ])
  } finally {
    stores.reader.close()
    stores.writer.close()
    rmSync(stores.root, { recursive: true, force: true })
  }
})

test("captured direct Anthropic Haiku and Sonnet punctuation aliases retain cited rule provenance", () => {
  const aliases = ModelEvidenceSnapshotSchema.parse(capturedAnthropicAliases.native.snapshot)
  if (aliases.source !== "native-catalog") throw new Error("Expected Anthropic native alias rows")
  const catalog = ModelEvidenceSnapshotSchema.parse({
    ...catalogSnapshot,
    records: catalogSnapshot.records.filter((record) =>
      ["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"].includes(record.id),
    ),
  })
  if (catalog.source !== "openrouter-models") throw new Error("Expected OpenRouter alias products")
  const stores = createStores(capturedProject, {
    native: aliases,
    catalog,
    nativeRecordIndexes: capturedAnthropicAliases.native.originalRecordIndices,
    catalogRecordIndexes: [30, 39],
  })
  try {
    const groups = readModelGroups(stores.reader, { limit: 100 })
    expect(groups.totalGroups).toBe(2)
    expect(
      groups.groups.map(({ groupID, configurationCount }) => [groupID, configurationCount]),
    ).toEqual([
      ["anthropic/claude-haiku-5.5", 6],
      ["anthropic/claude-sonnet-5.5", 5],
    ])

    for (const [groupID, nativeID, catalogID, nativeRecordIndex, catalogRecordIndex] of [
      ["anthropic/claude-haiku-5.5", "claude-haiku-5-5", "anthropic/claude-haiku-5.5", 38, 30],
      ["anthropic/claude-sonnet-5.5", "claude-sonnet-5-5", "anthropic/claude-sonnet-5.5", 50, 39],
    ] as const) {
      const page = readModelConfigurations(stores.reader, {
        groupID,
        context: groups.context,
        limit: 100,
      })
      expect(page.totalConfigurations).toBe(groupID.includes("haiku") ? 6 : 5)
      expect(
        page.configurations.every((configuration) => configuration.identity.status === "exact"),
      ).toBe(true)
      const configuration = page.configurations.find(({ route }) => route.variant === "high")!
      expect(configuration).toMatchObject({
        groupID,
        candidateID: configuration.configurationID,
        route: { providerID: "anthropic", modelID: nativeID, variant: "high" },
        identity: {
          status: "exact",
          productID: groupID,
          rules: [
            {
              id: `anthropic-${groupID.includes("haiku") ? "haiku" : "sonnet"}-5-5-to-openrouter-${groupID.includes("haiku") ? "haiku" : "sonnet"}-5-5-v1`,
              version: 1,
              citations: expect.arrayContaining([
                expect.objectContaining({
                  url: "https://platform.claude.com/docs/en/models/overview",
                  excerpt: expect.stringContaining(nativeID),
                }),
                expect.objectContaining({
                  url: "https://openrouter.ai/api/v1/models",
                  snapshotID: catalogSnapshot.snapshotID,
                  retrievedAt: "2026-11-03T19:44:37.529Z",
                  recordID: catalogID,
                }),
              ]),
            },
          ],
          evidence: {
            native: [
              expect.objectContaining({ recordIndex: nativeRecordIndex, recordID: nativeID }),
            ],
            catalog: [
              expect.objectContaining({ recordIndex: catalogRecordIndex, recordID: catalogID }),
            ],
          },
        },
      })
    }
  } finally {
    stores.reader.close()
    stores.writer.close()
    rmSync(stores.root, { recursive: true, force: true })
  }
})

test("group and independent configuration pages stay complete across duplicates and refreshes", () => {
  const manyVariants = Array.from({ length: 100 }, (_, index) => `effort-${index}`)
  const manyRouteA = {
    ...nativeRow(0),
    providerID: "openrouter",
    id: "anthropic/many-efforts",
    variants: manyVariants,
  }
  const manyRouteB = {
    ...nativeRow(0),
    providerID: "openrouter",
    id: "anthropic/many-efforts",
    variants: ["effort-99", "effort-100"],
  }
  const groups = Array.from({ length: 105 }, (_, index) => ({
    ...nativeRow(0),
    providerID: "openrouter",
    id: `anthropic/page-model-${String(index).padStart(3, "0")}`,
    variants: ["high"],
  }))
  const native = newNativeSnapshot([...groups, manyRouteA, manyRouteB])
  const stores = createStores(capturedProject, { native, catalog: catalogSnapshot })
  try {
    const firstGroups = readModelGroups(stores.reader, { limit: 100 })
    expect(firstGroups.totalGroups).toBe(110)
    expect(firstGroups.groups).toHaveLength(100)
    expect(firstGroups.nextCursor).not.toBeNull()

    const nextGeneration = stores.writer.beginRefresh()
    stores.writer.saveSnapshot({
      ...native,
      snapshotID: crypto.randomUUID(),
      generation: nextGeneration["native-catalog"],
      retrievedAt: "2026-11-03T20:01:00.000Z",
      records: [nativeRow(0)],
    })

    const manyGroupID = "anthropic/many-efforts"
    const firstConfigPage = readModelConfigurations(stores.reader, {
      groupID: manyGroupID,
      context: firstGroups.context,
      limit: 100,
    })
    expect(firstConfigPage.totalConfigurations).toBe(101)
    expect(firstConfigPage.configurations).toHaveLength(100)
    expect(firstConfigPage.nextCursor).not.toBeNull()
    expect(firstConfigPage.configurations[0]?.native.variantCoverage).toEqual({
      status: "truncated",
      totalVariants: 101,
      omittedVariants: 1,
    })
    expect(firstConfigPage.sources[0]?.selectedSnapshotID).toBe(
      firstGroups.context.snapshots["native-catalog"],
    )

    const secondGroups = readModelGroups(stores.reader, {
      cursor: firstGroups.nextCursor!,
      limit: 100,
    })
    expect(secondGroups.groups).toHaveLength(10)
    expect(secondGroups.totalGroups).toBe(110)
    const secondConfigs = readModelConfigurations(stores.reader, {
      groupID: manyGroupID,
      context: firstGroups.context,
      cursor: firstConfigPage.nextCursor!,
      limit: 100,
    })
    expect(secondConfigs.configurations).toHaveLength(1)
    expect(secondConfigs.configurations[0]?.route.variant).toBe("effort-99")
    expect(secondConfigs.configurations[0]?.native.evidence).toMatchObject({
      recordCount: 2,
      truncated: false,
    })
    const allConfigIDs = [...firstConfigPage.configurations, ...secondConfigs.configurations].map(
      ({ configurationID }) => configurationID,
    )
    expect(new Set(allConfigIDs).size).toBe(101)

    expect(() =>
      readModelGroups(stores.reader, {
        cursor: firstGroups.nextCursor!,
        filters: { search: "changed" },
        limit: 100,
      }),
    ).toThrow("Model group cursor filters do not match")

    const cursorPayload = JSON.parse(
      Buffer.from(firstGroups.nextCursor!, "base64url").toString("utf8"),
    ) as { scope: string; snapshots: Record<string, string | null>; ruleVersion: number }
    const foreignScope = Buffer.from(
      JSON.stringify({ ...cursorPayload, scope: "/other-project" }),
    ).toString("base64url")
    expect(() => readModelGroups(stores.reader, { cursor: foreignScope, limit: 100 })).toThrow(
      "Model group cursor scope does not match",
    )
    const swapped = Buffer.from(
      JSON.stringify({
        ...cursorPayload,
        snapshots: {
          ...cursorPayload.snapshots,
          "native-catalog": cursorPayload.snapshots["openrouter-models"],
        },
      }),
    ).toString("base64url")
    expect(() => readModelGroups(stores.reader, { cursor: swapped, limit: 100 })).toThrow(
      "Model evidence snapshot source does not match its selection",
    )
    expect(cursorPayload.ruleVersion).toBe(1)
    const secondGroupID = firstGroups.groups.find(({ groupID }) => groupID !== manyGroupID)!.groupID
    expect(() =>
      readModelConfigurations(stores.reader, {
        groupID: secondGroupID,
        context: firstGroups.context,
        cursor: firstConfigPage.nextCursor!,
        limit: 100,
      }),
    ).toThrow("Model group cursor group does not match")
    expect(() =>
      readModelConfigurations(stores.reader, {
        groupID: manyGroupID,
        context: { ...firstGroups.context, scope: "/other-project" },
        cursor: firstConfigPage.nextCursor!,
        limit: 100,
      }),
    ).toThrow("Model group context scope does not match")
    expect(() =>
      readModelConfigurations(stores.reader, {
        groupID: manyGroupID,
        context: {
          ...firstGroups.context,
          snapshots: {
            ...firstGroups.context.snapshots,
            "native-catalog": crypto.randomUUID(),
          },
        },
        limit: 100,
      }),
    ).toThrow("Model group context source pin is unavailable")
    expect(() =>
      readModelConfigurations(stores.reader, {
        groupID: manyGroupID,
        context: firstGroups.context,
        cursor: firstConfigPage.nextCursor!,
        filters: { search: "changed" },
        limit: 100,
      }),
    ).toThrow("Model group cursor filters do not match")
  } finally {
    stores.reader.close()
    stores.writer.close()
    rmSync(stores.root, { recursive: true, force: true })
  }
})

test("unreported effort remains null and metadata-only catalog products create no execution routes", () => {
  const noVariantRoute = {
    ...nativeRow(0),
    providerID: "anthropic",
    id: "unreported-effort-model",
    variants: null,
  }
  const native = newNativeSnapshot([noVariantRoute])
  const onlyCatalog = ModelEvidenceSnapshotSchema.parse({
    ...catalogSnapshot,
    snapshotID: crypto.randomUUID(),
    generation: 1,
    records: [catalogSnapshot.records[0]!],
  }) as Extract<ModelEvidenceSnapshot, { source: "openrouter-models" }>
  const stores = createStores(capturedProject, {
    native,
    catalog: onlyCatalog,
    catalogRecordIndexes: [30],
  })
  try {
    const groups = readModelGroups(stores.reader, { limit: 100 })
    expect(groups.totalGroups).toBe(2)
    const metadataOnly = groups.groups.find(
      (group) => group.groupID === "anthropic/claude-haiku-5.5",
    )!
    expect(metadataOnly).toMatchObject({
      identityStatus: "metadata-only",
      configurationCount: 0,
      catalogRecordCount: 1,
      nativeRecordCount: 0,
    })
    expect(
      readModelConfigurations(stores.reader, {
        groupID: metadataOnly.groupID,
        context: groups.context,
        limit: 100,
      }).configurations,
    ).toEqual([])
    const unreported = readModelConfigurations(stores.reader, {
      groupID: "anthropic/unreported-effort-model",
      context: groups.context,
      limit: 100,
    })
    expect(unreported.configurations).toHaveLength(1)
    expect(unreported.configurations[0]?.route.variant).toBeNull()
  } finally {
    stores.reader.close()
    stores.writer.close()
    rmSync(stores.root, { recursive: true, force: true })
  }
})
