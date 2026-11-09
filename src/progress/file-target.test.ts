import { expect, test } from "bun:test"
import { FILE_TARGET_LIMITS, observeFileTargets } from "./file-target.ts"

const workspace = "/workspace/project"

test("read and edit observations retain only lexically contained workspace-relative targets", () => {
  expect(
    observeFileTargets("read", { path: "src/app.ts", content: "private body" }, workspace),
  ).toEqual({
    coverage: "observed",
    operation: "read",
    paths: ["src/app.ts"],
  })
  expect(
    observeFileTargets(
      "edit",
      { path: "/workspace/project/src/app.ts", text: "secret" },
      workspace,
    ),
  ).toEqual({
    coverage: "observed",
    operation: "edit",
    paths: ["src/app.ts"],
  })
})

test("external, URI, traversal, malformed and over-limit paths are omitted", () => {
  for (const path of [
    "../outside.ts",
    "src/../../outside.ts",
    "/workspace/project-sibling/file.ts",
    "file:///workspace/project/file.ts",
    "https://example.test/file.ts",
    `src/${"x".repeat(FILE_TARGET_LIMITS.pathBytes + 1)}`,
    "",
  ])
    expect(observeFileTargets("read", { path }, workspace)).toMatchObject({
      coverage: "omitted",
      paths: [],
    })
})

test("requested targets above the output-path cap are omitted", () => {
  const path = `src/${"x".repeat(FILE_TARGET_LIMITS.outputPathBytes + 1)}`
  const pathBytes = new TextEncoder().encode(path).byteLength
  expect(pathBytes).toBeGreaterThan(FILE_TARGET_LIMITS.outputPathBytes)
  expect(pathBytes).toBeLessThan(FILE_TARGET_LIMITS.pathBytes)
  expect(observeFileTargets("read", { path }, workspace)).toEqual({
    coverage: "omitted",
    operation: "read",
    paths: [],
  })
})

test("patch parsing retains operation paths without retaining patch bodies", () => {
  const patchText = [
    "*** Begin Patch",
    "*** Update File: src/changed.ts",
    "+private patch body decoy",
    "*** Add File: docs/new.md",
    "*** End Patch",
  ].join("\n")
  const result = observeFileTargets("patch", { patchText, private: "credential-decoy" }, workspace)
  expect(result).toEqual({
    coverage: "observed",
    operation: "patch",
    paths: ["src/changed.ts", "docs/new.md"],
  })
  expect(JSON.stringify(result)).not.toContain("private patch body")
  expect(JSON.stringify(result)).not.toContain("credential-decoy")

  expect(
    observeFileTargets(
      "patch",
      {
        patchText: [
          "diff --git a/src/changed.ts b/src/changed.ts",
          "--- a/src/changed.ts",
          "+++ b/src/changed.ts",
          "@@ -1 +1 @@",
          "-secret source",
          "+secret replacement",
        ].join("\n"),
      },
      workspace,
    ),
  ).toEqual({ coverage: "observed", operation: "patch", paths: ["src/changed.ts"] })
})

test("patch input, output path count and malformed headers have bounded omission coverage", () => {
  expect(
    observeFileTargets(
      "patch",
      { patchText: "x".repeat(FILE_TARGET_LIMITS.inputBytes + 1) },
      workspace,
    ),
  ).toEqual({ coverage: "omitted", operation: "patch", paths: [] })
  expect(
    observeFileTargets("patch", { patchText: "*** Begin Patch\n*** Update File: a.ts" }, workspace),
  ).toEqual({ coverage: "omitted", operation: "patch", paths: [] })

  const patchText = [
    "*** Begin Patch",
    ...Array.from(
      { length: FILE_TARGET_LIMITS.targets + 1 },
      (_, index) => `*** Update File: src/file-${index}.ts`,
    ),
    "*** End Patch",
  ].join("\n")
  const result = observeFileTargets("patch", { patchText }, workspace)
  expect(result?.coverage).toBe("partial")
  expect(result?.paths).toHaveLength(FILE_TARGET_LIMITS.targets)
  expect(new TextEncoder().encode(JSON.stringify(result?.paths)).byteLength).toBeLessThanOrEqual(
    FILE_TARGET_LIMITS.outputBytes,
  )
})

test("output paths enforce the UTF-8 byte boundary after normalization", () => {
  const boundary = "é".repeat(FILE_TARGET_LIMITS.outputPathBytes / 2)
  expect(observeFileTargets("read", { path: `./${boundary}` }, workspace)).toEqual({
    coverage: "observed",
    operation: "read",
    paths: [boundary],
  })
  expect(observeFileTargets("read", { path: `${boundary}x` }, workspace)).toEqual({
    coverage: "omitted",
    operation: "read",
    paths: [],
  })
})

test("serialized output bytes truncate individually valid patch targets", () => {
  const paths = Array.from({ length: FILE_TARGET_LIMITS.targets }, (_, index) =>
    `${index}`.padEnd(FILE_TARGET_LIMITS.outputPathBytes, "x"),
  )
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
  expect(bytes(paths)).toBeGreaterThan(FILE_TARGET_LIMITS.outputBytes)
  const result = observeFileTargets(
    "patch",
    {
      patchText: [
        "*** Begin Patch",
        ...paths.map((path) => `*** Update File: ${path}`),
        "*** End Patch",
      ].join("\n"),
    },
    workspace,
  )
  expect(result).toEqual({ coverage: "partial", operation: "patch", paths: paths.slice(0, -1) })
  expect(bytes(result!.paths)).toBeLessThanOrEqual(FILE_TARGET_LIMITS.outputBytes)
})

test("multi-target patch summaries stay below the total output byte cap", () => {
  const paths = Array.from(
    { length: FILE_TARGET_LIMITS.targets },
    (_, index) => `src/${index}${"x".repeat(FILE_TARGET_LIMITS.outputPathBytes - 5)}`,
  )
  const patchText = [
    "*** Begin Patch",
    ...paths.map((path) => `*** Update File: ${path}`),
    "*** End Patch",
  ].join("\n")
  expect(new TextEncoder().encode(patchText).byteLength).toBeLessThan(FILE_TARGET_LIMITS.inputBytes)
  expect(new TextEncoder().encode(JSON.stringify(paths)).byteLength).toBeGreaterThan(
    FILE_TARGET_LIMITS.outputBytes,
  )

  const result = observeFileTargets("patch", { patchText }, workspace)
  expect(result?.coverage).toBe("partial")
  expect(result?.paths).toHaveLength(FILE_TARGET_LIMITS.targets - 1)
  expect(result?.paths.at(-1)).toBe(paths.at(-2))
  expect(new TextEncoder().encode(JSON.stringify(result?.paths)).byteLength).toBeLessThanOrEqual(
    FILE_TARGET_LIMITS.outputBytes,
  )
})

test("unsupported tools and accessors do not expose or evaluate argument values", () => {
  let getterRead = false
  const input = Object.defineProperty({}, "path", {
    get() {
      getterRead = true
      return "src/private.ts"
    },
  })
  expect(observeFileTargets("write", { path: "src/private.ts" }, workspace)).toBeUndefined()
  expect(observeFileTargets("read", input, workspace)).toMatchObject({
    coverage: "omitted",
    paths: [],
  })
  expect(getterRead).toBe(false)
})
