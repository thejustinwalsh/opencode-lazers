import { expect, test } from "bun:test"
import { rpcStreamsTransport, type StreamsRpc } from "../streams/gui.ts"
import {
  isRadarLocationLoaded,
  matchRadarProject,
  radarLocationGuard,
  resolveRadarProject,
} from "./project.ts"

const signal = new AbortController().signal
const open = { stream: "s", source: "radar.sessions", filter: {}, order: "recent", window: 40 }

function spyRPC() {
  const calls: string[] = []
  const rpc = {
    open: async () => (calls.push("open"), { seq: 1, data: "" }),
    events: { subscribe: async function* () {} },
  } as unknown as StreamsRpc
  return { calls, rpc }
}

/** The Monitor's streams transport, guarded as the panel guards it (`panel.tsx`). */
const monitorTransport = (rpc: StreamsRpc, ready: () => Promise<boolean>) =>
  rpcStreamsTransport(() => rpc, signal, { location: { directory: "/work/p" }, ready })

test("an unloaded directory yields no location-scoped host call", async () => {
  const { calls, rpc } = spyRPC()
  const client = {
    debug: { location: { list: async () => [{ directory: "/other" }] } },
  }
  const guard = radarLocationGuard(client, "/work/project.worktrees/idle", () => "/work/project")
  await expect(monitorTransport(rpc, guard).open(open)).rejects.toThrow("not loaded")
  expect(calls).toEqual([])
  await expect(isRadarLocationLoaded(client, "/work/project.worktrees/idle")).resolves.toBe(false)
})

test("a loaded directory is read, and a host that cannot list locations is never booted", async () => {
  const { calls, rpc } = spyRPC()
  const loadedClient = { debug: { location: { list: async () => [{ directory: "/work/p/" }] } } }
  await monitorTransport(rpc, () => isRadarLocationLoaded(loadedClient, "/work/p")).open(open)
  expect(calls).toEqual(["open"])
  expect(await isRadarLocationLoaded({}, "/work/p")).toBe(false)
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
  expect(await resolveRadarProject(client, "/work/project.worktrees/leaf", signal)).toEqual({
    project: "/work/project",
    projectID: "wanted",
  })
  expect((await resolveRadarProject(client, "/elsewhere/sbx", signal)).projectID).toBe("wanted")
  expect(matchRadarProject(projects, "/work/projectile")).toBeUndefined()
  await expect(resolveRadarProject(client, "/nowhere", signal)).rejects.toThrow()
  expect(calls).not.toContain("location.get")
})

test("the viewed session directory proceeds with a GUI client that has no debug namespace", async () => {
  const { calls, rpc } = spyRPC()
  const gui = {}
  const viewed = "/work/project"
  const guard = radarLocationGuard(gui, viewed, () => viewed)
  await monitorTransport(rpc, guard).open(open)
  expect(calls).toEqual(["open"])

  // Any other directory fails closed: no debug API, or a failing listing.
  const other = "/work/project.worktrees/idle"
  expect(await radarLocationGuard(gui, other, () => viewed)()).toBe(false)
  const broken = { debug: { location: { list: async () => Promise.reject(new Error("x")) } } }
  expect(await radarLocationGuard(broken, other, () => viewed)()).toBe(false)
})
