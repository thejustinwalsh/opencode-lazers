import { expect, test } from "bun:test"
import { validProposal } from "../../test/proposal.ts"
import { TaskReviewer } from "./task-review.ts"
import type { ReviewInput, ReviewStore } from "./task-review.ts"
import { reviewChecks, reviewQuestions } from "./review-questions.ts"
import { SYSTEM_ONE_TRANSPORT_MAX_CHARS, SystemOneRequest } from "./system-one.ts"
import type { SystemOneInput, SystemOneOutput } from "./system-one.ts"

const draft = (): ReviewInput => ({
  task: validProposal(),
  request: "Keep submitted tasks after the plugin restarts",
  evidence: [],
})

test("self-review questions cover unnecessary requirements and repetition as well as completeness", () => {
  const checks = reviewChecks(validProposal())
  expect(checks.some((c) => c.question.includes("unsupported by the recorded intent"))).toBe(true)
  expect(checks.some((c) => c.question.includes("repeat instructions"))).toBe(true)
  expect(checks.find((c) => c.question.includes("repeat instructions"))!.guidance).toContain(
    "preserving necessary requirements",
  )
})

test("System One separates its transport envelope from measured token capacity", () => {
  const makeRequest = (instructions: string) => ({
    model: "d1-omni-2b" as const,
    state: "",
    questions: { q: { type: "noul" as const, instructions } },
    timeoutMs: 60_000,
  })
  const empty = makeRequest("")
  const exact = makeRequest(
    "x".repeat(SYSTEM_ONE_TRANSPORT_MAX_CHARS - JSON.stringify(empty).length),
  )
  expect(JSON.stringify(exact)).toHaveLength(SYSTEM_ONE_TRANSPORT_MAX_CHARS)
  expect(SystemOneRequest.parse(exact)).toMatchObject({
    state: exact.state,
    questions: exact.questions,
  })

  const oversized = makeRequest(
    "x".repeat(SYSTEM_ONE_TRANSPORT_MAX_CHARS - JSON.stringify(empty).length + 1),
  )
  const rejected = SystemOneRequest.safeParse(oversized)
  expect(rejected.success).toBe(false)
  if (!rejected.success)
    expect(rejected.error.issues.map((issue) => issue.message).join(" ")).toContain(
      "serialized transport envelope",
    )
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
  large.task.context = Array.from({ length: 10 }, () => ({
    reference: "a".repeat(8_000),
    revision: null,
  }))
  expect((await reviewer.verify(large, "owner", AbortSignal.timeout(1000))).status).toBe("invalid")
  expect(calls).toBe(0)
  expect(store.data.size).toBe(0)
})

test("task adapter preserves its storage key, record/history shape, and result fields", async () => {
  const store = memory()
  const reviewer = new TaskReviewer(store, {
    systemOne: async (request) => reply(request),
  })
  const result = await reviewer.verify(draft(), "owner", new AbortController().signal)
  if (!("reviewID" in result)) throw Error("Expected task review result")

  expect([...store.data.keys()]).toEqual([`task-review.${result.reviewID}`])
  const saved = store.data.get(`task-review.${result.reviewID}`) as Record<string, unknown>
  expect(Object.keys(saved).sort()).toEqual(
    [
      "version",
      "owner",
      "request",
      "round",
      "busyUntil",
      "focus",
      "previous",
      "completed",
      "history",
    ].sort(),
  )
  expect(Object.keys(result).sort()).toEqual(
    [
      "status",
      "reviewID",
      "version",
      "round",
      "maxRounds",
      "fingerprint",
      "model",
      "answers",
      "findings",
      "focus",
      "errors",
      "usage",
      "next",
    ].sort(),
  )
  const history = saved.history as Array<Record<string, unknown>>
  expect(history).toHaveLength(1)
  expect(Object.keys(history[0]!).sort()).toEqual(["result", "state"])
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
  if (!("usage" in one)) throw Error("Expected review result")
  expect(one.usage).toEqual({ input_tokens: null, output_tokens: 0 })
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
  const expectedState = {
    task: input.task,
    intent: { request: input.request },
    evidence: input.evidence ?? [],
  }
  const expectedQuestions = reviewQuestions(reviewChecks(input.task))
  const seenQuestions: Record<string, (typeof expectedQuestions)[string]> = {}
  let calls = 0
  const reviewer = new TaskReviewer(memory(), {
    systemOne: async (request) => {
      calls++
      expect(Object.keys(request.questions).length).toBeLessThanOrEqual(16)
      expect(JSON.stringify(request).length).toBeLessThanOrEqual(SYSTEM_ONE_TRANSPORT_MAX_CHARS)
      expect(request.state).toEqual(expectedState)
      for (const [name, question] of Object.entries(request.questions)) {
        expect(Object.hasOwn(seenQuestions, name)).toBe(false)
        seenQuestions[name] = question
      }
      return reply(request)
    },
  })
  const result = await reviewer.verify(input, "owner", new AbortController().signal)
  expect(calls).toBeGreaterThan(1)
  expect(result.status).toBe("completed")
  if (!("findings" in result)) throw Error("Expected findings")
  expect(result.findings).toHaveLength(reviewChecks(input.task).length)
  expect(seenQuestions).toEqual(expectedQuestions)
  expect(Object.keys(seenQuestions)).toHaveLength(Object.keys(expectedQuestions).length)
  expect(result.round).toBe(1)
})

test("a 7,026-character shared state and 14 checks stay intact in one transport job", async () => {
  const input = draft()
  input.task.acceptance = Array.from({ length: 2 }, (_, index) => ({
    id: `criterion-${index}`,
    assertion: `The task review preserves behavior ${index}`,
    evidence: [{ kind: "verification" as const, verificationID: "tests" }],
  }))
  input.task.assumptions = ["The stated repository boundary is intentional."]
  const stateWithTwoEmptyEvidence = {
    task: input.task,
    intent: { request: input.request },
    evidence: ["", ""] as string[],
  }
  const evidenceCharacters = 7_026 - JSON.stringify(stateWithTwoEmptyEvidence).length
  expect(evidenceCharacters).toBeGreaterThan(1)
  expect(evidenceCharacters).toBeLessThanOrEqual(12_000)
  const firstEvidenceCharacters = Math.ceil(evidenceCharacters / 2)
  const evidence = [
    "x".repeat(firstEvidenceCharacters),
    "x".repeat(evidenceCharacters - firstEvidenceCharacters),
  ]
  input.evidence = evidence
  const expectedState = {
    task: input.task,
    intent: { request: input.request },
    evidence,
  }
  expect(JSON.stringify(expectedState)).toHaveLength(7_026)

  const calls: SystemOneInput[] = []
  const reviewer = new TaskReviewer(memory(), {
    systemOne: async (request) => {
      calls.push(request)
      return reply(request)
    },
  })
  const result = await reviewer.verify(input, "owner", new AbortController().signal)
  expect(calls).toHaveLength(1)
  const request = calls[0]!
  if (!("findings" in result)) throw Error("Expected findings")
  expect(JSON.stringify(request).length).toBeGreaterThan(8_000)
  expect(JSON.stringify(request).length).toBeLessThanOrEqual(SYSTEM_ONE_TRANSPORT_MAX_CHARS)
  expect(request.state).toEqual(expectedState)
  expect(request.questions).toEqual(reviewQuestions(reviewChecks(input.task)))
  expect(Object.keys(request.questions)).toHaveLength(14)
  expect(Object.keys(result.answers)).toEqual(Object.keys(request.questions))
  expect(result.status).toBe("completed")
  expect(result.findings).toHaveLength(reviewChecks(input.task).length)
})

test("late and cancelled review responses retain measured usage but cannot merge answers or start another batch", async () => {
  const input = draft()
  input.task.acceptance = Array.from({ length: 6 }, (_, index) => ({
    id: `criterion-${index}`,
    assertion: `The task review preserves behavior ${index}`,
    evidence: [{ kind: "verification" as const, verificationID: "tests" }],
  }))

  for (const outcome of ["deadline", "cancel"] as const) {
    const store = memory()
    let now = 0
    let calls = 0
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const controller = new AbortController()
    const reviewer = new TaskReviewer(
      store,
      {
        systemOne: async (request) => {
          calls++
          entered()
          await gate
          return reply(request)
        },
      },
      () => now,
    )

    const pending = reviewer.verify(input, "owner", controller.signal)
    await started
    if (outcome === "deadline") now = 60_000
    else controller.abort(new Error("review cancelled"))
    release()
    const result = await pending

    expect(calls).toBe(1)
    expect(result.status).toBe("unavailable")
    if (!("findings" in result)) throw Error("Expected findings")
    expect(result.answers).toEqual({})
    expect(
      result.findings.every((finding) => finding.probability === null && finding.score === null),
    ).toBe(true)
    expect(result.errors[0]).toContain(
      outcome === "deadline" ? "deadline exceeded" : "review cancelled",
    )
    expect(result.usage).toEqual({ input_tokens: 123, output_tokens: 0 })
    const saved = store.data.get(`task-review.${result.reviewID}`) as {
      history: Array<{ result: unknown }>
    }
    expect(saved.history).toHaveLength(1)
    expect(saved.history[0]!.result).toEqual(result)
  }
})

test("a later batch error preserves prior answers and history without establishing any finding", async () => {
  const input = draft()
  input.task.acceptance = Array.from({ length: 6 }, (_, index) => ({
    id: `criterion-${index}`,
    assertion: `The task review preserves behavior ${index}`,
    evidence: [{ kind: "verification" as const, verificationID: "tests" }],
  }))
  const store = memory()
  const batches: SystemOneInput[] = []
  let calls = 0
  const reviewer = new TaskReviewer(store, {
    systemOne: async (request) => {
      calls++
      batches.push(request)
      return calls === 2 ? { error: "later batch failed" } : reply(request)
    },
  })

  const partial = await reviewer.verify(input, "owner", new AbortController().signal)
  expect(partial.status).toBe("unavailable")
  if (!("findings" in partial)) throw Error("Expected findings")
  expect(calls).toBe(2)
  expect(Object.keys(partial.answers)).toEqual(Object.keys(batches[0]!.questions))
  expect(partial.errors).toEqual(["later batch failed"])
  expect(partial.usage).toEqual({ input_tokens: null, output_tokens: 0 })
  expect(partial.findings.every((finding) => finding.score === null)).toBe(true)

  const resumed = await reviewer.verify(
    { ...input, reviewID: partial.reviewID },
    "owner",
    new AbortController().signal,
  )
  expect(resumed.status).toBe("completed")
  if (!("findings" in resumed)) throw Error("Expected findings")
  expect(resumed.round).toBe(2)
  expect(calls).toBe(4)
  const history = (
    store.data.get(`task-review.${partial.reviewID}`) as {
      history: Array<{ result: unknown }>
    }
  ).history
  expect(history).toHaveLength(2)
  expect(history[0]!.result).toEqual(partial)
  expect(history[1]!.result).toEqual(resumed)
  expect(
    await reviewer.verify(
      { ...input, reviewID: partial.reviewID },
      "owner",
      new AbortController().signal,
    ),
  ).toEqual(resumed)
  expect(calls).toBe(4)
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

test("a changed checklist cannot reuse an earlier review; a new review preserves parent intent", async () => {
  const store = memory()
  const input = draft()
  input.request = "Improve task history, live scheduler visualization and model accounting."
  const seen: Array<{ request: string; objective: string }> = []
  const reviewer = new TaskReviewer(store, {
    systemOne: async (request) => {
      const state = request.state as { intent: { request: string }; task: { objective: string } }
      seen.push({ request: state.intent.request, objective: state.task.objective })
      return reply(request)
    },
  })
  const first = await reviewer.verify(input, "owner", new AbortController().signal)
  if (!("reviewID" in first)) throw Error("Expected stored review")
  for (const saved of store.data.values())
    (saved as { version: string }).version = "task-hardening-v2"
  const calls = seen.length
  const stale = await reviewer.verify(
    { ...input, reviewID: first.reviewID },
    "owner",
    new AbortController().signal,
  )
  expect(stale.status).toBe("invalid")
  expect(seen.length).toBe(calls)
  const fresh = await reviewer.verify(input, "owner", new AbortController().signal)
  expect(fresh.status).toBe("completed")
  if (!("reviewID" in fresh)) throw Error("Expected fresh review")
  expect(fresh.reviewID).not.toBe(first.reviewID)
  expect(
    seen.every(
      (state) => state.request === input.request && state.objective === input.task.objective,
    ),
  ).toBe(true)
})

test("an input over a review limit says to split the item, not to shorten it", async () => {
  const reviewer = new TaskReviewer(memory(), {} as never)
  const result = (await reviewer.verify(
    { ...draft(), evidence: Array.from({ length: 21 }, () => "a recorded fact") },
    "owner",
    new AbortController().signal,
  )) as { status: string; errors: { path: string; message: string }[] }
  expect(result.status).toBe("invalid")
  expect(result.errors[0]).toEqual({
    path: "evidence",
    message:
      "This item is too large for one task: split it into tasks in the plan (limit: 20 entries).",
  })
})
