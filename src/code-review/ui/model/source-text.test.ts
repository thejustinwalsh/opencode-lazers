import { describe, expect, test } from "bun:test"
import type { CodeReviewSourceIdentity } from "../../contract.ts"
import { excerptOf, linesOf, readSourceText } from "./source-text.ts"

const source = {} as CodeReviewSourceIdentity

function transport(text: string | null, kind = "text") {
  const lines = text === null ? [] : text.split(/(?<=\n)/).filter((l) => l !== "")
  const calls: [number, number][] = []
  return {
    calls,
    shape: async () => ({
      exists: text !== null,
      kind,
      lineCount: text === null ? null : lines.length,
    }),
    source: async (_s: unknown, start: number, end: number) => {
      calls.push([start, end])
      return { text: lines.slice(start - 1, end).join("") }
    },
  } as never as Parameters<typeof readSourceText>[0] & { calls: [number, number][] }
}

const body = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`)

describe("readSourceText", () => {
  for (const [name, text] of [
    ["trailing newline", body(1201).join("\n") + "\n"],
    ["no trailing newline", body(1201).join("\n")],
  ] as const)
    test(`1201 lines read as three windows (${name})`, async () => {
      const t = transport(text)
      const out = await readSourceText(t, source, new AbortController().signal)
      expect((t as unknown as { calls: unknown }).calls).toEqual([
        [1, 500],
        [501, 1000],
        [1001, 1201],
      ])
      expect(out).toEqual({ kind: "text", text, lineCount: 1201 })
    })

  test("binary and absent are opaque", async () => {
    const signal = new AbortController().signal
    expect(await readSourceText(transport("x\n", "binary"), source, signal)).toEqual({
      kind: "opaque",
    })
    expect(await readSourceText(transport(null, "absent"), source, signal)).toEqual({
      kind: "opaque",
    })
  })

  test("zero lines is empty text with no source calls", async () => {
    const t = transport("")
    const out = await readSourceText(t, source, new AbortController().signal)
    expect(out).toEqual({ kind: "text", text: "", lineCount: 0 })
    expect((t as unknown as { calls: unknown[] }).calls).toEqual([])
  })

  test("an aborted signal propagates", async () => {
    const controller = new AbortController()
    const reason = new Error("stop")
    const t = {
      shape: async (_s: unknown, signal: AbortSignal) => {
        controller.abort(reason)
        signal.throwIfAborted()
        return { exists: true, kind: "text", lineCount: 1 }
      },
      source: async () => ({ text: "x" }),
    } as never as Parameters<typeof readSourceText>[0]
    await expect(readSourceText(t, source, controller.signal)).rejects.toBe(reason)
  })
})

describe("linesOf and excerptOf", () => {
  const text = "alpha\nbeta\ngamma\ndelta\n"
  test("linesOf", () => {
    expect(linesOf(text, 2, 3)).toBe("beta\ngamma")
    expect(linesOf(text, 1, 1)).toBe("alpha")
  })
  test("whole lines", () => {
    expect(excerptOf(text, { startLine: 2, endLine: 3 })).toBe("beta\ngamma")
  })
  test("single-line characters", () => {
    expect(excerptOf(text, { startLine: 3, endLine: 3, startChar: 1, endChar: 4 })).toBe("amm")
  })
  test("multi-line characters", () => {
    expect(excerptOf(text, { startLine: 1, endLine: 3, startChar: 2, endChar: 3 })).toBe(
      "pha\nbeta\ngam",
    )
  })
  test("out of range is empty", () => {
    expect(excerptOf(text, { startLine: 50, endLine: 51 })).toBe("")
  })
})
