import { expect, test } from "bun:test"
import { pathCheck, rulesAdd } from "./checks.ts"
import { PlanningBody } from "./draft.ts"

const body = (writeScope: string[], createScope: { path: string; purpose: string }[] = []) =>
  PlanningBody.parse({
    title: "t",
    ask: "a",
    plan: { objective: "o" },
    tasks: [{ draftID: "plan-link", proposal: { writeScope, createScope } }],
  })
const map = new Set(["src/planning/contract.ts", "src/database-schema.ts"])

test("a path missing from the map is a confirmed finding; map paths and created paths pass", () => {
  const found = pathCheck(
    body(
      ["src/nope.ts", "src/planning/contract.ts", "src/planning/new/**", "src/gone/**"],
      [{ path: "src/planning/new/", purpose: "new module" }],
    ),
    map,
    "abc123",
  )
  expect(found.map((f) => f.target)).toEqual([
    { unit: "plan-link", field: "write-scope" },
    { unit: "plan-link", field: "write-scope" },
  ])
  expect(found[0]).toMatchObject({ id: "P1", severity: "major", confidence: "confirmed" })
  expect(found[0]!.evidence).toEqual(["src/nope.ts is not in the repository map (hash abc123)"])
  expect(found[1]!.evidence[0]).toContain("src/gone/**")
  expect(pathCheck(body(["src/planning/*.ts"]), map)).toEqual([])
})

test("a draft that writes stored-data files adds the Critic with its rule", () => {
  expect(rulesAdd(body(["src/database-schema.ts"]))).toEqual([
    { agent: "critic", ruleID: "stored-data" },
  ])
  expect(rulesAdd(body([], [{ path: "db/migrations/", purpose: "m" }]))).toEqual([
    { agent: "critic", ruleID: "stored-data" },
  ])
  expect(rulesAdd(body(["src/planning/contract.ts"]))).toEqual([])
})
