import { expect, test } from "bun:test"
import { SchedulingNode, SchedulingSnapshot } from "./scheduling-contract.ts"

const emptySnapshot = {
  schemaVersion: 1,
  snapshotID: "b23f0a8c-1a2b-4d4b-9ced-ec749a175da5",
  repositoryVersion: 0,
  scope: { kind: "project", sessionID: "session" },
  observedAt: 0,
  coverage: {
    status: "complete",
    planCount: 0,
    coveredPlanCount: 0,
    nodeCount: 0,
    coveredNodeCount: 0,
    activeReservationCount: 0,
    reservationsComplete: true,
    reason: null,
  },
  next: { status: "none" },
  selectedTaskIDs: [],
  selectionComplete: true,
  plans: [],
}

test("scheduling observation timestamps are Unix milliseconds and preserve epoch zero", () => {
  expect(SchedulingSnapshot.parse(emptySnapshot).observedAt).toBe(0)
  expect(
    SchedulingSnapshot.safeParse({ ...emptySnapshot, observedAt: "1970-01-01T00:00:00.000Z" })
      .success,
  ).toBe(false)
  expect(
    SchedulingSnapshot.parse({ ...emptySnapshot, observedAt: 1_797_000_000_000 }).observedAt,
  ).toBe(1_797_000_000_000)
})

test("bounded blocker references report their observed count without breaking legacy nodes", () => {
  const base = {
    taskID: "00000000-0000-4000-8000-000000000001",
    title: "Blocked task",
    objective: "Blocked task",
    ordinal: 0,
    order: 0,
    lifecycle: "ready",
    decision: "waiting",
    reason: "A conflicting write scope is reserved.",
    prerequisites: [],
    waitingOn: [],
  }
  const references = Array.from(
    { length: 100 },
    (_, index) => `00000000-0000-4000-8000-${(index + 2).toString().padStart(12, "0")}`,
  )
  expect(
    SchedulingNode.parse({
      ...base,
      reservationTaskIDs: references,
      reservationTaskCount: 101,
      reservationTaskIDsComplete: false,
      reservationTaskIDsScopeLimited: false,
    }),
  ).toMatchObject({
    reservationTaskIDs: references,
    reservationTaskCount: 101,
    reservationTaskIDsComplete: false,
    reservationTaskIDsScopeLimited: false,
  })
  expect(
    SchedulingNode.safeParse({ ...base, reservationTaskIDs: [...references, references[0]] })
      .success,
  ).toBe(false)
  expect(SchedulingNode.parse({ ...base, reservationTaskIDs: [] }).reservationTaskIDsComplete).toBe(
    undefined,
  )
})
