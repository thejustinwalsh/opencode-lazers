import { expect, test } from "bun:test"
import { resolvePanelProject } from "./panel-project.ts"

test("a removed worker worktree resolves durable panel data through the canonical project", async () => {
  const calls: string[] = []
  const client = {
    location: {
      get: async () => {
        throw new Error("LocationNotFoundError")
      },
    },
    project: { list: async () => [{ id: "project", canonical: "/repo" }] },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        calls.push(sessionID)
        return { projectID: "project" }
      },
    },
  }
  const signal = new AbortController().signal
  expect(await resolvePanelProject(client, "/repo.worktrees/removed", signal, "worker")).toEqual({
    project: "/repo",
    projectID: "project",
  })
  expect(calls).toEqual([])
  expect(
    await resolvePanelProject(client, "/old-native-worktree/removed", signal, "historical-worker"),
  ).toEqual({ project: "/repo", projectID: "project" })
  expect(calls).toEqual(["historical-worker"])
})

test("an unowned historical directory cannot select another project's data", async () => {
  const client = {
    project: { list: async () => [{ id: "other", canonical: "/other" }] },
    session: { get: async () => ({ projectID: "missing" }) },
  }
  await expect(
    resolvePanelProject(client, "/old/removed", new AbortController().signal, "worker"),
  ).rejects.toThrow("No known OpenCode project owns")
})
