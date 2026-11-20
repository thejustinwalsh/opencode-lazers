import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, DateTime } from "effect"
import { nativeTrajectoryHost } from "./native.ts"
import type { HostMessageClient } from "../core/host-messages.ts"

function messageClient(reads: string[], options: { history?: unknown[]; fail?: Error } = {}) {
  return {
    message: {
      list: async (input: { sessionID: string; limit?: number; cursor?: string }) => {
        reads.push(`messages:${input.sessionID}`)
        if (options.fail) throw options.fail
        const all = options.history ?? []
        const limit = input.limit ?? 50
        const start = input.cursor ? Number(input.cursor) : 0
        const next = start + limit < all.length ? String(start + limit) : undefined
        return { data: all.slice(start, start + limit), cursor: { ...(next ? { next } : {}) } }
      },
    },
  } as unknown as HostMessageClient
}

const context = {
  session: {
    get: () =>
      Effect.succeed({
        id: "ses-owned",
        projectID: "project",
        parentID: "ses-owner",
        model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
        outcome: "succeeded",
        time: {
          created: DateTime.nowUnsafe(),
          updated: DateTime.nowUnsafe(),
          busy: undefined,
          idle: DateTime.nowUnsafe(),
        },
        tokens: { input: 12, output: 3, reasoning: 2, cache: { read: 4, write: 1 } },
      }),
  },
} as unknown as Plugin.Context

test("with a sink the transcript is handed over a page at a time and no message is kept", async () => {
  const reads: string[] = []
  const history = Array.from({ length: 10_050 }, (_, index) => ({ id: `m${index}`, type: "user" }))
  const host = nativeTrajectoryHost(
    context,
    "project",
    undefined,
    messageClient(reads, { history }),
  )
  const sizes: number[] = []
  let seen = 0
  const result = await host.session("ses-owned", undefined, (page) => {
    sizes.push(page.length)
    seen += page.length
  })
  expect(result?.messages).toBeNull()
  expect(result?.messageStatus).toBe("available")
  // The same one-past-the-bound read as without a sink, never more than a page at once.
  expect(seen).toBe(10_001)
  expect(Math.max(...sizes)).toBe(50)
  expect(reads).toHaveLength(Math.ceil(10_001 / 50))
})

test("a sink failure reaches the caller; a host read failure still reads as unavailable", async () => {
  const history = Array.from({ length: 120 }, (_, index) => ({ id: `m${index}`, type: "user" }))
  const broken = nativeTrajectoryHost(context, "project", undefined, messageClient([], { history }))
  let pages = 0
  await expect(
    broken.session("ses-owned", undefined, () => {
      pages++
      throw new Error("fold failed")
    }),
  ).rejects.toThrow("fold failed")
  // The remaining pages were not offered to a sink that had already failed.
  expect(pages).toBe(1)
  const down = nativeTrajectoryHost(
    context,
    "project",
    undefined,
    messageClient([], { fail: new Error("host down") }),
  )
  const result = await down.session("ses-owned", undefined, () => undefined)
  expect(result).toMatchObject({ messages: null, messageStatus: "unavailable" })
})
