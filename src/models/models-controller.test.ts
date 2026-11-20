import { afterAll, beforeEach, expect, test } from "bun:test"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { ModelComparisonPanelState } from "./comparison-state.ts"
import type { ModelComparisonPanelData } from "./comparison-state.ts"
import type { ModelDecisionFilters } from "./decision-contract.ts"

const vite = await createServer({
  configFile: false,
  plugins: [solid()],
  server: { middlewareMode: true, ws: false },
  appType: "custom",
})
afterAll(() => vite.close())
const {
  modelsSnapshotBudget,
  modelsSnapshotKey,
  recallModelsSnapshot,
  rememberModelsSnapshot,
  resetModelsSnapshots,
} = (await vite.ssrLoadModule(
  "/src/models/models-controller.ts",
)) as typeof import("./models-controller.ts")

const filters = (persona: ModelDecisionFilters["persona"] = null): ModelDecisionFilters => ({
  persona,
  taskKind: null,
  period: { from: null, to: null },
})

/** A panel snapshot that has something to show. */
function snapshot(key: string, decisionFilters = filters()): ModelComparisonPanelData {
  return {
    ...new ModelComparisonPanelState(() => {}).data,
    key,
    decisionFilters,
    decisionStatus: "ready",
    decisionOverview: {} as never,
  }
}

beforeEach(() => resetModelsSnapshots())

test("the last comparison is kept per project and filter key", () => {
  const all = snapshot("project-a")
  const ui = snapshot("project-a", filters("ui"))
  const other = snapshot("project-b")
  for (const entry of [all, ui, other]) rememberModelsSnapshot(entry)

  expect(recallModelsSnapshot("project-a", filters())).toBe(all)
  expect(recallModelsSnapshot("project-a", filters("ui"))).toBe(ui)
  expect(recallModelsSnapshot("project-b", filters())).toBe(other)
  expect(recallModelsSnapshot("project-b", filters("ui"))).toBeUndefined()
  expect(modelsSnapshotKey("project-a", filters())).not.toBe(
    modelsSnapshotKey("project-a", filters("ui")),
  )

  // A later update for the same key replaces the earlier one.
  const newer = { ...all, comparisonLoading: false }
  rememberModelsSnapshot(newer)
  expect(recallModelsSnapshot("project-a", filters())).toBe(newer)
})

test("a snapshot with nothing to show, or one that failed, never replaces a good one", () => {
  const good = snapshot("project-a")
  rememberModelsSnapshot(good)
  const loading = { ...new ModelComparisonPanelState(() => {}).data, key: "project-a" }
  const failed: ModelComparisonPanelData = { ...good, decisionStatus: "error" }
  rememberModelsSnapshot(loading)
  rememberModelsSnapshot(failed)
  rememberModelsSnapshot({ ...good, key: "" })
  expect(recallModelsSnapshot("project-a", filters())).toBe(good)
  expect(recallModelsSnapshot("", filters())).toBeUndefined()
})

test("the cache is bounded and drops the least recently updated project first", () => {
  for (let index = 0; index < 14; index++) rememberModelsSnapshot(snapshot(`project-${index}`))
  expect(recallModelsSnapshot("project-0", filters())).toBeUndefined()
  expect(recallModelsSnapshot("project-1", filters())).toBeUndefined()
  expect(recallModelsSnapshot("project-2", filters())).toBeDefined()
  expect(recallModelsSnapshot("project-13", filters())).toBeDefined()
})

test("retained snapshots are bounded by bytes, keeping the newest and dropping the oldest first", () => {
  const size = JSON.stringify(snapshot("project-size")).length * 2
  const original = modelsSnapshotBudget.bytes
  // Room for two snapshots of this size: the third evicts the first, however few there are.
  modelsSnapshotBudget.bytes = size * 2 + 16
  try {
    for (const key of ["a", "b", "c"]) rememberModelsSnapshot(snapshot(`project-${key}`))
    expect(recallModelsSnapshot("project-a", filters())).toBeUndefined()
    expect(recallModelsSnapshot("project-b", filters())).toBeDefined()
    expect(recallModelsSnapshot("project-c", filters())).toBeDefined()
    // A snapshot larger than the whole budget is still served: the newest never evicts itself.
    modelsSnapshotBudget.bytes = 1
    rememberModelsSnapshot(snapshot("project-d"))
    expect(recallModelsSnapshot("project-d", filters())).toBeDefined()
    expect(recallModelsSnapshot("project-c", filters())).toBeUndefined()
  } finally {
    modelsSnapshotBudget.bytes = original
  }
})
