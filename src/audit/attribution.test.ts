import { expect, test } from "bun:test"
import { addedLineRangesFromDiff } from "./attribution.ts"

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
