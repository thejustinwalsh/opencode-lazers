import { expect, test } from "bun:test"
import { ObservationChangeTracker } from "../../src/observability/changes.ts"
import { operationalReads } from "./operational.ts"
import { measureRadarMap } from "../../src/radar/map-layout.ts"
import { createRadarMapModel } from "../../src/radar/map-model.ts"
import type { RadarMapEdge } from "../../src/radar/map-model.ts"
import { observeRadarPulses, RadarPulseTracker } from "../../src/radar/pulse.ts"
import { RadarLayoutCoordinator } from "../../src/radar/layout-state.ts"
import type { RadarLayoutInput, RadarLayoutResult } from "../../src/radar/layout-ipc.ts"
import { ScrollRestoration } from "../../src/radar/presentation.ts"
import { makeFixture } from "../trajectory/fixture.ts"

test("the map models actual scoped runtime, session, route and work records", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(8)
    const reads = operationalReads(fixture, "project", secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const scope = { kind: "session" as const, sessionID: "ses-failed" }
    const [radar, snapshot] = await Promise.all([
      reads.radar(
        { scope, includeUnmanagedSessions: false },
        tracker,
        new AbortController().signal,
      ),
      Promise.resolve(reads.snapshot(scope, tracker)),
    ])
    const model = createRadarMapModel(radar, snapshot)
    const kinds = new Set(model.nodes.map((node) => node.kind))
    expect(kinds).toContain("component")
    expect(kinds).toContain("session")
    expect(kinds).toContain("route")
    expect(kinds).toContain("plan")
    expect(kinds).toContain("task")
    expect(
      model.nodes.some((node) => node.record.kind === "session" && node.record.routes.length > 0),
    ).toBe(true)
    expect(
      model.nodes.some((node) => node.record.kind === "task" && node.record.objective !== null),
    ).toBe(true)
    expect(model.freshness).toEqual(radar.freshness)
    expect(model.coverage.includeUnmanagedSessions).toBe(false)
    expect(model.edges.every((edge) => edge.id.length > 0 && edge.from && edge.to)).toBe(true)
    expect(model.edges.some((edge) => edge.kind === "architecture")).toBe(true)
    expect(model.edges.some((edge) => edge.kind === "assignment")).toBe(true)
    expect(model.edges.some((edge) => edge.kind === "selected-route")).toBe(true)
    const plan = model.nodes.find((node) => node.kind === "plan")!
    expect(plan.related.some((id) => model.nodeByID.get(id)?.kind === "task")).toBe(true)
  } finally {
    fixture.close()
  }
})

test("same topology and text metrics reuse ELK geometry through status and activity changes", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(9)
    const reads = operationalReads(fixture, "project", secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const scope = { kind: "session" as const, sessionID: "ses-failed" }
    const radar = await reads.radar(
      { scope, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    )
    const firstModel = createRadarMapModel(radar)
    const changed = {
      ...radar,
      sessions: radar.sessions.map((session) => ({
        ...session,
        state: session.state === "busy" ? ("idle" as const) : session.state,
        updatedAt: (session.updatedAt ?? 0) + 1,
      })),
      edges: radar.edges.map((edge) => ({ ...edge, status: `${edge.status} updated` })),
    }
    const nextModel = createRadarMapModel(changed)
    const measure = (value: string) => [...value].length * 7
    const first = measureRadarMap(firstModel, "session:ses-failed", "host-font-v1", measure)
    const next = measureRadarMap(nextModel, "session:ses-failed", "host-font-v1", measure)
    expect(next.input.key).toBe(first.input.key)
    expect(next.input.nodes).toEqual(first.input.nodes)
    expect(next.input.edges).toEqual(first.input.edges)

    const calls: RadarLayoutInput[] = []
    const coordinator = new RadarLayoutCoordinator()
    const layout = {
      layout: async (input: RadarLayoutInput): Promise<RadarLayoutResult> => {
        calls.push(input)
        return {
          key: input.key,
          width: 640,
          height: 420,
          groups: input.groups.map((group, index) => ({
            id: group.id,
            x: index * 200,
            y: 0,
            width: group.width,
            height: group.height,
          })),
          nodes: input.nodes.map((node, index) => ({
            id: node.id,
            x: index * 30,
            y: index * 24,
            width: node.width,
            height: node.height,
          })),
          edges: [],
          elapsedMs: 1,
          workerThreadId: 1,
        }
      },
    }
    const controller = new AbortController()
    const positioned = await coordinator.layout(first.input, layout, controller.signal)
    const selectedID = firstModel.nodes.find((node) => node.kind === "session")!.id
    const visual = { scrollTop: 132 }
    const scheduled: Array<() => void> = []
    const restore = new ScrollRestoration((callback) => scheduled.push(callback))
    restore.restore("session:map", true, visual, 132)
    scheduled.shift()?.()
    const unchanged = await coordinator.layout(next.input, layout, controller.signal)
    restore.restore("session:map", true, visual, 999)
    scheduled.shift()?.()
    expect(unchanged).toBe(positioned)
    expect(unchanged?.nodes).toEqual(positioned?.nodes)
    expect(calls).toHaveLength(1)
    expect(nextModel.nodeByID.has(selectedID)).toBe(true)
    expect(selectedID).toStartWith("session:")
    expect(visual.scrollTop).toBe(132)

    const longLabel = "x".repeat(500)
    const firstNode = firstModel.nodes[0]!
    const longModel = {
      ...firstModel,
      nodes: [{ ...firstNode, label: longLabel }, ...firstModel.nodes.slice(1)],
    }
    const narrow = measureRadarMap(longModel, "session:ses-failed", "host-font-v1", measure)
    expect(narrow.input.nodes[0]?.width).toBeLessThanOrEqual(304)
    expect(narrow.text.get(firstNode.id)?.label.every((line) => measure(line) <= 272)).toBe(true)
  } finally {
    fixture.close()
  }
})

test("topology, font metrics and scope changes produce distinct measured layout keys", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(12)
    const reads = operationalReads(fixture, "project", secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const scope = { kind: "session" as const, sessionID: "ses-failed" }
    const radar = await reads.radar(
      { scope, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    )
    const model = createRadarMapModel(radar)
    const measure = (value: string) => [...value].length * 7
    const baseline = measureRadarMap(model, "session:ses-failed", "font-a", measure)
    const font = measureRadarMap(model, "session:ses-failed", "font-b", measure)
    const scopeChange = measureRadarMap(model, "project:project", "font-a", measure)
    const topology = createRadarMapModel({ ...radar, edges: radar.edges.slice(1) })
    const topologyChange = measureRadarMap(topology, "session:ses-failed", "font-a", measure)
    expect(
      new Set([baseline.input.key, font.input.key, scopeChange.input.key, topologyChange.input.key])
        .size,
    ).toBe(4)
  } finally {
    fixture.close()
  }
})

test("activity pulses consume only new live event IDs once and suppress stale motion", () => {
  const edge = {
    id: "map-edge:outcome",
    kind: "outcome",
    from: "session:worker",
    to: "component:runner",
    status: "succeeded",
    records: [],
    evidence: [],
    routeRecords: [],
    related: [],
    pulseEventIDs: ["evt-new"],
  } satisfies RadarMapEdge
  const seen = new Set<string>()
  expect(observeRadarPulses([edge], seen, false)).toEqual([])
  expect(observeRadarPulses([edge], seen, true)).toEqual([])
  const next = { ...edge, pulseEventIDs: ["evt-new", "evt-live"] }
  expect(observeRadarPulses([next], seen, true)).toEqual([{ edgeID: edge.id, eventID: "evt-live" }])
  expect(observeRadarPulses([next], seen, true)).toEqual([])
  expect(
    observeRadarPulses([{ ...next, kind: "dependency", pulseEventIDs: [] }], seen, true),
  ).toEqual([])
})

test("reconnect establishes a quiet pulse baseline before later live events animate", () => {
  const edge = {
    id: "map-edge:outcome",
    kind: "outcome",
    from: "session:worker",
    to: "component:runner",
    status: "succeeded",
    records: [],
    evidence: [],
    routeRecords: [],
    related: [],
    pulseEventIDs: ["evt-before-reconnect"],
  } satisfies RadarMapEdge
  const tracker = new RadarPulseTracker()
  expect(tracker.update([edge], false, true)).toEqual([])
  expect(tracker.update([edge], true, true)).toEqual([])
  const reconnectSnapshot = { ...edge, pulseEventIDs: [...edge.pulseEventIDs, "evt-during-gap"] }
  expect(tracker.update([reconnectSnapshot], false, true)).toEqual([])
  const later = { ...edge, pulseEventIDs: [...reconnectSnapshot.pulseEventIDs, "evt-new"] }
  expect(tracker.update([later], false, true)).toEqual([{ edgeID: edge.id, eventID: "evt-new" }])
})
