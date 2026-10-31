import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { TaskRepository } from "../storage.ts"
import { nativeHost } from "./native.ts"

test("native worktrees use the host lifecycle with the admitted ref and returned directory", async () => {
  let created: unknown
  let refreshed = false
  const host = nativeHost(
    {
      location: { directory: "/project", project: { id: "project" } },
      worktree: {
        create: (input: unknown) =>
          Effect.sync(() => {
            created = input
            return { directory: "/work/attempt-2" }
          }),
        refresh: () =>
          Effect.sync(() => {
            refreshed = true
          }),
        list: () => Effect.succeed([{ directory: "/work/attempt-2", strategy: "git" }]),
      },
    } as unknown as Plugin.Context,
    {} as TaskRepository,
  )
  expect(await host.worktree({ directory: "/work/attempt", base: "a".repeat(40) })).toBe(
    "/work/attempt-2",
  )
  expect(created).toEqual({
    projectID: "project",
    from: "/project",
    directory: "/work",
    name: "attempt",
    branch: "a".repeat(40),
  })
  expect(await host.worktrees()).toEqual(["/work/attempt-2"])
  expect(refreshed).toBe(true)
})
