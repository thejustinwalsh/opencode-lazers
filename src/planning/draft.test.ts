import { expect, test } from "bun:test"
import {
  FIELD_KEYS,
  PlanningBody,
  changedFields,
  fieldHashes,
  isStale,
  validateBody,
} from "./draft.ts"

const proposal = (over: Record<string, unknown> = {}) => ({
  objective: "Open a stored plan from a chat link.",
  exclusions: [],
  constraints: [],
  assumptions: [],
  writeScope: ["src/planning/links.ts"],
  context: [],
  acceptance: [{ id: "opens", assertion: "The link opens the plan.", evidence: [] }],
  requirements: { capabilities: [], skills: [], risk: "low" },
  verification: [{ id: "unit", command: "bun test --timeout 120000 src/planning/links.test.ts" }],
  ...over,
})

const body = (tasks: Record<string, unknown>[]) =>
  PlanningBody.parse({
    title: "Planning flow",
    ask: "Plan it",
    plan: { objective: "Plan it", verification: [], acceptance: [] },
    tasks,
  })

const draft = (draftID: string, over: Record<string, unknown> = {}, dependsOn: string[] = []) => ({
  draftID,
  dependsOn,
  proposal: proposal(over),
})

test("a draft without acceptance is stored and its problem is listed", () => {
  const { acceptance: _omit, ...rest } = proposal()
  const parsed = body([{ draftID: "plan-link", proposal: rest }])
  const validation = validateBody(parsed)
  expect(validation.drafts["plan-link"]?.some((p) => p.path === "acceptance")).toBe(true)
  expect(validateBody(body([draft("ok")])).drafts).toEqual({})
})

test("a path outside the checkout is a writeScope issue", () => {
  const validation = validateBody(body([draft("a", { writeScope: ["../other/x.ts"] })]))
  expect(validation.drafts.a?.some((p) => p.path === "writeScope.0")).toBe(true)
})

test("an unknown dependency and a cycle are graph problems", () => {
  const unknown = validateBody(body([draft("a", {}, ["nope"])]))
  expect(unknown.graph).toHaveLength(1)
  expect(unknown.graph[0]?.kind).toBe("unknown-dependency")
  const cycle = validateBody(body([draft("a", {}, ["b"]), draft("b", {}, ["a"])]))
  expect(cycle.graph.map((g) => g.kind)).toEqual(["cycle"])
})

test("duplicate draftIDs fail the body schema", () => {
  const result = PlanningBody.safeParse({
    title: "t",
    ask: "a",
    plan: { objective: "o", verification: [], acceptance: [] },
    tasks: [draft("a"), draft("a")],
  })
  expect(result.success).toBe(false)
})

test("a finding is stale exactly when its draft field changed", () => {
  const r1 = body([draft("plan-link"), draft("other")])
  const r2 = body([draft("other"), draft("plan-link", { writeScope: ["src/planning/other.ts"] })])
  const at = (revision: number) => fieldHashes(revision === 1 ? r1 : r2)
  const finding = (field: Parameters<typeof isStale>[0]["field"]) => ({
    draftID: "plan-link",
    field,
    revision: 1,
  })
  expect(isStale(finding("write-scope"), at, 2)).toBe(true)
  expect(isStale(finding("objective"), at, 2)).toBe(false)
  expect(isStale(finding("other"), at, 2)).toBe(true)
  expect(isStale({ ...finding("write-scope"), revision: 2 }, at, 2)).toBe(false)
  expect(changedFields(r1, r2)).toEqual({ "plan-link": ["writeScope"] })
  expect(FIELD_KEYS["write-scope"]).toContain("createScope")
})

test("reordering tasks and object keys changes no hash", () => {
  const a = body([draft("a"), draft("b")])
  const b = body([
    {
      proposal: Object.fromEntries(Object.entries(proposal()).reverse()),
      dependsOn: [],
      draftID: "b",
    },
    draft("a"),
  ])
  expect(fieldHashes(b)).toEqual(fieldHashes(a))
  expect(changedFields(a, body([draft("a")]))).toEqual({ b: ["removed"] })
})

test("a body without plan-level verification or acceptance stores and reports both", () => {
  const parsed = PlanningBody.parse({
    title: "t",
    ask: "a",
    plan: { objective: "o" },
    tasks: [{ draftID: "a" }],
  })
  const validation = validateBody(parsed)
  expect(validation.plan.map((p) => p.path.split(".")[0])).toContain("verification")
  expect(validation.plan.map((p) => p.path.split(".")[0])).toContain("acceptance")
  expect(validation.drafts.a?.length).toBeGreaterThan(0)
})
