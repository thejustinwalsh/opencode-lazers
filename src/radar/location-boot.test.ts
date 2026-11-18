import { expect, test } from "bun:test"
import { createRadarMonitorTransport } from "./monitor-transport.ts"
import {
  isRadarLocationLoaded,
  matchRadarProject,
  RadarLocationNotLoadedError,
  resolveRadarProject,
} from "./project.ts"
import { createRadarTransport } from "./transport.ts"

const scope = { kind: "project" } as never
const signal = new AbortController().signal

function spyRPC() {
  const calls: string[] = []
  const rpc = {
    snapshot: async () => (calls.push("snapshot"), {}),
    radar: async () => (calls.push("radar"), {}),
    liveRadar: async () => (calls.push("liveRadar"), {}),
    liveHistory: async () => (calls.push("liveHistory"), {}),
    events: { subscribe: async function* () {} },
  } as never
  return { calls, rpc }
}

test("an unloaded directory yields no location-scoped host call", async () => {
  const { calls, rpc } = spyRPC()
  const client = {
    debug: { location: { list: async () => [{ directory: "/other" }] } },
  }
  const loaded = () => isRadarLocationLoaded(client, "/work/project.worktrees/idle")
  const radar = createRadarTransport(
    () => rpc,
    "/work/project.worktrees/idle",
    () => true,
    "p",
    loaded,
  )
  const monitor = createRadarMonitorTransport(
    () => rpc,
    "/work/project.worktrees/idle",
    () => true,
    "p",
    loaded,
  )
  await expect(radar.snapshot(scope, signal)).rejects.toBeInstanceOf(RadarLocationNotLoadedError)
  await expect(radar.radar(scope, false, signal)).rejects.toBeInstanceOf(
    RadarLocationNotLoadedError,
  )
  await expect(monitor.liveRadar(scope, false, signal)).rejects.toBeInstanceOf(
    RadarLocationNotLoadedError,
  )
  await expect(monitor.liveHistory(scope, "ses", undefined, signal)).rejects.toBeInstanceOf(
    RadarLocationNotLoadedError,
  )
  expect(calls).toEqual([])
})

test("a loaded directory is read, and a host that cannot list locations is never booted", async () => {
  const { calls, rpc } = spyRPC()
  const loadedClient = { debug: { location: { list: async () => [{ directory: "/work/p/" }] } } }
  const transport = createRadarTransport(
    () => rpc,
    "/work/p",
    () => true,
    "p",
    () => isRadarLocationLoaded(loadedClient, "/work/p"),
  )
  await transport.snapshot(scope, signal)
  expect(calls).toEqual(["snapshot"])
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
