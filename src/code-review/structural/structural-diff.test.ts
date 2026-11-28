import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  StructuralCompareRequestSchema,
  StructuralDiffSchema,
  type StructuralCompareRequest,
} from "./contract.ts"
import { parseDifftasticJson } from "./difftastic-json.ts"
import { toStructuralDiff } from "./difftastic-result.ts"
import { lineDiff } from "./line-diff.ts"
import { createStructuralDiffService } from "./service.ts"
import { structuralDiffFromJson } from "./structural-diff.ts"
import { byteOffsetToUtf16Column, splitSourceLines, utf8Bytes } from "./utf-coordinates.ts"
import { compareStructural } from "./worker-client.ts"

const fixtures = join(import.meta.dir, "../../../test/code-review/structural-fixtures")

const parityCases = [
  { fixture: "signature-change", path: "src/price.ts" },
  { fixture: "signature-change", path: "src/cart.ts" },
  { fixture: "format-only", path: "src/config.ts" },
  { fixture: "rename-only", path: "src/queue.ts" },
  { fixture: "unparseable-file", path: "src/broken.ts" },
  { fixture: "rust-trait-impl", path: "src/lib.rs" },
  { fixture: "controlled-unicode", path: "sample.ts" },
  { fixture: "controlled-final-newline", path: "sample.ts" },
  { fixture: "controlled-empty", path: "empty.ts" },
  { fixture: "controlled-empty-present", path: "empty.ts" },
] as const

async function readSource(
  fixture: string,
  side: "base" | "head",
  path: string,
): Promise<string | null> {
  const fixturePath = `${path}.fixture`
  try {
    return await readFile(join(fixtures, "fixtures", fixture, side, fixturePath), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

async function requestFor(
  fixture: string,
  path: string,
  overrides: Partial<StructuralCompareRequest> = {},
) {
  return StructuralCompareRequestSchema.parse({
    path,
    base: await readSource(fixture, "base", path),
    head: await readSource(fixture, "head", path),
    ...overrides,
  })
}

async function expectedFromSnapshot(name: string, request: StructuralCompareRequest) {
  const json = await readFile(join(fixtures, "snapshots", name), "utf8")
  return structuralDiffFromJson(json, StructuralCompareRequestSchema.parse(request))
}

describe("Difftastic WASM compatibility", () => {
  test("matches the pinned native JSON projection", async () => {
    for (const { fixture, path } of parityCases) {
      const request = await requestFor(fixture, path)
      const snapshot = `${fixture}--${path.replaceAll("/", "-")}.json`
      const [actual, expected] = await Promise.all([
        compareStructural(request, { timeoutMs: 60_000 }),
        expectedFromSnapshot(snapshot, request),
      ])
      expect(actual, `${fixture} ${path}`).toEqual(expected)
      expect(actual.engineVersion).toBe("0.71.0")
      if (fixture === "controlled-unicode") {
        expect(
          actual.hunks.flatMap((hunk) => hunk.flatMap((row) => row.head?.tokens ?? [])),
        ).toContainEqual({
          start: 21,
          end: 22,
          highlight: "normal",
        })
        expect(actual.comments?.length).toBeGreaterThan(0)
      }
    }
  }, 60_000)

  test("keeps native fallback behavior", async () => {
    const cases: {
      name: string
      fixture: string
      path: string
      overrides: Partial<StructuralCompareRequest>
    }[] = [
      {
        name: "fallback/byte-limit.json",
        fixture: "signature-change",
        path: "src/price.ts",
        overrides: { limits: { byteLimit: 10 } },
      },
      {
        name: "fallback/graph-limit.json",
        fixture: "signature-change",
        path: "src/price.ts",
        overrides: { limits: { graphLimit: 1 } },
      },
      {
        name: "fallback/created.json",
        fixture: "signature-change",
        path: "src/price.ts",
        overrides: { base: null },
      },
      {
        name: "fallback/deleted.json",
        fixture: "signature-change",
        path: "src/price.ts",
        overrides: { head: null },
      },
    ]
    for (const { name, fixture, path, overrides } of cases) {
      const request = await requestFor(fixture, path, overrides)
      const [actual, expected] = await Promise.all([
        compareStructural(request, { timeoutMs: 60_000 }),
        expectedFromSnapshot(name, request),
      ])
      expect(actual, name).toEqual(expected)
    }
  }, 60_000)

  test("absent and empty files retain distinct creation semantics", async () => {
    const [absent, empty] = await Promise.all([
      compareStructural({ path: "empty.ts", base: null, head: "" }, { timeoutMs: 60_000 }),
      compareStructural({ path: "empty.ts", base: "", head: "" }, { timeoutMs: 60_000 }),
    ])
    expect(absent.status).toBe("created")
    expect(absent.alignedLines).toEqual([])
    expect(empty.status).toBe("unchanged")
    expect((await compareStructural({ path: "missing.ts", base: null, head: null })).status).toBe(
      "unchanged",
    )
  }, 60_000)

  test("binary input uses an explicit degraded line result", async () => {
    const result = await compareStructural({
      path: "image.bin",
      base: "left",
      head: "right",
      binary: true,
    })
    expect(result).toMatchObject({ engine: "line", degraded: "binary", status: "changed" })
    expect(StructuralDiffSchema.safeParse(result).success).toBe(true)
  })

  test("a timeout returns the bounded line fallback", async () => {
    const result = await compareStructural(
      { path: "timer.txt", base: "before\n", head: "after\n" },
      { timeoutMs: 1 },
    )
    expect(result).toMatchObject({ engine: "line", degraded: "timeout", status: "changed" })
  })

  test("an aborted in-flight comparison rejects and terminates its worker", async () => {
    const controller = new AbortController()
    const pending = compareStructural(
      {
        path: "large.ts",
        base: `const base = ${JSON.stringify("a".repeat(400_000))};\n`,
        head: `const head = ${JSON.stringify("b".repeat(400_000))};\n`,
        limits: { byteLimit: 1_000_000, graphLimit: 3_000_000, parseErrorLimit: 0 },
      },
      { signal: controller.signal, timeoutMs: 60_000 },
    )
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  }, 60_000)

  test("a newer immutable source identity supersedes the obsolete result", async () => {
    const service = createStructuralDiffService()
    const request = { path: "same.ts", base: "before\n", head: "after\n" }
    const old = service.compare({
      identity: { comparisonID: "task:task-id", sourceID: "old-source" },
      request,
    })
    const latest = service.compare({
      identity: { comparisonID: "task:task-id", sourceID: "new-source" },
      request,
    })
    await expect(old).resolves.toBeUndefined()
    await expect(latest).resolves.toMatchObject({
      identity: { comparisonID: "task:task-id", sourceID: "new-source" },
      diff: { engineVersion: "0.71.0", status: "changed" },
    })
  }, 60_000)

  test("repeated service calls release their active identity after settling", async () => {
    const service = createStructuralDiffService()
    const input = {
      identity: { comparisonID: "task:repeat", sourceID: "source-v1" },
      request: { path: "repeat.ts", base: "a\n", head: "b\n" },
    }
    const first = await service.compare(input)
    const second = await service.compare(input)
    expect(first).toEqual(second)
  }, 60_000)
})

describe("structural output projection", () => {
  test("maps UTF-8 byte positions to UTF-16 columns and drops only the final synthetic line", () => {
    const line = 'const x = "🧿";\r'
    const bytes = utf8Bytes(line)
    expect(byteOffsetToUtf16Column(line, bytes, 11)).toBe(11)
    expect(byteOffsetToUtf16Column(line, bytes, 15)).toBe(13)
    expect(splitSourceLines("first\r\nsecond\n")).toEqual(["first\r", "second"])
    expect(splitSourceLines("\n")).toEqual([""])
    expect(splitSourceLines("")).toEqual([])
  })

  test("maps added comment ranges while whole-line additions carry no token boxes", () => {
    const file = parseDifftasticJson(
      JSON.stringify({
        aligned_lines: [[null, 0]],
        chunks: [
          [
            {
              rhs: {
                line_number: 0,
                changes: [{ start: 0, end: 7, content: "// note", highlight: "comment" }],
              },
            },
          ],
        ],
        language: "TypeScript",
        path: "sample.ts",
        status: "created",
      }),
    )
    const result = toStructuralDiff(file, {
      path: "sample.ts",
      base: null,
      head: "// note",
    })
    expect(result.hunks).toEqual([[{ head: { line: 1, tokens: [] } }]])
    expect(result.comments).toEqual([[1, 0, 7]])
  })

  test("falls back by change runs and distinguishes missing from present empty sources", () => {
    const fallback = StructuralCompareRequestSchema.parse({
      path: "src/example.ts",
      base: "one\nkeep\n",
      head: "two\nkeep\n",
    })
    expect(lineDiff(fallback, "parse-error")).toMatchObject({
      status: "changed",
      engine: "line",
      degraded: "parse-error",
      alignedLines: [
        [1, 1],
        [2, 2],
      ],
      hunks: [[{ base: { line: 1, tokens: [] }, head: { line: 1, tokens: [] } }]],
    })
    expect(
      lineDiff(
        StructuralCompareRequestSchema.parse({ path: "empty.ts", base: null, head: "" }),
        "timeout",
      ).status,
    ).toBe("created")
  })
})
