import { expect, test } from "bun:test"
import {
  addedLineRangesFromDiff,
  attributeComplexity,
  attributeDeadCode,
  attributeDuplication,
} from "./attribution.ts"

const limits = { cyclomatic: 20, cognitive: 15 }

test("a new over-limit function with no base counterpart is introduced", () => {
  const result = attributeComplexity(
    [],
    [{ path: "a.ts", name: "f", cyclomatic: 25, cognitive: 10 }],
    limits,
  )
  expect(result).toEqual([
    { path: "a.ts", name: "f", cyclomatic: 25, cognitive: 10, status: "introduced" },
  ])
})

test("a function within limits at base that is now over is introduced, not worsened", () => {
  const result = attributeComplexity(
    [{ path: "a.ts", name: "f", cyclomatic: 10, cognitive: 10 }],
    [{ path: "a.ts", name: "f", cyclomatic: 25, cognitive: 10 }],
    limits,
  )
  expect(result[0]!.status).toBe("introduced")
})

test("over at base and higher now is worsened, carrying the before snapshot", () => {
  const result = attributeComplexity(
    [{ path: "a.ts", name: "f", cyclomatic: 21, cognitive: 10 }],
    [{ path: "a.ts", name: "f", cyclomatic: 30, cognitive: 10 }],
    limits,
  )
  expect(result).toEqual([
    {
      path: "a.ts",
      name: "f",
      cyclomatic: 30,
      cognitive: 10,
      status: "worsened",
      before: { cyclomatic: 21, cognitive: 10 },
    },
  ])
})

test("over at base and not higher now is ignored entirely", () => {
  const result = attributeComplexity(
    [{ path: "a.ts", name: "f", cyclomatic: 30, cognitive: 10 }],
    [{ path: "a.ts", name: "f", cyclomatic: 25, cognitive: 10 }],
    limits,
  )
  expect(result).toEqual([])
})

test("a function within limits now is never reported, even if it changed", () => {
  const result = attributeComplexity(
    [{ path: "a.ts", name: "f", cyclomatic: 5, cognitive: 5 }],
    [{ path: "a.ts", name: "f", cyclomatic: 10, cognitive: 10 }],
    limits,
  )
  expect(result).toEqual([])
})

test("repeated names in a file match by order of appearance", () => {
  const base = [
    { path: "a.ts", name: "f", cyclomatic: 25, cognitive: 10 }, // first f: over at base
    { path: "a.ts", name: "f", cyclomatic: 5, cognitive: 5 }, // second f: within limits at base
  ]
  const candidate = [
    { path: "a.ts", name: "f", cyclomatic: 26, cognitive: 10 }, // matches first -> worsened
    { path: "a.ts", name: "f", cyclomatic: 21, cognitive: 10 }, // matches second -> introduced
  ]
  const result = attributeComplexity(base, candidate, limits)
  expect(result).toHaveLength(2)
  expect(result[0]!.status).toBe("worsened")
  expect(result[1]!.status).toBe("introduced")
})

test("addedLineRangesFromDiff reads a simple single-hunk diff", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "index 1111111..2222222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -10,0 +11,3 @@ function f() {",
    "+line one",
    "+line two",
    "+line three",
  ].join("\n")
  expect(addedLineRangesFromDiff(diff)).toEqual(
    new Map([["a.ts", [{ startLine: 11, endLine: 13 }]]]),
  )
})

test("addedLineRangesFromDiff handles multiple hunks in one file", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,0 +1,2 @@",
    "+x",
    "+y",
    "@@ -20,0 +22,1 @@",
    "+z",
  ].join("\n")
  expect(addedLineRangesFromDiff(diff)).toEqual(
    new Map([
      [
        "a.ts",
        [
          { startLine: 1, endLine: 2 },
          { startLine: 22, endLine: 22 },
        ],
      ],
    ]),
  )
})

test("addedLineRangesFromDiff ignores a pure deletion hunk (zero added lines)", () => {
  const diff = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -5,3 +5,0 @@"].join(
    "\n",
  )
  expect(addedLineRangesFromDiff(diff).has("a.ts")).toBe(false)
})

test("addedLineRangesFromDiff attributes a new file's added lines to its post-diff path", () => {
  const diff = [
    "diff --git a/new.ts b/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.ts",
    "@@ -0,0 +1,2 @@",
    "+export const a = 1",
    "+export const b = 2",
  ].join("\n")
  expect(addedLineRangesFromDiff(diff)).toEqual(
    new Map([["new.ts", [{ startLine: 1, endLine: 2 }]]]),
  )
})

test("addedLineRangesFromDiff attributes nothing to a deleted file", () => {
  const diff = [
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-export const a = 1",
    "-export const b = 2",
  ].join("\n")
  expect(addedLineRangesFromDiff(diff).size).toBe(0)
})

test("addedLineRangesFromDiff follows a rename to the new path", () => {
  const diff = [
    "diff --git a/old.ts b/renamed.ts",
    "similarity index 90%",
    "rename from old.ts",
    "rename to renamed.ts",
    "--- a/old.ts",
    "+++ b/renamed.ts",
    "@@ -1,0 +2,1 @@",
    "+added after rename",
  ].join("\n")
  expect(addedLineRangesFromDiff(diff)).toEqual(
    new Map([["renamed.ts", [{ startLine: 2, endLine: 2 }]]]),
  )
})

test("attributeDuplication anchors on the instance overlapping an added range", () => {
  const groups = [
    {
      instances: [
        { file: "a.ts", startLine: 100, endLine: 120 }, // untouched
        { file: "b.ts", startLine: 1, endLine: 20 }, // touched
      ],
    },
  ]
  const added = new Map([["b.ts", [{ startLine: 10, endLine: 10 }]]])
  const result = attributeDuplication(groups, added)
  expect(result).toHaveLength(1)
  expect(result[0]!.anchor).toEqual({ file: "b.ts", startLine: 1, endLine: 20 })
  expect(result[0]!.others).toEqual([{ file: "a.ts", startLine: 100, endLine: 120 }])
})

test("attributeDuplication is introduced when any one instance overlaps, not all", () => {
  const groups = [
    {
      instances: [
        { file: "a.ts", startLine: 100, endLine: 120 }, // untouched
        { file: "b.ts", startLine: 1, endLine: 20 }, // touched
      ],
    },
  ]
  const added = new Map([["b.ts", [{ startLine: 10, endLine: 10 }]]])
  expect(attributeDuplication(groups, added)).toHaveLength(1)
})

test("attributeDuplication picks the first overlapping instance as the anchor when several qualify", () => {
  const groups = [
    {
      instances: [
        { file: "a.ts", startLine: 1, endLine: 10 },
        { file: "b.ts", startLine: 1, endLine: 10 },
      ],
    },
  ]
  const added = new Map([
    ["a.ts", [{ startLine: 5, endLine: 5 }]],
    ["b.ts", [{ startLine: 5, endLine: 5 }]],
  ])
  const result = attributeDuplication(groups, added)
  expect(result[0]!.anchor.file).toBe("a.ts")
  expect(result[0]!.others).toEqual([{ file: "b.ts", startLine: 1, endLine: 10 }])
})

test("attributeDuplication drops a group whose instances miss every added range", () => {
  const groups = [{ instances: [{ file: "a.ts", startLine: 1, endLine: 5 }] }]
  const added = new Map([["a.ts", [{ startLine: 100, endLine: 100 }]]])
  expect(attributeDuplication(groups, added)).toEqual([])
})

test("attributeDuplication merges adjacent introductions over the same file pair into one finding", () => {
  const groups = [
    {
      instances: [
        { file: "probe.ts", startLine: 1, endLine: 27 },
        { file: "attribution.ts", startLine: 73, endLine: 99 },
      ],
    },
    {
      instances: [
        { file: "probe.ts", startLine: 28, endLine: 42 },
        { file: "attribution.ts", startLine: 99, endLine: 114 },
      ],
    },
  ]
  const added = new Map([["probe.ts", [{ startLine: 1, endLine: 42 }]]])
  const result = attributeDuplication(groups, added)
  expect(result).toHaveLength(1)
  expect(result[0]!.anchor).toEqual({ file: "probe.ts", startLine: 1, endLine: 42 })
  expect(result[0]!.others).toEqual([{ file: "attribution.ts", startLine: 73, endLine: 114 }])
})

test("attributeDuplication does not merge introductions whose anchors are not adjacent", () => {
  const groups = [
    {
      instances: [
        { file: "probe.ts", startLine: 1, endLine: 10 },
        { file: "attribution.ts", startLine: 73, endLine: 82 },
      ],
    },
    {
      instances: [
        { file: "probe.ts", startLine: 50, endLine: 60 },
        { file: "attribution.ts", startLine: 99, endLine: 109 },
      ],
    },
  ]
  const added = new Map([["probe.ts", [{ startLine: 1, endLine: 60 }]]])
  expect(attributeDuplication(groups, added)).toHaveLength(2)
})

test("attributeDuplication does not merge adjacent anchors that point at a different other-file set", () => {
  const groups = [
    {
      instances: [
        { file: "probe.ts", startLine: 1, endLine: 10 },
        { file: "attribution.ts", startLine: 73, endLine: 82 },
      ],
    },
    {
      instances: [
        { file: "probe.ts", startLine: 11, endLine: 20 },
        { file: "config.ts", startLine: 5, endLine: 14 },
      ],
    },
  ]
  const added = new Map([["probe.ts", [{ startLine: 1, endLine: 20 }]]])
  expect(attributeDuplication(groups, added)).toHaveLength(2)
})

test("attributeDeadCode keys on kind + path + name, ignoring line", () => {
  const base = [{ kind: "export", path: "a.ts", name: "unused" }]
  const candidate = [
    { kind: "export", path: "a.ts", name: "unused" },
    { kind: "export", path: "a.ts", name: "newUnused" },
  ]
  expect(attributeDeadCode(base, candidate)).toEqual([
    { kind: "export", path: "a.ts", name: "newUnused" },
  ])
})
