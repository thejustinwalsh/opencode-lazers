import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { CodeReviewComparison, CodeReviewSide } from "../contract.ts"
import type { StructuralDiff } from "../structural/contract.ts"
import { estimatedRows, placeholderDiff, ReviewSession } from "./session.ts"
import type { FileAnalysis, ReviewTransport } from "./transport.ts"
import type { FileRow, ReviewFile } from "./model/files.ts"

const oid = (n: number) => n.toString(16).padStart(40, "0")
const CMP = "a".repeat(64)
const comparison = {
  sides: ["base", "head"],
  identity: {
    version: 1,
    comparisonID: CMP,
    projectID: "p",
    taskID: "11111111-1111-4111-8111-111111111111",
    planID: null,
    attemptID: null,
    mode: "task",
    baseRevision: oid(1),
    headRevision: oid(2),
    snapshotID: null,
    capturedAt: null,
    attribution: "committed",
  },
} as unknown as CodeReviewComparison

const PATHS = ["f1.ts", "f2.ts", "f3.ts", "f4.ts", "f5.ts"]
const BASE = "one\ntwo\n"
const HEAD = "one\nTWO\n"

const row = (path: string, side: CodeReviewSide, id: number): FileRow => ({
  path,
  side,
  object_id: oid(id),
  kind: "text",
  status: "modified",
  changed: true,
  hunks: [],
  attribution_task_ids: [],
  size: 8,
  mode: "100644",
})

const structural = (path: string): StructuralDiff => ({
  path,
  engineVersion: "0.71.0",
  status: "changed",
  language: "typescript",
  engine: "difftastic",
  alignedLines: [
    [1, 1],
    [2, 2],
  ],
  hunks: [
    [
      {
        base: { line: 2, tokens: [{ start: 0, end: 3, highlight: "normal" }] },
        head: { line: 2, tokens: [{ start: 0, end: 3, highlight: "normal" }] },
      },
    ],
  ],
})

type Fake = ReturnType<typeof fake>
function fake(options: { analysis?: (path: string) => FileAnalysis | undefined } = {}) {
  const calls = {
    shape: [] as string[],
    source: [] as string[],
    signals: new Map<string, AbortSignal>(),
  }
  const state = {
    gate: undefined as Promise<void> | undefined,
    failSource: false,
  }
  const textOf = (side: string) => (side === "base" ? BASE : HEAD)
  const transport: ReviewTransport = {
    resolve: async () => comparison,
    history: async () => ({ taskID: "", revisions: [], nextCursor: null }) as never,
    task: async () => undefined,
    async files(request, onPage) {
      const rows = PATHS.map((p, i) => row(p, request.side, i + 10))
      onPage(rows.slice(0, 3))
      await Promise.resolve()
      onPage(rows.slice(3))
    },
    async shape(source, signal) {
      calls.shape.push(`${source.side}:${source.path}`)
      calls.signals.set(`${source.side}:${source.path}`, signal)
      if (state.gate)
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          void state.gate!.then(resolve)
        })
      signal.throwIfAborted()
      return { exists: true, kind: "text", lineCount: 2 } as never
    },
    async source(source, startLine, endLine) {
      calls.source.push(`${source.side}:${source.path}`)
      if (state.failSource) throw new Error("read failed")
      const lines = textOf(source.side).split(/(?<=\n)/)
      return { text: lines.slice(startLine - 1, endLine).join("") } as never
    },
    ...(options.analysis
      ? { analysis: async (request: { file: ReviewFile }) => options.analysis!(request.file.path) }
      : {}),
  }
  return { transport, calls, state }
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise((r) => setTimeout(r, 1))
  expect(condition()).toBe(true)
}

function open(f: Fake, controller = new AbortController()) {
  return createRoot((dispose) => ({
    session: new ReviewSession(f.transport, comparison, controller.signal),
    controller,
    dispose,
  }))
}

describe("load", () => {
  test("publishes files and a placeholder per file and completes", async () => {
    const { session } = open(fake())
    expect(session.complete()).toBe(false)
    await session.load()
    expect(session.complete()).toBe(true)
    expect(session.files().map((f) => f.path)).toEqual(PATHS)
    expect(session.items().map((i) => i.id)).toEqual(PATHS)
    for (const item of session.items()) expect(item.version).toBe(0)
    for (const path of PATHS) expect(session.view(path).phase).toBe("waiting")
  })
})

describe("near", () => {
  test("loads the file and the next two only", async () => {
    const f = fake()
    const { session } = open(f)
    await session.load()
    session.near(["f1.ts"])
    await until(() => ["f1.ts", "f2.ts", "f3.ts"].every((p) => session.view(p).phase === "ready"))
    expect(session.view("f4.ts").phase).toBe("waiting")
    expect(session.view("f5.ts").phase).toBe("waiting")
    expect(new Set(f.calls.shape.map((s) => s.split(":")[1]))).toEqual(
      new Set(["f1.ts", "f2.ts", "f3.ts"]),
    )
  })

  test("a file that leaves the neighborhood is aborted and returns to waiting", async () => {
    const f = fake()
    let release!: () => void
    f.state.gate = new Promise<void>((resolve) => (release = resolve))
    const { session } = open(f)
    await session.load()
    session.near(["f1.ts"])
    await until(() => f.calls.shape.length >= 2)
    expect(session.view("f1.ts").phase).toBe("loading")
    session.near(["f5.ts"])
    expect(f.calls.signals.get("head:f1.ts")?.aborted).toBe(true)
    expect(session.view("f1.ts").phase).toBe("waiting")
    expect(session.view("f2.ts").phase).toBe("waiting")
    expect(session.view("f5.ts").phase).toBe("loading")
    release()
  })
})

describe("analysis", () => {
  test("another comparison's result is ignored and falls back to a line diff", async () => {
    const f = fake({
      analysis: (path) => ({ comparisonID: "f".repeat(64), path, diff: structural(path) }),
    })
    const { session } = open(f)
    await session.load()
    await session.ensure("f1.ts")
    const view = session.view("f1.ts")
    expect(view).toMatchObject({ phase: "ready", engine: "line" })
    expect(session.fallback().has("f1.ts")).toBe(true)
  })

  test("a matching result renders structurally", async () => {
    const f = fake({ analysis: (path) => ({ comparisonID: CMP, path, diff: structural(path) }) })
    const { session } = open(f)
    await session.load()
    await session.ensure("f1.ts")
    expect(session.view("f1.ts")).toMatchObject({ phase: "ready", engine: "structural" })
    expect(session.fallback().has("f1.ts")).toBe(false)
  })

  test("no analysis source is a line diff", async () => {
    const { session } = open(fake())
    await session.load()
    await session.ensure("f1.ts")
    expect(session.view("f1.ts")).toMatchObject({
      phase: "ready",
      engine: "line",
      added: 1,
      removed: 1,
    })
  })
})

describe("onItem and versions", () => {
  test("rebuilt items carry an incremented version", async () => {
    const { session } = open(fake())
    const seen: number[] = []
    session.onItem = (item) => seen.push(item.version ?? -1)
    await session.load()
    await session.ensure("f1.ts")
    await session.retry("f1.ts")
    expect(seen).toEqual([1, 2])
    expect(session.items().find((i) => i.id === "f1.ts")?.version).toBeGreaterThanOrEqual(0)
  })
})

describe("dispose and failure", () => {
  test("dispose aborts in-flight reads", async () => {
    const f = fake()
    f.state.gate = new Promise<void>(() => {})
    const { session } = open(f)
    await session.load()
    session.near(["f1.ts"])
    await until(() => f.calls.shape.length >= 2)
    session.dispose()
    for (const signal of f.calls.signals.values()) expect(signal.aborted).toBe(true)
    expect(session.signal.aborted).toBe(true)
  })

  test("the owning signal disposes the session", async () => {
    const f = fake()
    const { session, controller } = open(f)
    controller.abort()
    expect(session.signal.aborted).toBe(true)
  })

  test("a read failure sets failed and retry reloads", async () => {
    const f = fake()
    f.state.failSource = true
    const { session } = open(f)
    await session.load()
    await session.ensure("f1.ts")
    expect(session.view("f1.ts")).toEqual({ phase: "failed", error: "read failed" })
    f.state.failSource = false
    await session.retry("f1.ts")
    expect(session.view("f1.ts").phase).toBe("ready")
  })
})

describe("estimatedRows and placeholderDiff", () => {
  const file = (hunks: ReviewFile["hunks"], kind = "text") =>
    ({
      hunks,
      base: { side: "base", revision: oid(1), kind, size: 1 },
      head: { side: "head", revision: oid(2), kind, size: 1 },
    }) as unknown as ReviewFile
  test("rows by hunks and context", () => {
    expect(estimatedRows(file([]))).toBe(1 + 6)
    expect(estimatedRows(file([{ baseStart: 1, baseEnd: 4, headStart: 1, headEnd: 2 }]))).toBe(
      4 + 6,
    )
    expect(estimatedRows(file([], "binary"))).toBe(0)
  })
  test("placeholderDiff", () => {
    expect(placeholderDiff("a", 0).hunks).toEqual([])
    const diff = placeholderDiff("a", 5)
    expect(diff.hunks).toHaveLength(1)
    expect(diff.splitLineCount).toBe(9)
  })
})
