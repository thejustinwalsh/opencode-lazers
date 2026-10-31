import { expect, test } from "bun:test"
import {
  isOwnedOutcomeTranscript,
  isOwnedQueuedOutcome,
  parseOutcomeOwnership,
} from "../../src/runner/inbox.ts"
import type { OutcomeOwnership } from "../../src/runner/inbox.ts"

const ownership: OutcomeOwnership = {
  lazersKind: "runner-outcome",
  lazersProjectID: "project-a",
  lazersProjectDirectory: "/repo-a",
  lazersPlanID: "plan-a",
  lazersOutboxID: "outbox-a",
  lazersMessageID: "msg-a",
  lazersSessionID: "ses-architect-a",
  lazersStatus: "accepted",
  lazersVersion: 4,
}

test("only an exactly owned queued synthetic outcome is eligible for cancellation", () => {
  expect(
    isOwnedQueuedOutcome(
      { id: "msg-a", type: "synthetic", delivery: "queue", metadata: ownership },
      ownership,
    ),
  ).toBe(true)
  expect(
    isOwnedQueuedOutcome(
      { id: "msg-user", type: "user", delivery: "queue", metadata: ownership },
      ownership,
    ),
  ).toBe(false)
  expect(
    isOwnedQueuedOutcome(
      { id: "msg-a", type: "synthetic", delivery: "steer", metadata: ownership },
      ownership,
    ),
  ).toBe(false)
  expect(
    isOwnedQueuedOutcome(
      {
        id: "msg-a",
        type: "synthetic",
        delivery: "queue",
        metadata: { ...ownership, lazersPlanID: "foreign-plan" },
      },
      ownership,
    ),
  ).toBe(false)
  expect(
    isOwnedQueuedOutcome(
      { id: "msg-worker", type: "synthetic", delivery: "queue", metadata: { worker: true } },
      ownership,
    ),
  ).toBe(false)
})

test("transcript ownership is distinct from queued delivery and requires synthetic identity", () => {
  expect(
    isOwnedOutcomeTranscript({ id: "msg-a", type: "synthetic", metadata: ownership }, ownership),
  ).toBe(true)
  expect(
    isOwnedOutcomeTranscript({ id: "msg-a", type: "user", metadata: ownership }, ownership),
  ).toBe(false)
  expect(parseOutcomeOwnership({ ...ownership, lazersVersion: "4" })).toBeUndefined()
})
