import { expect, test } from "bun:test"
import type {
  ObservationChange,
  ObservationScope,
  SnapshotResponse,
} from "../../src/observability/contract.ts"
import { ObservationSyncState } from "../../src/observability/state.ts"

const scope: ObservationScope = { kind: "session", sessionID: "ses-a" }

function snapshot(projectID: string, targetScope: ObservationScope, eventSequence: number) {
  return {
    schemaVersion: 1,
    projectID,
    scope:
      targetScope.kind === "session"
        ? { kind: "session", sessionID: targetScope.sessionID }
        : { kind: "project" },
    observedAt: new Date(0).toISOString(),
    boundary: {
      repositoryVersion: 0,
      sourceRevision: 0,
      sourceFingerprint: "0".repeat(64),
      nativeRevision: 0,
      eventSequence,
      transitionSequence: 0,
    },
    machine: { id: "lazers-task", version: "lazers-task/1", initialState: "queued", states: [] },
    plans: [],
    unplannedTasks: [],
    transitions: [],
    attempts: [],
    checks: [],
  } as SnapshotResponse
}

function change(sequence: number, resnapshotRequired = false): ObservationChange {
  return {
    projectID: "project-a",
    sequence,
    repositoryVersion: 0,
    sourceRevision: 0,
    nativeRevision: 0,
    cause: "native",
    resnapshotRequired,
  }
}

test("scope switches and reconnects reject late snapshots from the previous generation", () => {
  const state = new ObservationSyncState()
  const first = state.connect("project-a", scope)
  expect(state.acceptSnapshot(first, snapshot("project-a", scope, 4))).toBe(true)
  const second = state.connect("project-a", { kind: "project", sessionID: "ses-a" })
  expect(state.acceptSnapshot(first, snapshot("project-a", scope, 5))).toBe(false)
  expect(state.acceptSnapshot(second, snapshot("project-a", scope, 5))).toBe(false)
  expect(
    state.acceptSnapshot(second, snapshot("project-a", { kind: "project", sessionID: "ses-a" }, 5)),
  ).toBe(true)
  const reconnected = state.reconnect()
  expect(
    state.acceptSnapshot(second, snapshot("project-a", { kind: "project", sessionID: "ses-a" }, 6)),
  ).toBe(false)
  expect(
    state.acceptSnapshot(
      reconnected,
      snapshot("project-a", { kind: "project", sessionID: "ses-a" }, 6),
    ),
  ).toBe(true)
})

test("duplicate and late events are ignored while gaps and live changes require resync", () => {
  const state = new ObservationSyncState()
  const generation = state.connect("project-a", scope)
  expect(state.acceptSnapshot(generation, snapshot("project-a", scope, 8))).toBe(true)
  expect(state.acceptChange(generation, "project-a", change(8))).toBe(false)
  expect(state.stale).toBe(false)
  expect(state.acceptChange(generation, "project-a", change(9))).toBe(true)
  expect(state.stale).toBe(true)
  expect(state.acceptChange(generation, "project-a", change(9))).toBe(false)
  expect(state.acceptChange(generation, "project-a", change(8))).toBe(false)
  expect(
    state.acceptChange(generation, "project-a", { ...change(10), projectID: "project-b" }),
  ).toBe(false)
  expect(state.acceptChange(generation, "project-a", change(11))).toBe(false)
  expect(state.acceptChange(generation, "project-a", change(12, true))).toBe(false)
  expect(state.acceptSnapshot(generation, snapshot("project-a", scope, 12))).toBe(true)
  expect(state.stale).toBe(false)
})
