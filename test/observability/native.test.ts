import { expect, test } from "bun:test"
import { Session } from "@opencode/schema/session"
import { DateTime, Effect } from "effect"
import { assertHostListQuery } from "../host-list-fake.ts"
import { createRadarSessionHost, nativeRadarSessionHost } from "../../src/observability/native.ts"

function sessionInfo(
  id: string,
  options: { projectID?: string; parentID?: string | null; archived?: boolean } = {},
) {
  return {
    id,
    projectID: options.projectID ?? "project",
    parentID: options.parentID ?? null,
    agent: "architect",
    model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
    time: {
      created: DateTime.makeUnsafe(1_000),
      updated: DateTime.makeUnsafe(2_000),
      busy: DateTime.makeUnsafe(1_500),
      idle: DateTime.makeUnsafe(1_400),
      ...(options.archived ? { archived: DateTime.makeUnsafe(2_100) } : {}),
    },
    location: { directory: "/workspace/project" },
  } as unknown as Session.Info
}

test("native radar inventory filters foreign projects and remains page- and cursor-bounded", async () => {
  const requests: Array<{ limit: number; archived: boolean; cursor?: string }> = []
  const entries = [
    sessionInfo("same-a"),
    sessionInfo("foreign", { projectID: "other-project" }),
    sessionInfo("same-b"),
    sessionInfo("archived", { archived: true }),
  ]
  const host = createRadarSessionHost({
    list: async (request) => {
      requests.push({
        limit: request.limit,
        archived: request.archived,
        ...(request.cursor ? { cursor: String(request.cursor) } : {}),
      })
      const archived = entries.filter((item) => Boolean(item.time.archived) === request.archived)
      const offset = request.cursor ? Number(String(request.cursor).split(":")[1]) : 0
      const data = archived.slice(offset, offset + request.limit)
      const nextOffset = offset + data.length
      return {
        data,
        cursor:
          nextOffset < archived.length
            ? { next: `cursor:${nextOffset}` as Session.ListCursor }
            : {},
      }
    },
    get: async () => null,
  })

  const result = await host.project("project", true, 4, new AbortController().signal)
  expect(result.sessions.map((session) => session.id)).toEqual(["same-a", "same-b", "archived"])
  expect(result.truncated).toBe(false)
  expect(result.sessions.find((session) => session.id === "archived")?.archived).toBe(true)
  expect(requests).toEqual([
    { limit: 4, archived: false },
    { limit: 2, archived: true },
  ])
  requests.length = 0

  const bounded = await host.project("project", true, 2, new AbortController().signal)
  expect(bounded.sessions.map((session) => session.id)).toEqual(["same-a", "same-b"])
  expect(bounded.truncated).toBe(true)
  expect(requests).toEqual([
    { limit: 2, archived: false },
    { limit: 1, archived: false, cursor: "cursor:2" },
  ])
  expect(bounded.sessions[0]).toMatchObject({
    projectID: "project",
    agent: "architect",
    model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
    busy: true,
    archived: false,
  })
})

test("native inventory terminates repeated cursors and forwards cancellation", async () => {
  let repeatedCursorCalls = 0
  const repeated = createRadarSessionHost({
    list: async () => {
      repeatedCursorCalls++
      return { data: [], cursor: { next: "cursor-loop" as Session.ListCursor } }
    },
    get: async () => null,
  })
  const bounded = await repeated.project("project", false, 10, new AbortController().signal)
  expect(repeatedCursorCalls).toBe(2)
  expect(bounded).toEqual({ sessions: [], truncated: true })

  let abortedSignal: AbortSignal | undefined
  const controller = new AbortController()
  const cancellable = createRadarSessionHost({
    list: async (_request, signal) => {
      abortedSignal = signal
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    },
    get: async () => null,
  })
  const inventory = cancellable.project("project", false, 10, controller.signal)
  controller.abort(new DOMException("Cancelled", "AbortError"))
  await expect(inventory).rejects.toThrow("Cancelled")
  expect(abortedSignal).toBe(controller.signal)
})

test("native direct reads convert not-found to absence and preserve other failures", async () => {
  const host = createRadarSessionHost({
    list: async () => ({ data: [], cursor: {} }),
    get: async (id) => {
      if (id === "missing") throw { _tag: "SessionNotFoundError" }
      if (id === "broken") throw new Error("native read failed")
      return sessionInfo(id)
    },
  })
  const signal = new AbortController().signal
  expect(await host.get("missing", signal)).toBeNull()
  expect(await host.get("available", signal)).toMatchObject({ id: "available", busy: true })
  await expect(host.get("broken", signal)).rejects.toThrow("native read failed")
})

test("native radar session listing sends the order on the first page and only the cursor after it", async () => {
  const queries: Array<Record<string, unknown>> = []
  const ctx = {
    session: {
      list: (query: { cursor?: string; order?: string }) => {
        assertHostListQuery(query)
        queries.push(query)
        return Effect.succeed({
          data: [],
          cursor: query.cursor ? {} : { next: "cursor:1" as Session.ListCursor },
        })
      },
      get: () => Effect.die("unused"),
    },
  } as unknown as Parameters<typeof nativeRadarSessionHost>[0]
  const host = nativeRadarSessionHost(ctx)
  await host.project("project", false, 5, new AbortController().signal)
  expect(queries.map((query) => [query.order, query.cursor])).toEqual([
    ["desc", undefined],
    [undefined, "cursor:1"],
  ])
})
