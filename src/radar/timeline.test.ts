import { expect, test } from "bun:test"
import { ObservationChangeTracker } from "../observability/changes.ts"
import { ObservationReads } from "../observability/read.ts"
import type { SnapshotResponse } from "../observability/contract.ts"
import {
  makeFixture,
  firstAttemptID,
  secondAttemptID,
  taskID,
} from "../../test/trajectory/fixture.ts"
import { attemptKey, checkKey, timelineAttempts, timelineChecks } from "./projection.ts"
import { timePercent, timelineProjection } from "./timeline.ts"

function timelineFixture() {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(8)
  const reads = new ObservationReads(fixture.store, fixture.host, "project", secret)
  const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
  tracker.initialize()
  const base = reads.snapshot({ kind: "session", sessionID: "ses-failed" }, tracker)
  const plan = base.plans[0]!
  const snapshot = {
    ...base,
    observedAt: new Date(1_400).toISOString(),
    plans: base.plans.map((item) => ({
      ...item,
      nodes: item.nodes.map((node) => ({
        ...node,
        objective: "Recover task identity",
        state: "running",
        snapshot: { status: "active", value: "running" },
        snapshotMatchesState: true,
      })),
    })),
    transitions: base.transitions.map((transition, index) => ({
      ...transition,
      recordedAt: 1_050 + index * 50,
    })),
    attempts: [
      {
        id: firstAttemptID,
        planID: plan.id,
        taskID,
        number: 1,
        state: "running",
        startedAt: 1_050,
        endedAt: null,
        timingBasis: "Dispatch reservation start; no attempt end is inferred",
        executions: [
          {
            startedAt: 1_100,
            endedAt: null,
            startSequence: 2,
            endSequence: null,
            timingBasis: "WORKER_STARTED observed; no WORKER_STOPPED record",
          },
        ],
      },
      {
        id: secondAttemptID,
        planID: plan.id,
        taskID,
        number: 2,
        state: "accepted",
        startedAt: 1_250,
        endedAt: null,
        timingBasis: "Dispatch reservation start; no attempt end is inferred",
        executions: [
          {
            startedAt: null,
            endedAt: 1_200,
            startSequence: null,
            endSequence: 7,
            timingBasis: "WORKER_STOPPED observed without a matching start",
          },
        ],
      },
    ],
    checks: [
      {
        id: "check-known",
        planID: plan.id,
        taskID,
        attemptID: firstAttemptID,
        checkID: "bun-test",
        scope: "attempt",
        state: "completed",
        startedAt: 1_150,
        endedAt: 1_260,
        exitCode: 0,
        timingBasis: "Recorded verification receipt endpoints",
      },
      {
        id: "check-unknown",
        planID: plan.id,
        taskID,
        attemptID: null,
        checkID: "bun-lint",
        scope: "plan",
        state: "completed",
        startedAt: null,
        endedAt: 1_300,
        exitCode: 1,
        timingBasis: "Receipt start endpoint unavailable",
      },
    ],
  } as unknown as SnapshotResponse
  return { fixture, snapshot, plan: snapshot.plans[0]! }
}

test("Timeline projects only selected-plan attempts, executions, checks and ordered transitions", () => {
  const { fixture, snapshot, plan } = timelineFixture()
  try {
    const attempts = timelineAttempts(snapshot, plan.id)
    const checks = timelineChecks(snapshot, plan.id)
    expect(attempts.map(attemptKey)).toEqual([firstAttemptID, secondAttemptID])
    expect(checks.map(checkKey)).toEqual(["check-known", "check-unknown"])

    const projection = timelineProjection(snapshot, plan, true)
    expect(projection.startAt).toBe(1_050)
    expect(projection.endAt).toBe(1_400)
    expect(projection.lanes.map((lane) => lane.id)).toEqual([
      `plan:${plan.id}`,
      `attempt:${firstAttemptID}`,
      `attempt:${secondAttemptID}`,
      `task:${taskID}`,
    ])
    expect(projection.lanes[1]?.label).toBe("Recover task identity · attempt 1")
    const open = projection.lanes[1]?.marks.find((mark) => mark.kind === "execution")
    expect(open).toMatchObject({
      startAt: 1_100,
      endAt: null,
      displayEndAt: 1_400,
      openThroughObservation: true,
    })
    const check = projection.lanes[1]?.marks.find((mark) => mark.id === "check:check-known")
    expect(check).toMatchObject({ startAt: 1_150, endAt: 1_260, displayEndAt: 1_260 })
    const unknown = projection.lanes[3]?.marks.find((mark) => mark.id === "check:check-unknown")
    expect(unknown).toMatchObject({ startAt: null, endAt: 1_300, displayEndAt: 1_300 })
    expect(timePercent(1_225, projection)).toBeCloseTo(50)

    const unconfirmed = {
      ...snapshot,
      plans: snapshot.plans.map((item) => ({
        ...item,
        nodes: item.nodes.map((node) => ({ ...node, snapshotMatchesState: false })),
      })),
    } as unknown as SnapshotResponse
    expect(
      timelineProjection(unconfirmed, unconfirmed.plans[0]!, true).lanes[1]?.marks.find(
        (mark) => mark.kind === "execution",
      ),
    ).toMatchObject({ displayEndAt: null, openThroughObservation: false })

    const preparing = {
      ...snapshot,
      plans: snapshot.plans.map((item) => ({
        ...item,
        nodes: item.nodes.map((node) => ({
          ...node,
          state: "queued",
          snapshot: { status: "active", value: "queued" },
          snapshotMatchesState: true,
        })),
      })),
      attempts: timelineAttempts(snapshot, plan.id).map((attempt) => ({
        ...attempt,
        state: "preparing",
      })),
    } as unknown as SnapshotResponse
    expect(
      timelineProjection(preparing, preparing.plans[0]!, true).lanes[1]?.marks.find(
        (mark) => mark.kind === "execution",
      ),
    ).toMatchObject({ displayEndAt: null, openThroughObservation: false })

    const staleProjection = timelineProjection(snapshot, plan, false)
    expect(staleProjection.lanes[1]?.marks.find((mark) => mark.kind === "execution")).toMatchObject(
      {
        endAt: null,
        displayEndAt: null,
        openThroughObservation: false,
      },
    )
    expect(staleProjection.endAt).toBe(1_300)
  } finally {
    fixture.close()
  }
})

test("Timeline retains reversed recorded endpoints and unknown times without inventing dates", () => {
  const { fixture, snapshot, plan } = timelineFixture()
  try {
    const reversed = {
      ...snapshot,
      checks: [
        {
          id: "reversed",
          planID: plan.id,
          taskID,
          attemptID: firstAttemptID,
          checkID: "receipt",
          scope: "attempt",
          state: "completed",
          startedAt: 1_260,
          endedAt: 1_200,
          exitCode: 1,
          timingBasis: "Recorded reversed receipt endpoints",
        },
      ],
      attempts: [],
      transitions: [],
    } as unknown as SnapshotResponse
    const projection = timelineProjection(reversed, plan, false)
    expect(timelineChecks(reversed, plan.id)).toHaveLength(1)
    expect(projection.startAt).toBe(1_200)
    expect(projection.endAt).toBe(1_260)
    expect(projection.lanes[0]?.marks[0]).toMatchObject({
      startAt: 1_260,
      endAt: 1_200,
      displayEndAt: 1_200,
    })

    const empty = {
      ...reversed,
      checks: [
        {
          id: "no-times",
          planID: plan.id,
          taskID,
          attemptID: null,
          checkID: "unknown",
          scope: "plan",
          state: "unknown",
          startedAt: null,
          endedAt: null,
          exitCode: null,
          timingBasis: "No receipt endpoints",
        },
      ],
    } as unknown as SnapshotResponse
    const unknownProjection = timelineProjection(empty, plan, false)
    expect(unknownProjection.startAt).toBeNull()
    expect(unknownProjection.endAt).toBeNull()
    expect(unknownProjection.lanes[0]?.marks[0]?.startAt).toBeNull()
    expect(unknownProjection.lanes[0]?.marks[0]?.displayEndAt).toBeNull()
  } finally {
    fixture.close()
  }
})
