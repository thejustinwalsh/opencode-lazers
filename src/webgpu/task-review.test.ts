import { expect, test } from "bun:test"
import { validProposal } from "../../test/proposal.ts"
import { TaskReviewer } from "./task-review.ts"
import type { ReviewInput, ReviewStore } from "./task-review.ts"
import { reviewChecks } from "./review-questions.ts"
import { SystemOneRequest } from "./system-one.ts"
import type { SystemOneInput, SystemOneOutput } from "./system-one.ts"

const draft = (): ReviewInput => ({
  task: validProposal(),
  request: "Keep submitted tasks after the plugin restarts",
  evidence: [],
})
const memory = () => {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async (key: string) => structuredClone(data.get(key)),
    set: async (key: string, value: unknown) => {
      data.set(key, structuredClone(value))
    },
  } satisfies ReviewStore & { data: Map<string, unknown> }
}
function reply(input: SystemOneInput, score: (id: string) => number = () => 0.95): SystemOneOutput {
  const request = SystemOneRequest.parse(input)
  const checks = reviewChecks((request.state as { task: ReturnType<typeof validProposal> }).task)
  return {
    model: "d1-omni-2b",
    usage: { input_tokens: 123, output_tokens: 0 },
    answers: Object.fromEntries(
      Object.keys(request.questions).map((id) => {
        const check = checks.find((check) => check.id === id)
        return [
          id,
          {
            type: "noul",
            noul: check ? (check.goodWhen === "yes" ? score(id) : 1 - score(id)) : 0.05,
          },
        ]
      }),
    ),
  }
}

test("structural errors and oversized tasks never invoke the model or save a review", async () => {
  const store = memory()
  let calls = 0
  const reviewer = new TaskReviewer(store, {
    systemOne: async (input) => {
      calls++
      return reply(input)
    },
  })
  const invalid = draft()
  invalid.task.verification = []
  expect((await reviewer.verify(invalid, "owner", AbortSignal.timeout(1000))).status).toBe(
    "invalid",
  )
  const large = draft()
  large.task.context.push({ reference: "a".repeat(8000), revision: null })
  expect((await reviewer.verify(large, "owner", AbortSignal.timeout(1000))).status).toBe("invalid")
  expect(calls).toBe(0)
  expect(store.data.size).toBe(0)
})

test("one focused concern advances on equal score after a changed-state repair, retaining the concern", async () => {
  const input = draft()
  const firstCheck = reviewChecks(input.task)[0]!.id
  const store = memory()
  let calls = 0
  const reviewer = new TaskReviewer(store, {
    systemOne: async (request) => {
      calls++
      return reply(request, (id) => (id === firstCheck ? 0.2 : 0.95))
    },
  })
  const first = await reviewer.verify(input, "owner", new AbortController().signal)
  expect(first.status).toBe("feedback")
  if (!("focus" in first) || !first.focus) throw Error("Expected focus")
  expect(first.focus.id).toBe(firstCheck)
  const repeated = await reviewer.verify(
    { ...input, reviewID: first.reviewID },
    "owner",
    new AbortController().signal,
  )
  expect(repeated).toEqual(first)
  expect(calls).toBe(1)
  const repaired = await reviewer.verify(
    {
      ...input,
      evidence: ["Recorded clarification about restart behavior."],
      reviewID: first.reviewID,
    },
    "owner",
    new AbortController().signal,
  )
  expect(repaired.status).toBe("completed_with_concerns")
  if (!("findings" in repaired)) throw Error("Expected findings")
  expect(repaired.findings[0]?.disposition).toBe("non_regressed")
  expect(repaired.round).toBe(2)
  expect(repaired.next.action).toBe("submit")
  expect(store.data.size).toBe(1)
})

test("three worsening rounds continue with concerns; restart preserves budget, terminal replay and stale-draft protection", async () => {
  const input = draft()
  const target = reviewChecks(input.task)[0]!.id
  const store = memory()
  let calls = 0
  const transport = {
    systemOne: async (request: SystemOneInput) =>
      reply(request, (id) => (id === target ? [0.2, 0.1, 0.05][calls++]! : 0.95)),
  }
  const first = await new TaskReviewer(store, transport).verify(
    input,
    "owner",
    new AbortController().signal,
  )
  if (!("reviewID" in first)) throw Error("Expected review")
  const second = await new TaskReviewer(store, transport).verify(
    { ...input, reviewID: first.reviewID, evidence: ["Revision two"] },
    "owner",
    new AbortController().signal,
  )
  expect(second.status).toBe("feedback")
  const finalInput = { ...input, reviewID: first.reviewID, evidence: ["Revision three"] }
  const third = await new TaskReviewer(store, transport).verify(
    finalInput,
    "owner",
    new AbortController().signal,
  )
  expect(third.status).toBe("completed_with_concerns")
  if (!("findings" in third)) throw Error("Expected findings")
  expect(third.round).toBe(3)
  expect(third.findings[0]?.disposition).toBe("limit")
  expect(
    await new TaskReviewer(store, transport).verify(
      finalInput,
      "owner",
      new AbortController().signal,
    ),
  ).toEqual(third)
  expect(
    (
      await new TaskReviewer(store, transport).verify(
        { ...finalInput, evidence: ["Unreviewed fourth draft"] },
        "owner",
        new AbortController().signal,
      )
    ).status,
  ).toBe("stale")
  expect(calls).toBe(3)
})

test("later revisions reopen regressed checks and return only the next focused correction", async () => {
  const input = draft()
  const checks = reviewChecks(input.task)
  const first = checks[0]!.id
  const verification = checks.find((check) => check.family === "verification")!.id
  let round = 0
  const reviewer = new TaskReviewer(memory(), {
    systemOne: async (request) => {
      round++
      return reply(request, (id) =>
        id === first ? (round === 1 ? 0.2 : 0.3) : id === verification && round > 1 ? 0.1 : 0.95,
      )
    },
  })
  const a = await reviewer.verify(input, "owner", new AbortController().signal)
  if (!("reviewID" in a)) throw Error("Expected review")
  const b = await reviewer.verify(
    { ...input, reviewID: a.reviewID, evidence: ["Changed draft"] },
    "owner",
    new AbortController().signal,
  )
  if (!("focus" in b)) throw Error("Expected focus")
  expect(b.focus?.id).toBe(verification)
  expect(b.next.action).toBe("revise_or_clarify")
})

test("inference errors remain explicit and may retry identical state within the same three-round bound", async () => {
  const store = memory()
  const reviewer = new TaskReviewer(store, {
    systemOne: async () => ({ error: "GPU unavailable" }),
  })
  const input = draft()
  const one = await reviewer.verify(input, "owner", new AbortController().signal)
  expect(one.status).toBe("unavailable")
  if (!("reviewID" in one)) throw Error("Expected review")
  const resumed = { ...input, reviewID: one.reviewID }
  await reviewer.verify(resumed, "owner", new AbortController().signal)
  const three = await reviewer.verify(resumed, "owner", new AbortController().signal)
  expect(three.status).toBe("completed_with_concerns")
  if (!("findings" in three)) throw Error("Expected findings")
  expect(three.errors).toEqual(["GPU unavailable"])
  expect(
    three.findings.every(
      (finding) => finding.probability === null && finding.disposition === "limit",
    ),
  ).toBe(true)
})

test("review IDs are scoped and concurrent resumptions cannot consume another round", async () => {
  const store = memory()
  let release!: () => void
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const reviewer = new TaskReviewer(store, {
    systemOne: async (input) => {
      started()
      await wait
      return reply(input)
    },
  })
  const pending = reviewer.verify(draft(), "owner", new AbortController().signal)
  await entered
  const id = [...store.data.keys()][0]!.slice("task-review.".length)
  expect(
    (await reviewer.verify({ ...draft(), reviewID: id }, "owner", new AbortController().signal))
      .status,
  ).toBe("busy")
  release()
  await pending
  expect(
    (
      await reviewer.verify(
        { ...draft(), reviewID: id },
        "another session",
        new AbortController().signal,
      )
    ).status,
  ).toBe("invalid")
  expect(
    (
      await reviewer.verify(
        { ...draft(), reviewID: id, request: "Invented new intent" },
        "owner",
        new AbortController().signal,
      )
    ).status,
  ).toBe("invalid")
})

test("one review round splits a larger question collection into bounded complete batches", async () => {
  const input = draft()
  input.task.acceptance = Array.from({ length: 12 }, (_, index) => ({
    id: `criterion-${index}`,
    assertion: `Reopening retrieves task example ${index}`,
    evidence: [{ kind: "verification" as const, verificationID: "tests" }],
  }))
  let calls = 0
  const reviewer = new TaskReviewer(memory(), {
    systemOne: async (request) => {
      calls++
      expect(Object.keys(request.questions).length).toBeLessThanOrEqual(16)
      expect(JSON.stringify(request).length).toBeLessThanOrEqual(8000)
      expect((request.state as { task: unknown }).task).toEqual(input.task)
      return reply(request)
    },
  })
  const result = await reviewer.verify(input, "owner", new AbortController().signal)
  expect(calls).toBeGreaterThan(1)
  expect(result.status).toBe("completed")
  if (!("findings" in result)) throw Error("Expected findings")
  expect(result.findings).toHaveLength(reviewChecks(input.task).length)
  expect(result.round).toBe(1)
})

test("interrupted attempts retain their reserved rounds and exhaust with an explicit limitation", async () => {
  const backing = memory()
  let now = 0
  let failCompletion = true
  let calls = 0
  const reviewer = new TaskReviewer(
    {
      get: backing.get,
      set: async (key, value) => {
        if (failCompletion && (value as { busyUntil: number }).busyUntil === 0)
          throw Error("Interrupted final storage write")
        await backing.set(key, value)
      },
    },
    {
      systemOne: async (request) => {
        calls++
        return reply(request)
      },
    },
    () => now,
  )
  const input = draft()
  await expect(reviewer.verify(input, "owner", new AbortController().signal)).rejects.toThrow(
    "Interrupted",
  )
  const id = [...backing.data.keys()][0]!.slice("task-review.".length)
  const resumed = { ...input, reviewID: id }
  expect((await reviewer.verify(resumed, "owner", new AbortController().signal)).status).toBe(
    "busy",
  )
  for (let round = 2; round <= 3; round++) {
    now += 120_001
    await expect(reviewer.verify(resumed, "owner", new AbortController().signal)).rejects.toThrow(
      "Interrupted",
    )
  }
  now += 120_001
  failCompletion = false
  const result = await reviewer.verify(resumed, "owner", new AbortController().signal)
  expect(calls).toBe(3)
  expect(result.status).toBe("completed_with_concerns")
  if (!("findings" in result)) throw Error("Expected findings")
  expect(
    result.findings.every(
      (finding) => finding.probability === null && finding.disposition === "limit",
    ),
  ).toBe(true)
  expect(result.errors[0]).toContain("interrupted")
})
