import { describe, expect, test } from "bun:test"
import type { ComposerNote, ComposerQuote } from "@opencode/plugin/gui"
import type { DiscussHost } from "./discuss.ts"

import { discussWithArchitect } from "./discuss.ts"

const quote = {
  type: "quote",
  commentID: "q1",
  text: "a\nb",
  source: {},
} as unknown as ComposerQuote
const note = { type: "note", commentID: "n1", subject: "pinned" } as unknown as ComposerNote

function setup(initial: string | undefined, quotable = true) {
  let current = initial
  const waiters: (() => void)[] = []
  const setCurrent = (id: string) => {
    current = id
    for (const wake of waiters.splice(0)) wake()
  }
  const log: unknown[][] = []
  const controller = new AbortController()
  const composer = {
    quotable: () => quotable,
    attach: (part: unknown) => log.push(["attach", part]),
    focus: (id?: string) => log.push(["focus", id]),
    setText: () => log.push(["setText"]),
    insert: () => log.push(["insert"]),
  }
  const host = {
    currentSessionID: () => current,
    screen: () => ({ composer }),
    openSession: (s: unknown) => log.push(["open", s]),
    routed: (id: string, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const check = () => (current === id || signal.aborted ? resolve() : waiters.push(check))
        signal.addEventListener("abort", () => resolve(), { once: true })
        check()
      }),
    signal: controller.signal,
  } as unknown as DiscussHost
  return { host, log, setCurrent, controller }
}

const input = (architectSessionID: string | null) => ({
  server: "srv",
  architectSessionID,
  quote,
  note,
})

describe("discussWithArchitect", () => {
  test("already routed attaches note then quote and focuses quote", async () => {
    const { host, log } = setup("arch")
    expect(await discussWithArchitect(host, input("arch"))).toBe("attached")
    expect(log).toEqual([
      ["attach", note],
      ["attach", quote],
      ["focus", "q1"],
    ])
  })

  test("worker routed opens Architect and attaches after the signal changes", async () => {
    const { host, log, setCurrent } = setup("worker")
    const pending = discussWithArchitect(host, input("arch"))
    await Promise.resolve()
    expect(log).toEqual([["open", { server: "srv", id: "arch" }]])
    setCurrent("arch")
    expect(await pending).toBe("attached")
    expect(log.map((e) => e[0])).toEqual(["open", "attach", "attach", "focus"])
    expect(log.some((e) => e[0] === "setText" || e[0] === "insert")).toBe(false)
  })

  test("no architect", async () => {
    const { host, log } = setup("worker")
    expect(await discussWithArchitect(host, input(null))).toBe("no-architect")
    expect(log).toEqual([])
  })

  test("cancelled when the host aborts before routing", async () => {
    const { host, log, controller } = setup("worker")
    const pending = discussWithArchitect(host, input("arch"))
    await Promise.resolve()
    controller.abort()
    expect(await pending).toBe("cancelled")
    expect(log.map((e) => e[0])).toEqual(["open"])
  })

  test("non-quotable composer gets one note with quoted lines", async () => {
    const { host, log } = setup("arch", false)
    expect(await discussWithArchitect(host, input("arch"))).toBe("attached")
    const attaches = log.filter((e) => e[0] === "attach")
    expect(attaches).toHaveLength(1)
    const attached = attaches[0]![1] as ComposerNote
    expect(attached.subject).toContain("pinned")
    expect(attached.subject).toContain("> a\n> b")
    expect(log.some((e) => e[0] === "setText" || e[0] === "insert")).toBe(false)
  })
})
