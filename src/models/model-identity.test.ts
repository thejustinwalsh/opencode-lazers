import { expect, test } from "bun:test"
import captured from "../../test/models-identity/fixtures/captured-20261103.json" with { type: "json" }
import { ModelEvidenceSnapshotSchema, type ModelEvidenceSnapshot } from "./source-schema.ts"
import type { ModelEvidenceComparisonSourceRead } from "./source-store.ts"
import { modelIdentityReference, resolveModelIdentity } from "./model-identity.ts"

const nativeParsed = ModelEvidenceSnapshotSchema.parse(captured.native.snapshot)
const catalogParsed = ModelEvidenceSnapshotSchema.parse(captured.openrouter.snapshot)

if (nativeParsed.source !== "native-catalog" || catalogParsed.source !== "openrouter-models")
  throw new Error("Captured model identity fixture has an unexpected source")

const nativeSnapshot = nativeParsed as Extract<ModelEvidenceSnapshot, { source: "native-catalog" }>
const catalogSnapshot = catalogParsed as Extract<
  ModelEvidenceSnapshot,
  { source: "openrouter-models" }
>

function sourceRead(
  snapshot: ModelEvidenceSnapshot | null,
  snapshotState: ModelEvidenceComparisonSourceRead["snapshotState"] = snapshot
    ? "available"
    : "none",
): ModelEvidenceComparisonSourceRead {
  return {
    source: "openrouter-models",
    storage: "ready",
    snapshotState,
    snapshotID: snapshot?.snapshotID ?? null,
    refresh: null,
    snapshot,
  }
}

function resolveCaptured(index: number, catalog = sourceRead(catalogSnapshot)) {
  const record = nativeSnapshot.records[index]!
  return resolveModelIdentity({
    route: { providerID: record.providerID, modelID: record.id },
    nativeEvidence: [
      modelIdentityReference(
        "native-catalog",
        nativeSnapshot,
        captured.native.originalRecordIndices[index]!,
        record.id,
      ),
    ],
    catalogSource: catalog,
  })
}

test("captured direct and OpenRouter routes resolve to the same source-backed products", () => {
  const expected = [
    [0, "anthropic/claude-haiku-5.5"],
    [1, "anthropic/claude-sonnet-5.5"],
    [2, "openai/gpt-6-luna"],
    [3, "openai/gpt-6-luna"],
    [4, "anthropic/claude-fable-5"],
    [5, "anthropic/claude-fable-5"],
  ] as const
  for (const [index, productID] of expected) {
    const { resolution } = resolveCaptured(index)
    expect(resolution).toMatchObject({
      status: "exact",
      productID,
      catalogSourceState: "available",
      rules: [{ version: 1 }],
      evidence: {
        native: [
          expect.objectContaining({
            source: "native-catalog",
            snapshotID: nativeSnapshot.snapshotID,
            recordIndex: captured.native.originalRecordIndices[index],
            recordID: nativeSnapshot.records[index]!.id,
          }),
        ],
        catalog: [
          expect.objectContaining({
            source: "openrouter-models",
            snapshotID: catalogSnapshot.snapshotID,
            recordID: productID,
          }),
        ],
      },
    })
  }
  expect(resolveCaptured(2).resolution.productID).toBe(resolveCaptured(3).resolution.productID)
  expect(resolveCaptured(4).resolution.productID).toBe(resolveCaptured(5).resolution.productID)
  expect(resolveCaptured(3).resolution.rules[0]?.id).toBe("provider-owner-qualified-local-id-v1")
  expect(resolveCaptured(5).resolution.rules[0]?.id).toBe("provider-owner-qualified-local-id-v1")
})

test("identity distinguishes ambiguous, unsupported, absent, and unavailable evidence", () => {
  const duplicateCatalog = ModelEvidenceSnapshotSchema.parse({
    ...catalogSnapshot,
    records: [...catalogSnapshot.records, catalogSnapshot.records[2]!],
  })
  const ambiguous = resolveCaptured(3, sourceRead(duplicateCatalog))
  expect(ambiguous.resolution).toMatchObject({
    status: "ambiguous",
    productID: "openai/gpt-6-luna",
    evidence: { catalogRecordCount: 2 },
  })
  expect(ambiguous.catalogMatches).toHaveLength(2)

  const absentCatalog = ModelEvidenceSnapshotSchema.parse({
    ...catalogSnapshot,
    records: catalogSnapshot.records.filter((record) => record.id !== "openai/gpt-6-luna"),
  })
  expect(resolveCaptured(3, sourceRead(absentCatalog)).resolution).toMatchObject({
    status: "supported-but-absent",
    productID: "openai/gpt-6-luna",
    evidence: { catalogRecordCount: 0 },
  })
  expect(resolveCaptured(3, sourceRead(null, "missing-table")).resolution).toMatchObject({
    status: "source-unavailable",
    productID: "openai/gpt-6-luna",
    catalogSourceState: "missing-table",
  })

  const unsupported = resolveModelIdentity({
    route: { providerID: "unrelated-provider", modelID: "gpt-6-luna" },
    nativeEvidence: [],
    catalogSource: sourceRead(catalogSnapshot),
  })
  expect(unsupported.resolution).toMatchObject({
    status: "unsupported",
    productID: null,
    rules: [],
    evidence: { catalogRecordCount: 0 },
  })
  const unknownWithoutSource = resolveModelIdentity({
    route: { providerID: "unrelated-provider", modelID: "unpublished-local-id" },
    nativeEvidence: [],
    catalogSource: sourceRead(null, "missing-snapshot"),
  })
  expect(unknownWithoutSource.resolution).toMatchObject({
    status: "source-unavailable",
    productID: null,
    catalogSourceState: "missing-snapshot",
  })

  for (const modelID of ["claude-haiku-5.5", "claude-sonnet-5.5"]) {
    const ownerLocal = resolveModelIdentity({
      route: { providerID: "anthropic", modelID },
      nativeEvidence: [],
      catalogSource: sourceRead(catalogSnapshot),
    })
    expect(ownerLocal.resolution).toMatchObject({
      status: "exact",
      productID: `anthropic/${modelID}`,
      rules: [{ id: "provider-owner-qualified-local-id-v1", version: 1 }],
    })
  }

  const unrelatedProvider = resolveModelIdentity({
    route: { providerID: "some-gateway", modelID: "anthropic/claude-haiku-5.5" },
    nativeEvidence: [],
    catalogSource: sourceRead(catalogSnapshot),
  })
  expect(unrelatedProvider.resolution).toMatchObject({
    status: "exact",
    productID: "anthropic/claude-haiku-5.5",
    rules: [{ id: "owner-qualified-catalog-id-v1", version: 1 }],
  })
})

test("aliases require exact route rules and exact catalog IDs, never names or slug suffixes", () => {
  const changedID = ModelEvidenceSnapshotSchema.parse({
    ...catalogSnapshot,
    records: catalogSnapshot.records.map((record) =>
      record.id === "anthropic/claude-fable-5"
        ? { ...record, id: "anthropic/claude-fable-5-preview" }
        : record,
    ),
  })
  expect(resolveCaptured(5, sourceRead(changedID)).resolution).toMatchObject({
    status: "supported-but-absent",
    productID: "anthropic/claude-fable-5",
    evidence: { catalogRecordCount: 0 },
  })

  const fuzzyRoute = resolveModelIdentity({
    route: { providerID: "anthropic", modelID: "Claude Fable 5" },
    nativeEvidence: [],
    catalogSource: sourceRead(catalogSnapshot),
  })
  expect(fuzzyRoute.resolution).toMatchObject({
    status: "supported-but-absent",
    productID: "anthropic/Claude Fable 5",
  })
  const suffixRoute = resolveModelIdentity({
    route: { providerID: "anthropic", modelID: "claude-fable-5-preview" },
    nativeEvidence: [],
    catalogSource: sourceRead(catalogSnapshot),
  })
  expect(suffixRoute.resolution).toMatchObject({
    status: "supported-but-absent",
    productID: "anthropic/claude-fable-5-preview",
  })
  expect(suffixRoute.resolution.productID).not.toBe("anthropic/claude-fable-5")
})

test("route-alias citations bind catalog provenance to the selected snapshot", () => {
  const projectDirectory = `/portable-project/${crypto.randomUUID()}`
  const selectedCatalog = ModelEvidenceSnapshotSchema.parse({
    ...catalogSnapshot,
    snapshotID: crypto.randomUUID(),
    projectDirectory,
    generation: 7,
    retrievedAt: "2026-11-03T22:00:00.000Z",
  }) as Extract<ModelEvidenceSnapshot, { source: "openrouter-models" }>

  for (const [modelID, productID] of [
    ["claude-haiku-5-5", "anthropic/claude-haiku-5.5"],
    ["claude-sonnet-5-5", "anthropic/claude-sonnet-5.5"],
  ] as const) {
    const { resolution } = resolveModelIdentity({
      route: { providerID: "anthropic", modelID },
      nativeEvidence: [],
      catalogSource: sourceRead(selectedCatalog),
    })
    const citations = resolution.rules[0]?.citations ?? []
    expect(resolution).toMatchObject({ status: "exact", productID })
    expect(citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://platform.claude.com/docs/en/models/overview",
          snapshotID: null,
          retrievedAt: null,
          recordID: null,
        }),
        expect.objectContaining({
          url: "https://openrouter.ai/api/v1/models",
          snapshotID: selectedCatalog.snapshotID,
          retrievedAt: selectedCatalog.retrievedAt,
          retrievedOn: "2026-11-03",
          recordID: productID,
        }),
      ]),
    )
    expect(
      citations.every(
        (citation) =>
          citation.snapshotID === null || citation.snapshotID === selectedCatalog.snapshotID,
      ),
    ).toBe(true)
    expect(citations.some((citation) => citation.snapshotID === catalogSnapshot.snapshotID)).toBe(
      false,
    )
  }

  const unavailable = resolveModelIdentity({
    route: { providerID: "anthropic", modelID: "claude-haiku-5-5" },
    nativeEvidence: [],
    catalogSource: sourceRead(null, "missing-snapshot"),
  })
  expect(unavailable.resolution).toMatchObject({ status: "source-unavailable" })
  expect(unavailable.resolution.rules[0]?.citations).toEqual([
    expect.objectContaining({
      url: "https://platform.claude.com/docs/en/models/overview",
      snapshotID: null,
      retrievedAt: null,
      recordID: null,
    }),
  ])
})
