import { matchPanelProject, resolvePanelProject } from "../panel-project.ts"
import { expect, test } from "bun:test"
import { rpcStreamsTransport, type StreamsRpc } from "../streams/gui.ts"

const signal = new AbortController().signal
const open = { stream: "s", source: "radar.sessions", filter: {}, order: "recent", window: 40 }

function spyRPC() {
  const calls: string[] = []
  const rpc = {
    open: async (_input: unknown, options: { location: { directory: string } }) => (
      calls.push(options.location.directory),
      { seq: 1, data: "" }
    ),
    events: { subscribe: async function* () {} },
  } as unknown as StreamsRpc
  return { calls, rpc }
}

test("an unloaded worker routes observation to the canonical project without booting the worktree", async () => {
  const { calls, rpc } = spyRPC()
  const client = {
    project: { list: async () => [{ id: "project", canonical: "/work/project" }] },
    location: {
      get: async () => {
        throw new Error("Retired location must not be opened")
      },
    },
  }
  const project = await resolvePanelProject(client, "/work/project.worktrees/removed", signal)
  await rpcStreamsTransport(() => rpc, signal, { location: { directory: project.project } }).open(
    open,
  )
  expect(calls).toEqual(["/work/project"])
})

test("a canonical project remains readable without a debug location inventory", async () => {
  const { calls, rpc } = spyRPC()
  const client = { project: { list: async () => [{ id: "project", canonical: "/work/p" }] } }
  const project = await resolvePanelProject(client, "/work/p", signal)
  await rpcStreamsTransport(() => rpc, signal, { location: { directory: project.project } }).open(
    open,
  )
  expect(calls).toEqual(["/work/p"])
})

test("project identity resolves by path from the global list without location.get", async () => {
  const calls: string[] = []
  const projects = [
    { id: "short", canonical: "/work/p" },
    { id: "wanted", canonical: "/work/project", sandboxes: ["/elsewhere/sbx"] },
  ]
  const client = {
    location: { get: async () => (calls.push("location.get"), {}) },
    project: { list: async () => (calls.push("project.list"), projects) },
  }
  expect(await resolvePanelProject(client, "/work/project.worktrees/leaf", signal)).toEqual({
    project: "/work/project",
    projectID: "wanted",
  })
  expect((await resolvePanelProject(client, "/elsewhere/sbx", signal)).projectID).toBe("wanted")
  expect(matchPanelProject(projects, "/work/projectile")).toBeUndefined()
  await expect(resolvePanelProject(client, "/nowhere", signal)).rejects.toThrow()
  expect(calls).not.toContain("location.get")
})

test("an unowned directory does not open another project's observation streams", async () => {
  const { calls, rpc } = spyRPC()
  const client = { project: { list: async () => [{ id: "project", canonical: "/work/project" }] } }
  await expect(
    (async () => {
      const project = await resolvePanelProject(client, "/unowned", signal)
      return rpcStreamsTransport(() => rpc, signal, {
        location: { directory: project.project },
      }).open(open)
    })(),
  ).rejects.toThrow("No known OpenCode project owns")
  expect(calls).toEqual([])
})
