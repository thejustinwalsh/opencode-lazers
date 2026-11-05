import { expect, test } from "bun:test"
import { inspectTrajectory } from "../trajectory/read.ts"
import { InspectTrajectoryInput } from "../trajectory/schema.ts"
import { makeFixture, cursorSecret, taskID } from "../../test/trajectory/fixture.ts"
import {
  exactRouteMatch,
  candidateFocusIndex,
  boundedModelLabel,
  modelDisplayName,
  readTaskEffortBasis,
  routeLabel,
  sourceState,
} from "./comparison-presentation.ts"
import type { ModelCandidate, ModelSource } from "./comparison-presentation.ts"

test("categorized effort parser reads the real versioned task basis and not legacy token scalars", async () => {
  const fixture = makeFixture()
  try {
    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      InspectTrajectoryInput.parse({ taskID }),
      cursorSecret,
    )
    const basis = readTaskEffortBasis(report)
    expect(basis?.schemaVersion).toBe(1)
    expect(basis?.attempts.count).toBe(2)
    expect(basis?.usage.coverage.totalUniqueSessions).toBe(2)
    expect(basis?.usage.categories.uncachedInput.unit).toBe("tokens")
    expect(basis?.routes.assignments).toHaveLength(2)
    expect(basis?.cost.fullTaskCostUSD).toMatchObject({ status: "unknown", valueUSD: null })
    expect(basis?.cost.marketEquivalentCostUSD).toMatchObject({ status: "unknown", valueUSD: null })
    expect(basis?.quality).toMatchObject({ status: "not-recorded", value: null })
  } finally {
    fixture.close()
  }
})

test("missing categorized projection remains unavailable even when legacy scalar tokens exist", () => {
  expect(
    readTaskEffortBasis({
      effort: { tokenUsage: { legacyTokenCount: 12_000 }, taskEffortBasis: null },
    }),
  ).toBeUndefined()
})

test("route identity comparison includes provider, model and exact variant", () => {
  const candidate = {
    identity: { providerID: "openai", modelID: "gpt-6", variant: "high" },
  } as ModelCandidate
  expect(
    exactRouteMatch({ providerID: "openai", modelID: "gpt-6", variant: "high" }, candidate),
  ).toBe(true)
  expect(
    exactRouteMatch({ providerID: "openai", modelID: "gpt-6", variant: null }, candidate),
  ).toBe(false)
  expect(routeLabel({ providerID: "openai", modelID: "gpt-6", variant: "high" })).toBe(
    "openai / gpt-6 · high",
  )
})

test("model names use exact provider/model metadata independent of effort and fallback without guessing", () => {
  const candidates = [
    {
      identity: { providerID: "openai", modelID: "gpt-6", variant: null },
      native: { name: "Cached GPT-6" },
    },
  ]
  const catalog = [
    { providerID: "openai", id: "gpt-6-mini", name: "GPT-6 Mini" },
    { providerID: "openai", id: "gpt-6", name: "GPT-6 from native catalog" },
  ]

  expect(
    modelDisplayName(
      { providerID: "openai", modelID: "gpt-6", variant: "effort-not-in-catalog" },
      candidates,
      catalog,
    ),
  ).toBe("GPT-6 from native catalog")
  expect(
    modelDisplayName(
      { providerID: "anthropic", modelID: "gpt-6", variant: null },
      candidates,
      catalog,
    ),
  ).toBe("gpt-6")
  expect(
    modelDisplayName({ providerID: "openai", modelID: "gpt-6", variant: "low" }, candidates, []),
  ).toBe("Cached GPT-6")
  expect(boundedModelLabel("a-model-id-that-is-far-too-long-to-display-in-one-row", 18)).toBe(
    "a-model-id-that-i…",
  )
})

test("candidate keyboard focus is bounded and does not intercept unrelated keys", () => {
  expect(candidateFocusIndex(0, 3, "ArrowUp")).toBe(0)
  expect(candidateFocusIndex(0, 3, "ArrowDown")).toBe(1)
  expect(candidateFocusIndex(1, 3, "Home")).toBe(0)
  expect(candidateFocusIndex(1, 3, "End")).toBe(2)
  expect(candidateFocusIndex(1, 3, "Enter")).toBeUndefined()
  expect(candidateFocusIndex(0, 0, "ArrowDown")).toBeUndefined()
})

test("source presentation distinguishes no-cache failure from missing refresh history and dated cache", () => {
  const failed = {
    source: "native-catalog",
    storage: "ready",
    snapshotState: "none",
    selectedSnapshotID: null,
    refresh: { state: "failed" },
    snapshot: null,
  } as ModelSource
  expect(sourceState(failed)).toContain("latest refresh failed")

  const missingHistory = {
    ...failed,
    storage: "missing-refresh-table",
    refresh: null,
  } as ModelSource
  expect(sourceState(missingHistory)).toContain("refresh history unavailable")

  const cached = {
    ...failed,
    snapshotState: "available",
    snapshot: { recordCount: 3, retrievedAt: "2026-11-03T00:00:00.000Z" },
  } as ModelSource
  expect(sourceState(cached)).toContain("3 records · retrieved")
})
