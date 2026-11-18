import { expect, test } from "bun:test"
import { observeRadarPulses, RadarPulseTracker } from "../../src/radar/pulse.ts"
import type { RadarMapEdge } from "../../src/radar/pulse.ts"

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
