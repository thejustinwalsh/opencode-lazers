import { expect, test } from "bun:test"
import { selectSchedulingCandidates } from "./scheduling-selection.ts"

test("shared scheduling preserves candidate order and excludes work while the checkout is reserved", () => {
  const candidates = [
    { taskID: "first", scopes: ["src/**"] },
    { taskID: "second", scopes: ["docs/**"] },
  ]
  expect(selectSchedulingCandidates("shared", candidates, [])).toMatchObject({
    selectedTaskIDs: ["first"],
    holds: new Map([
      [
        "second",
        { reason: "Shared checkouts dispatch one task at a time.", reservationTaskIDs: ["first"] },
      ],
    ]),
  })
  expect(
    selectSchedulingCandidates("shared", candidates, [
      { shared: false, scopes: ["docs/**"], taskID: "active" },
    ]).selectedTaskIDs,
  ).toEqual([])
})

test("isolated scheduling keeps disjoint scopes and holds conflicting or shared reservations", () => {
  const candidates = [
    { taskID: "source", scopes: ["src/**"] },
    { taskID: "docs", scopes: ["docs/**"] },
    { taskID: "source-child", scopes: ["src/feature.ts"] },
    { taskID: "tests", scopes: ["test/**"] },
  ]
  const result = selectSchedulingCandidates("isolated", candidates, [
    { shared: false, scopes: ["docs/README.md"], taskID: "docs-active" },
  ])
  expect(result.selectedTaskIDs).toEqual(["source", "tests"])
  expect(result.holds.get("docs")).toMatchObject({ reservationTaskIDs: ["docs-active"] })
  expect(result.holds.get("source-child")).toMatchObject({ reservationTaskIDs: ["source"] })
  expect(
    selectSchedulingCandidates("isolated", candidates, [
      { shared: true, scopes: [], taskID: "shared-active" },
    ]).selectedTaskIDs,
  ).toEqual([])
})
