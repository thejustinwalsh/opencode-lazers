import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../../test/proposal.ts"
import { TaskRepository } from "../../storage.ts"
import { RunnerStore } from "../../runner/store.ts"
import { SystemOneRequest } from "../../webgpu/system-one.ts"
import type { SystemOneInput, SystemOneOutput } from "../../webgpu/system-one.ts"
import { HandoffReviewer } from "./review.ts"
import type { HandoffReviewAuthorization, HandoffReviewResult } from "./review.ts"
import { HANDOFF_REVIEW_VERSION, handoffReviewDefinitions } from "./checks.ts"
import { HandoffDraft } from "./schema.ts"
import type { HandoffActor, HandoffEvidence } from "./schema.ts"
import { HandoffStore } from "./store.ts"

const cleanup: (() => void)[] = []

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
})

const worker: HandoffActor = {
  sessionID: "review-source-worker",
  agent: "lazers-implementor",
  role: "worker",
}
const architect: HandoffActor = {
  sessionID: "review-current-architect",
  agent: "architect",
  role: "architect",
}

function fixture() {
  const projectDirectory = mkdtempSync(join(tmpdir(), "lazers-handoff-review-project-"))
  const stateDirectory = mkdtempSync(join(tmpdir(), "lazers-handoff-review-state-"))
  const workspace = join(projectDirectory, "worker-worktree")
  mkdirSync(workspace)
  const path = join(stateDirectory, "tasks.sqlite")
  const repositories: TaskRepository[] = []
  let repository = new TaskRepository(path, projectDirectory)
  repositories.push(repository)
  const runner = new RunnerStore(repository)
  const proposal = validProposal()
  const baseCommit = "b".repeat(40)
  const task = repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "review-project",
      projectDirectory,
      workspaceDirectory: projectDirectory,
      sessionID: architect.sessionID,
      startingRevision: { kind: "git", commit: baseCommit },
    },
    proposal,
  })
  const plan = runner.submit(
    {
      requestID: `review-plan-${crypto.randomUUID()}`,
      objective: proposal.objective,
      baseCommit,
      workspaceMode: "isolated",
      nodes: [{ taskID: task.id, revision: 1 }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: proposal.verification,
      acceptance: proposal.acceptance,
    },
    architect.sessionID,
  )
  const attemptID = crypto.randomUUID()
  repository.atomic((db) => {
    db.query(
      `INSERT INTO runner_attempts
       (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,
        started_at,token_count,tool_count,retry_count,cost)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      attemptID,
      plan.planID,
      task.id,
      1,
      worker.sessionID,
      crypto.randomUUID(),
      workspace,
      baseCommit,
      JSON.stringify({ agent: worker.agent }),
      "failed",
      Date.now(),
      17,
      4,
      0,
      null,
    )
  })
  let handoffs = new HandoffStore(repository)
  const requested = handoffs.request(
    {
      requestID: "review-request-1",
      sourceAttemptID: attemptID,
      request: {
        purpose: "Preserve useful work and provide a source-grounded recovery handoff.",
        references: [{ kind: "task", reference: `task:${task.id}` }],
      },
    },
    architect,
  )
  if (requested.status === "conflict") throw new Error(requested.message)
  const request = requested.record
  const saved = handoffs.saveDraft(
    { requestID: request.requestID, draftID: crypto.randomUUID(), draft: makeDraft() },
    worker,
  )
  if (saved.status === "conflict") throw new Error(saved.message)

  const openStore = () => {
    const next = new TaskRepository(path, projectDirectory)
    repositories.push(next)
    return new HandoffStore(next)
  }
  const reopen = () => {
    repository.close()
    repository = new TaskRepository(path, projectDirectory)
    repositories.push(repository)
    handoffs = new HandoffStore(repository)
    return { repository, handoffs }
  }
  cleanup.push(() => {
    for (const current of repositories) current.close()
    rmSync(projectDirectory, { recursive: true, force: true })
    rmSync(stateDirectory, { recursive: true, force: true })
  })
  return {
    path,
    projectDirectory,
    task,
    planID: plan.planID,
    attemptID,
    request,
    draftVersion: saved.record.draftVersion,
    repository: () => repository,
    handoffs: () => handoffs,
    openStore,
    reopen,
  }
}

function makeDraft(summary = "The focused diagnostic and partial change are preserved.") {
  return HandoffDraft.parse({
    target: {
      outcome: { status: "known", value: "Retain the original task outcome and acceptance." },
      originalUserIntent: {
        status: "unknown",
        reason: "The immutable task does not store the verbatim original user request.",
      },
      workerInterpretation: { status: "unknown" },
      contractReferences: [
        { kind: "specification", reference: "task-revision:1" },
        { kind: "acceptance", reference: "reopen" },
      ],
    },
    completedWork: [{ summary, evidence: [] }],
    partialWork: [
      { summary: "The failure probe is useful but the repair is unfinished.", evidence: [] },
    ],
    workspaceState: {
      status: "known",
      value: "A local partial change remains in the worker worktree.",
    },
    approaches: [
      {
        approach: "Run the relevant verification against the saved handoff context.",
        result: { status: "known", value: "The earlier verification exposed a recovery failure." },
        evidence: [{ kind: "verification", reference: "bun test src/recovery/handoff" }],
      },
    ],
    failure: {
      status: "observed",
      behavior: { status: "known", value: "The task's original verification did not pass." },
      cause: "unknown",
      evidence: [{ kind: "trajectory", reference: "attempt:failed-verification" }],
    },
    assumptions: [
      { claim: "The failure came from persistence ordering.", status: "unknown", evidence: [] },
    ],
    evidence: [{ kind: "trajectory", reference: "attempt:failed-verification" }],
    preservedObligations: [
      {
        requirement: "Keep the source acceptance checks intact.",
        sourceReference: "task-revision:1",
      },
    ],
    remainingWork: { status: "known", value: "Investigate and repair the observed failure." },
    remainingDecisions: { status: "unknown" },
    reportedOwnership: {
      writerActivity: { status: "unknown" },
      backgroundActivity: { status: "unknown" },
      unresolvedNativeEffects: { status: "unknown" },
      reportedQuiescence: "unknown",
    },
  })
}

function saveDraft(f: ReturnType<typeof fixture>, summary: string) {
  const saved = f.handoffs().saveDraft(
    {
      requestID: f.request.requestID,
      draftID: crypto.randomUUID(),
      draft: makeDraft(summary),
    },
    worker,
  )
  if (saved.status === "conflict") throw new Error(saved.message)
  return saved.record
}

function authorize(allow: () => boolean = () => true): HandoffReviewAuthorization {
  return (_actor, _requestID, _phase) => {
    if (!allow()) throw new Error("review permission revoked")
  }
}

function reply(
  input: SystemOneInput,
  score: (question: string) => number = () => 0.95,
): SystemOneOutput {
  const request = SystemOneRequest.parse(input)
  return {
    model: "d1-omni-2b",
    usage: { input_tokens: 111, output_tokens: 0 },
    answers: Object.fromEntries(
      Object.keys(request.questions).map((question) => [
        question,
        { type: "noul", noul: score(question) },
      ]),
    ),
  }
}

function roundCount(f: ReturnType<typeof fixture>, requestID = f.request.requestID) {
  return f
    .repository()
    .atomic(
      (db) =>
        db
          .query<{ count: number }, [string, string]>(
            "SELECT COUNT(*) AS count FROM recovery_handoff_rounds WHERE project_directory=? AND request_id=?",
          )
          .get(f.projectDirectory, requestID)!.count,
    )
}

function assertReviewed(
  result: Awaited<ReturnType<HandoffReviewer["review"]>>,
): HandoffReviewResult {
  if (!("findings" in result)) throw new Error(`Expected a review result, got ${result.status}`)
  return result
}

test("malformed, oversized, foreign, unauthorized, and stale review requests reserve no rounds", async () => {
  const f = fixture()
  let calls = 0
  let authCalls = 0
  const reviewer = new HandoffReviewer(
    f.handoffs(),
    { systemOne: async (input) => (calls++, reply(input)) },
    (actor, requestID, phase) => {
      authCalls++
      if (actor.role !== "worker" || requestID !== f.request.requestID || phase === "persist")
        throw new Error("review permission denied")
    },
  )

  const malformed = await reviewer.review(
    {
      requestID: f.request.requestID,
      draftVersion: f.draftVersion,
      evidence: [{ kind: "trajectory", reference: "x".repeat(2_001) }],
    },
    worker,
    new AbortController().signal,
  )
  expect(malformed.status).toBe("invalid")
  expect(authCalls).toBe(0)

  const oversizedEvidence: HandoffEvidence[] = Array.from({ length: 6 }, (_, index) => ({
    kind: "other",
    reference: `evidence:${index}`,
    note: "x".repeat(2_000),
  }))
  const oversized = await reviewer.review(
    {
      requestID: f.request.requestID,
      draftVersion: f.draftVersion,
      evidence: oversizedEvidence,
    },
    worker,
    new AbortController().signal,
  )
  expect(oversized.status).toBe("invalid")

  await expect(
    reviewer.review(
      { requestID: f.request.requestID, draftVersion: f.draftVersion },
      { ...worker, sessionID: "foreign-source-worker" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("not the worker assigned")
  await expect(
    new HandoffReviewer(
      f.handoffs(),
      { systemOne: async (input) => (calls++, reply(input)) },
      authorize(() => false),
    ).review(
      { requestID: f.request.requestID, draftVersion: f.draftVersion },
      worker,
      new AbortController().signal,
    ),
  ).rejects.toThrow("review permission revoked")

  f.handoffs().request(
    {
      requestID: "review-request-generation-2",
      sourceAttemptID: f.attemptID,
      request: { purpose: "Authorize a new recovery handoff generation.", references: [] },
    },
    architect,
  )
  await expect(
    reviewer.review(
      { requestID: f.request.requestID, draftVersion: f.draftVersion },
      worker,
      new AbortController().signal,
    ),
  ).rejects.toThrow("request generation is stale")
  expect(calls).toBe(0)
  expect(roundCount(f)).toBe(0)
})

test("fixed checks persist raw probabilities, focused feedback, rechecks, non-regression, replay and exhaustion", async () => {
  const f = fixture()
  let phase = 1
  let modelCalls = 0
  const seenQuestions: Array<Set<string>> = []
  const seenByPhase = new Map<number, Set<string>>()
  const transport = {
    systemOne: async (input: SystemOneInput) => {
      modelCalls++
      const request = SystemOneRequest.parse(input)
      const questions = new Set(Object.keys(request.questions))
      seenQuestions.push(questions)
      const phaseQuestions = seenByPhase.get(phase) ?? new Set<string>()
      for (const question of questions) phaseQuestions.add(question)
      seenByPhase.set(phase, phaseQuestions)
      const state = request.state as {
        draft: ReturnType<typeof makeDraft>
      }
      expect(state.draft.failure.cause).toBe("unknown")
      expect(state.draft.target.originalUserIntent.status).toBe("unknown")
      expect(state.draft.reportedOwnership.writerActivity.status).toBe("unknown")
      return reply(input, (id) => {
        if (id === "preserve-target") return 0.2
        if (phase >= 2 && id === "observed-failure") return 0.1
        return 0.95
      })
    },
  }
  const reviewer = new HandoffReviewer(f.handoffs(), transport, authorize())
  const input = {
    requestID: f.request.requestID,
    draftVersion: f.draftVersion,
  }
  const first = assertReviewed(await reviewer.review(input, worker, new AbortController().signal))
  expect(first.status).toBe("feedback")
  expect(first.focus?.id).toBe("preserve-target")
  expect(first.answers["preserve-target"]).toEqual({ type: "noul", noul: 0.2 })
  expect(first.findings.find((finding) => finding.id === "preserve-target")).toMatchObject({
    probability: 0.2,
    score: 0.2,
    disposition: "pending",
  })
  expect(first.usage).toMatchObject({
    inputTokens: 111 * seenQuestions.length,
    outputTokens: 0,
    costUSD: null,
  })
  expect(first.version).toBe(HANDOFF_REVIEW_VERSION)
  expect(handoffReviewDefinitions.map((check) => check.id)).toEqual(
    first.findings.map((finding) => finding.id),
  )
  expect(
    f.handoffs().getReviewRound(f.request.requestID, first.reviewID, 1)?.outcome?.result,
  ).toEqual(first)
  expect(
    await reviewer.review(
      { ...input, reviewID: first.reviewID },
      worker,
      new AbortController().signal,
    ),
  ).toEqual(first)

  const secondDraft = saveDraft(f, "The source tests and partial repair notes are retained.")
  phase = 2
  const second = assertReviewed(
    await reviewer.review(
      {
        requestID: f.request.requestID,
        draftVersion: secondDraft.draftVersion,
        reviewID: first.reviewID,
      },
      worker,
      new AbortController().signal,
    ),
  )
  expect(second.status).toBe("feedback")
  expect(second.round).toBe(2)
  expect(second.findings.find((finding) => finding.id === "preserve-target")?.disposition).toBe(
    "non_regressed",
  )
  expect(second.focus?.id).toBe("observed-failure")
  expect(second.findings.find((finding) => finding.id === "observed-failure")).toMatchObject({
    probability: 0.1,
    score: 0.1,
    disposition: "pending",
  })

  const thirdDraft = saveDraft(f, "The investigation and remaining work are explicitly preserved.")
  phase = 3
  const third = assertReviewed(
    await reviewer.review(
      {
        requestID: f.request.requestID,
        draftVersion: thirdDraft.draftVersion,
        reviewID: first.reviewID,
      },
      worker,
      new AbortController().signal,
    ),
  )
  expect(third.status).toBe("completed_with_concerns")
  expect(third.round).toBe(3)
  expect(third.focus).toBeNull()
  expect(third.findings.slice(0, 2).map((finding) => finding.disposition)).toEqual([
    "non_regressed",
    "non_regressed",
  ])
  expect(roundCount(f)).toBe(3)
  expect(seenQuestions.every((questions) => questions.size > 0)).toBe(true)
  expect(new Set(seenQuestions.flatMap((questions) => [...questions]))).toEqual(
    new Set(handoffReviewDefinitions.map((check) => check.id)),
  )

  f.repository().atomic((db) => {
    db.query("UPDATE runner_plans SET version=version+1 WHERE id=?").run(f.planID)
  })
  expect(
    await reviewer.review(
      {
        requestID: f.request.requestID,
        draftVersion: thirdDraft.draftVersion,
        reviewID: first.reviewID,
      },
      worker,
      new AbortController().signal,
    ),
  ).toEqual(third)
  const changedEvidence = await reviewer.review(
    {
      requestID: f.request.requestID,
      draftVersion: thirdDraft.draftVersion,
      evidence: [{ kind: "trajectory", reference: "attempt:changed-evidence" }],
      reviewID: first.reviewID,
    },
    worker,
    new AbortController().signal,
  )
  expect(changedEvidence.status).toBe("stale")
  const freshID = await reviewer.review(
    {
      requestID: f.request.requestID,
      draftVersion: thirdDraft.draftVersion,
      reviewID: crypto.randomUUID(),
    },
    worker,
    new AbortController().signal,
  )
  expect(freshID.status).toBe("stale")
  expect(modelCalls).toBe(seenQuestions.length)
  expect(seenByPhase.size).toBe(3)
  for (const questions of seenByPhase.values())
    expect(questions).toEqual(new Set(handoffReviewDefinitions.map((check) => check.id)))
  expect(roundCount(f)).toBe(3)
  expect(f.handoffs().pendingNotifications()).toEqual([])
  expect(
    f
      .repository()
      .atomic(
        (db) =>
          db
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) AS count FROM recovery_handoff_reports WHERE request_id=?",
            )
            .get(f.request.requestID)!.count,
      ),
  ).toBe(0)
})

test("an authorized current Architect can review; disabled and malformed inference stay explicit", async () => {
  const f = fixture()
  let calls = 0
  const disabledReviewer = new HandoffReviewer(
    f.handoffs(),
    { systemOne: async (input) => (calls++, reply(input)) },
    authorize(),
    () => false,
  )
  const disabled = assertReviewed(
    await disabledReviewer.review(
      { requestID: f.request.requestID, draftVersion: f.draftVersion },
      architect,
      new AbortController().signal,
    ),
  )
  expect(disabled.status).toBe("disabled")
  expect(disabled.model).toBeUndefined()
  expect(disabled.usage).toEqual({
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUSD: null,
  })
  expect(calls).toBe(0)
  expect(
    f.handoffs().getReviewRound(f.request.requestID, disabled.reviewID, 1)?.outcome,
  ).toMatchObject({
    status: "disabled",
    result: disabled,
    limitation: "Local handoff review is disabled; no semantic findings were established.",
  })

  const malformedTransportReviewer = new HandoffReviewer(
    f.handoffs(),
    {
      systemOne: async () => ({
        model: "d1-omni-2b",
        answers: {},
        usage: { input_tokens: 99, output_tokens: 0 },
      }),
    },
    authorize(),
  )
  const unavailable = assertReviewed(
    await malformedTransportReviewer.review(
      {
        requestID: f.request.requestID,
        draftVersion: f.draftVersion,
        reviewID: disabled.reviewID,
      },
      architect,
      new AbortController().signal,
    ),
  )
  expect(unavailable.status).toBe("unavailable")
  expect(unavailable.errors[0]).toContain("answer names do not match")
  expect(unavailable.limitation).toContain("answer names do not match")
  expect(unavailable.usage.inputTokens).toBe(99)
  expect(unavailable.elapsedMs).not.toBeNull()
  expect(
    f.handoffs().getReviewRound(f.request.requestID, unavailable.reviewID, 2)?.outcome,
  ).toMatchObject({
    status: "unavailable",
    limitation: expect.stringContaining("answer names do not match"),
  })

  const currentArchitect = new HandoffReviewer(
    f.handoffs(),
    { systemOne: async (input) => (calls++, reply(input)) },
    authorize(),
  )
  const recovered = assertReviewed(
    await currentArchitect.review(
      {
        requestID: f.request.requestID,
        draftVersion: f.draftVersion,
        evidence: [{ kind: "trajectory", reference: "attempt:architect-review" }],
        reviewID: disabled.reviewID,
      },
      architect,
      new AbortController().signal,
    ),
  )
  expect(recovered.status).toBe("completed")
  expect(recovered.round).toBe(3)
  expect(calls).toBeGreaterThan(0)
})

test("aborted inference is durable without invented usage, and an authority revocation blocks its result", async () => {
  const f = fixture()
  let modelCalls = 0
  const aborted = new AbortController()
  aborted.abort(new Error("caller stopped review"))
  const firstReviewer = new HandoffReviewer(
    f.handoffs(),
    { systemOne: async (input) => (modelCalls++, reply(input)) },
    authorize(),
  )
  const interrupted = assertReviewed(
    await firstReviewer.review(
      { requestID: f.request.requestID, draftVersion: f.draftVersion },
      worker,
      aborted.signal,
    ),
  )
  expect(interrupted.status).toBe("unavailable")
  expect(interrupted.errors[0]).toContain("caller stopped review")
  expect(interrupted.usage.inputTokens).toBeNull()
  expect(modelCalls).toBe(0)
  expect(
    f.handoffs().getReviewRound(f.request.requestID, interrupted.reviewID, 1)?.outcome?.status,
  ).toBe("unavailable")

  const nextDraft = saveDraft(f, "A revision preserves the unfinished diagnosis.")
  let allowed = true
  const revokedReviewer = new HandoffReviewer(
    f.handoffs(),
    { systemOne: async (input) => (modelCalls++, reply(input)) },
    (actor, requestID, phase) => {
      if (phase === "persist") allowed = false
      if (!allowed) throw new Error("review permission revoked before outcome persistence")
      expect(actor).toEqual(worker)
      expect(requestID).toBe(f.request.requestID)
    },
  )
  await expect(
    revokedReviewer.review(
      {
        requestID: f.request.requestID,
        draftVersion: nextDraft.draftVersion,
        reviewID: interrupted.reviewID,
      },
      worker,
      new AbortController().signal,
    ),
  ).rejects.toThrow("revoked before outcome persistence")
  expect(modelCalls).toBeGreaterThan(0)
  expect(
    f.handoffs().getReviewRound(f.request.requestID, interrupted.reviewID, 2)?.outcome,
  ).toBeUndefined()
})

test("reservation recovery is durable across reopen and late inference cannot overwrite it", async () => {
  const f = fixture()
  let now = Date.now()
  let modelCalls = 0
  const denyInference = new HandoffReviewer(
    f.handoffs(),
    { systemOne: async (input) => (modelCalls++, reply(input)) },
    (_actor, _requestID, phase) => {
      if (phase === "inference") throw new Error("authority changed before inference")
    },
    () => true,
    () => now,
  )
  await expect(
    denyInference.review(
      { requestID: f.request.requestID, draftVersion: f.draftVersion },
      worker,
      new AbortController().signal,
    ),
  ).rejects.toThrow("authority changed before inference")
  expect(modelCalls).toBe(0)
  const differentDraft = saveDraft(
    f,
    "A newer immutable draft cannot replace an in-flight reservation.",
  )
  const mismatched = await denyInference.review(
    {
      requestID: f.request.requestID,
      draftVersion: differentDraft.draftVersion,
    },
    worker,
    new AbortController().signal,
  )
  expect(mismatched.status).toBe("stale")
  expect(modelCalls).toBe(0)
  const reviewID = f
    .repository()
    .atomic(
      (db) =>
        db
          .query<{ review_id: string }, [string, string]>(
            "SELECT review_id FROM recovery_handoff_reviews WHERE project_directory=? AND request_id=?",
          )
          .get(f.projectDirectory, f.request.requestID)!.review_id,
    )
  expect(f.handoffs().getReviewRound(f.request.requestID, reviewID, 1)?.outcome).toBeUndefined()

  const reopened = f.reopen()
  expect(
    reopened.handoffs.getReviewRound(f.request.requestID, reviewID, 1)?.outcome,
  ).toBeUndefined()
  const reservedAt = Date.parse(
    reopened.handoffs.getReviewRound(f.request.requestID, reviewID, 1)!.reservedAt,
  )
  now = reservedAt + 120_001
  const recoveryReviewer = new HandoffReviewer(
    reopened.handoffs,
    { systemOne: async (input) => (modelCalls++, reply(input)) },
    authorize(),
    () => true,
    () => now,
  )
  const recovered = assertReviewed(
    await recoveryReviewer.review(
      { requestID: f.request.requestID, draftVersion: f.draftVersion, reviewID },
      worker,
      new AbortController().signal,
    ),
  )
  expect(recovered.status).toBe("unavailable")
  expect(recovered.errors[0]).toContain("interrupted before a result")
  expect(modelCalls).toBe(0)

  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => (entered = resolve))
  const gate = new Promise<void>((resolve) => (release = resolve))
  const slowTransport = {
    systemOne: async (input: SystemOneInput) => {
      modelCalls++
      entered()
      await gate
      return reply(input)
    },
  }
  const slowReviewer = new HandoffReviewer(
    reopened.handoffs,
    slowTransport,
    authorize(),
    () => true,
    () => now,
  )
  const nextEvidence = [{ kind: "trajectory" as const, reference: "attempt:late-evidence" }]
  const late = slowReviewer.review(
    {
      requestID: f.request.requestID,
      draftVersion: f.draftVersion,
      evidence: nextEvidence,
      reviewID,
    },
    worker,
    new AbortController().signal,
  )
  await started
  now += 120_001
  const competingStore = f.openStore()
  const competingReviewer = new HandoffReviewer(
    competingStore,
    { systemOne: async (input) => (modelCalls++, reply(input)) },
    authorize(),
    () => true,
    () => now,
  )
  const recoveredLate = assertReviewed(
    await competingReviewer.review(
      {
        requestID: f.request.requestID,
        draftVersion: f.draftVersion,
        evidence: nextEvidence,
        reviewID,
      },
      worker,
      new AbortController().signal,
    ),
  )
  expect(recoveredLate.status).toBe("unavailable")
  const newerResult = assertReviewed(
    await competingReviewer.review(
      {
        requestID: f.request.requestID,
        draftVersion: f.draftVersion,
        evidence: [{ kind: "trajectory", reference: "attempt:newer-reviewed-evidence" }],
        reviewID,
      },
      worker,
      new AbortController().signal,
    ),
  )
  expect(newerResult.round).toBe(3)
  expect(newerResult.status).toBe("completed")
  expect(newerResult.fingerprint).not.toBe(recoveredLate.fingerprint)
  const callsBeforeLate = modelCalls
  release()
  const lateResult = assertReviewed(await late)
  expect(lateResult).toEqual(recoveredLate)
  expect(
    reopened.handoffs.getReviewRound(f.request.requestID, reviewID, 2)?.outcome?.result,
  ).toEqual(recoveredLate)
  expect(roundCount(f)).toBe(3)
  expect(modelCalls).toBe(callsBeforeLate)
})

test("authorized reviewers share one three-round chain across IDs and reopened connections", async () => {
  const f = fixture()
  let calls = 0
  const reviewedBy: HandoffActor[] = []
  const makeReviewer = (store: HandoffStore) =>
    new HandoffReviewer(
      store,
      { systemOne: async (input) => (calls++, reply(input, () => 0.2)) },
      (actor) => {
        reviewedBy.push(actor)
      },
    )
  let reviewer = makeReviewer(f.handoffs())
  const signal = new AbortController().signal
  const first = assertReviewed(
    await reviewer.review(
      { requestID: f.request.requestID, draftVersion: f.draftVersion },
      worker,
      signal,
    ),
  )
  expect(first.round).toBe(1)
  for (const [index, actor] of [architect, worker].entries()) {
    reviewer = makeReviewer(index === 0 ? f.reopen().handoffs : f.openStore())
    const input = {
      requestID: f.request.requestID,
      draftVersion: f.draftVersion,
      evidence: [{ kind: "trajectory" as const, reference: `attempt:round-${index + 2}` }],
    }
    const beforeAlias = calls
    const alias = await reviewer.review({ ...input, reviewID: crypto.randomUUID() }, actor, signal)
    expect(alias.status).toBe("stale")
    expect(calls).toBe(beforeAlias)
    expect(roundCount(f)).toBe(index + 1)
    const result = assertReviewed(
      await reviewer.review({ ...input, reviewID: first.reviewID }, actor, signal),
    )
    expect(result.round).toBe(index + 2)
    expect(
      f.handoffs().getReviewRound(f.request.requestID, first.reviewID, index + 2)?.reviewer,
    ).toEqual(actor)
  }
  expect(roundCount(f)).toBe(3)
  const beforeFourth = calls
  const fourth = await makeReviewer(f.reopen().handoffs).review(
    {
      requestID: f.request.requestID,
      draftVersion: f.draftVersion,
      reviewID: crypto.randomUUID(),
      evidence: [{ kind: "trajectory", reference: "attempt:fourth-actor-reset" }],
    },
    architect,
    signal,
  )
  expect(fourth.status).toBe("stale")
  expect(calls).toBe(beforeFourth)
  expect(roundCount(f)).toBe(3)
  expect(reviewedBy.some((actor) => actor.role === "architect")).toBe(true)
  expect(reviewedBy.some((actor) => actor.role === "worker")).toBe(true)
  const firstRound = f.handoffs().getReviewRound(f.request.requestID, first.reviewID, 1)!
  expect(firstRound.reviewer).toEqual(worker)
  expect(() =>
    f.handoffs().recordReviewOutcome(
      {
        requestID: f.request.requestID,
        reviewID: first.reviewID,
        round: 1,
        outcome: firstRound.outcome,
      },
      architect,
    ),
  ).toThrow("another request or caller")
  await expect(
    reviewer.review(
      {
        requestID: f.request.requestID,
        draftVersion: f.draftVersion,
        reviewID: first.reviewID,
      },
      { ...architect, sessionID: "unrelated-architect" },
      signal,
    ),
  ).rejects.toThrow("not the current owner")
  expect(calls).toBe(beforeFourth)
})

test("changed source task contracts cannot inherit a stored pass", async () => {
  const f = fixture()
  let calls = 0
  const reviewer = new HandoffReviewer(
    f.handoffs(),
    { systemOne: async (input) => (calls++, reply(input)) },
    authorize(),
  )
  const first = assertReviewed(
    await reviewer.review(
      { requestID: f.request.requestID, draftVersion: f.draftVersion },
      worker,
      new AbortController().signal,
    ),
  )
  expect(first.status).toBe("completed")
  const callsAfterPass = calls
  f.repository().atomic((db) => {
    db.query("UPDATE tasks SET body=json_set(body,'$.proposal.objective',?) WHERE id=?").run(
      "A different source objective under the same revision.",
      f.task.id,
    )
  })
  await expect(
    reviewer.review(
      {
        requestID: f.request.requestID,
        draftVersion: f.draftVersion,
        reviewID: first.reviewID,
      },
      worker,
      new AbortController().signal,
    ),
  ).rejects.toThrow("source task contract is stale")
  expect(calls).toBe(callsAfterPass)
  expect(roundCount(f)).toBe(1)
})
