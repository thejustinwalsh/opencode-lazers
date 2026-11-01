import { expect, test } from "bun:test"
import { ReviewProgression } from "./progression.ts"
import type { ReviewDisposition, ReviewProgressionRecord, ReviewStage } from "./progression.ts"

interface HandoffDraft {
  target: string
  observedFailure: string
  preservedWork: string
}

interface HandoffCheck {
  id: string
  path: string
  guidance: string
}

interface HandoffFinding extends HandoffCheck {
  score: number | null
  disposition: ReviewDisposition
}

interface HandoffResult {
  fingerprint: string
  status: ReviewStage
  round: number
  findings: HandoffFinding[]
  focus: HandoffFinding | null
  next: { action: "revise_handoff" | "continue_recovery"; path?: string }
}

interface HandoffRecord extends ReviewProgressionRecord<HandoffFinding> {
  history: HandoffResult[]
}

const checks: HandoffCheck[] = [
  { id: "target", path: "target", guidance: "Preserve the original outcome." },
  { id: "failure", path: "observedFailure", guidance: "Describe the observed failure." },
  { id: "partial-work", path: "preservedWork", guidance: "Retain useful partial work." },
]

const policy = new ReviewProgression()

/** A non-task adapter fixture: it owns handoff content and routing, not progression. */
function reviewHandoff(
  draft: HandoffDraft,
  scores: Readonly<Record<string, number>>,
  record: HandoffRecord,
) {
  const fingerprint = JSON.stringify(draft)
  const replay = policy.inspect(record.history.at(-1), fingerprint, (result) =>
    result.status.startsWith("completed") ? "terminal" : "feedback",
  )
  if (replay.kind === "replay") return replay.result
  if (replay.kind === "stale") return { kind: "stale" as const }
  if (!policy.reserveRound(record)) return { kind: "exhausted" as const }

  const evaluated = policy.evaluate(
    checks,
    Object.fromEntries(checks.map((check) => [check.id, { score: scores[check.id] ?? null }])),
    record,
    false,
  )
  const findings = evaluated.findings
  const focus = evaluated.focus
  const result: HandoffResult = {
    fingerprint,
    status: evaluated.status,
    round: record.round,
    findings,
    focus,
    next: focus ? { action: "revise_handoff", path: focus.path } : { action: "continue_recovery" },
  }
  record.focus = focus?.id ?? null
  record.previous = findings
  record.completed = evaluated.completed
  record.history.push(result)
  return result
}

test("a non-task handoff fixture uses shared focused progression, regression checks, replay, and exhaustion", () => {
  const record: HandoffRecord = {
    round: 0,
    focus: null,
    previous: [],
    completed: {},
    history: [],
  }
  const firstDraft = {
    target: "Keep the authorized task outcome.",
    observedFailure: "The retry failed to load the saved configuration.",
    preservedWork: "The diagnostics remain useful.",
  }
  const first = reviewHandoff(
    firstDraft,
    { target: 0.2, failure: 0.95, "partial-work": 0.95 },
    record,
  )
  if (!("focus" in first) || !first.focus) throw Error("Expected focused handoff feedback")
  expect(first.status).toBe("feedback")
  expect(first.focus.id).toBe("target")
  expect(first.next).toEqual({ action: "revise_handoff", path: "target" })

  expect(reviewHandoff(firstDraft, {}, record)).toBe(first)
  expect(record.round).toBe(1)

  const second = reviewHandoff(
    { ...firstDraft, preservedWork: "Diagnostics and partial implementation are retained." },
    { target: 0.2, failure: 0.1, "partial-work": 0.95 },
    record,
  )
  if (!("findings" in second) || !second.focus) throw Error("Expected another handoff concern")
  expect(second.status).toBe("feedback")
  expect(second.findings[0]?.disposition).toBe("non_regressed")
  expect(second.findings[1]?.disposition).toBe("pending")
  expect(second.focus.id).toBe("failure")
  expect(second.next.path).toBe("observedFailure")

  const thirdDraft = { ...firstDraft, observedFailure: "The same reload failure remains." }
  const third = reviewHandoff(
    thirdDraft,
    { target: 0.2, failure: 0.05, "partial-work": 0.95 },
    record,
  )
  if (!("findings" in third)) throw Error("Expected final handoff findings")
  expect(third.status).toBe("completed_with_concerns")
  expect(third.round).toBe(3)
  expect(third.findings[0]?.disposition).toBe("non_regressed")
  expect(third.findings[1]?.disposition).toBe("limit")
  expect(third.next).toEqual({ action: "continue_recovery" })
  expect(reviewHandoff(thirdDraft, {}, record)).toBe(third)
  expect(reviewHandoff({ ...thirdDraft, preservedWork: "changed" }, {}, record)).toEqual({
    kind: "stale",
  })
  expect(record.round).toBe(3)
  expect(policy.reserveRound(record)).toBe(false)
})
