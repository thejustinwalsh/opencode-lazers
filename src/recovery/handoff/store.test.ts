import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../../test/proposal.ts"
import { TaskRepository } from "../../storage.ts"
import { RunnerStore } from "../../runner/store.ts"
import { HandoffDraft, HandoffReviewOutcome } from "./schema.ts"
import type { HandoffActor, HandoffReviewReservationInput } from "./schema.ts"
import { HandoffStore } from "./store.ts"

const cleanup: (() => void)[] = []

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
})

const worker: HandoffActor = {
  sessionID: "worker-session",
  agent: "lazers-implementor",
  role: "worker",
}
const architect: HandoffActor = {
  sessionID: "architect-session",
  agent: "architect",
  role: "architect",
}

function fixture() {
  const projectDirectory = mkdtempSync(join(tmpdir(), "lazers-handoff-project-"))
  const stateDirectory = mkdtempSync(join(tmpdir(), "lazers-handoff-state-"))
  const workspace = join(projectDirectory, "worker-worktree")
  mkdirSync(workspace)
  const path = join(stateDirectory, "tasks.sqlite")
  let repository = new TaskRepository(path, projectDirectory)
  const runner = new RunnerStore(repository)
  const proposal = validProposal()
  const baseCommit = "a".repeat(40)
  const task = repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "project",
      projectDirectory,
      workspaceDirectory: projectDirectory,
      sessionID: architect.sessionID,
      startingRevision: { kind: "git", commit: baseCommit },
    },
    proposal,
  })
  const plan = runner.submit(
    {
      requestID: `plan-${crypto.randomUUID()}`,
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
      24,
      5,
      0,
      null,
    )
  })
  let handoffs = new HandoffStore(repository)
  const reopen = () => {
    repository.close()
    repository = new TaskRepository(path, projectDirectory)
    handoffs = new HandoffStore(repository)
    return { repository, handoffs }
  }
  cleanup.push(() => {
    repository.close()
    rmSync(projectDirectory, { recursive: true, force: true })
    rmSync(stateDirectory, { recursive: true, force: true })
  })
  return {
    path,
    projectDirectory,
    workspace,
    task,
    planID: plan.planID,
    attemptID,
    repository: () => repository,
    handoffs: () => handoffs,
    reopen,
  }
}

function requestInput(
  attemptID: string,
  requestID = "handoff-request-1",
  purpose = "Describe useful progress and recovery state.",
) {
  return {
    requestID,
    sourceAttemptID: attemptID,
    request: { purpose, references: [] },
  }
}

function draft(workSummary = "A useful partial change is preserved.") {
  return HandoffDraft.parse({
    target: {
      outcome: { status: "known", value: "Keep the original task acceptance intact." },
      originalUserIntent: {
        status: "unknown",
        reason: "The immutable task specification does not contain the verbatim user request.",
      },
      workerInterpretation: { status: "unknown" },
      contractReferences: [
        { kind: "specification", reference: "task-revision:1" },
        { kind: "acceptance", reference: "reopen" },
      ],
    },
    completedWork: [{ summary: workSummary, evidence: [] }],
    partialWork: [],
    workspaceState: { status: "known", value: "One committed partial change exists." },
    approaches: [
      {
        approach: "Reuse the existing task repository transaction boundary.",
        result: { status: "known", value: "The focused persistence checks pass." },
        evidence: [{ kind: "verification", reference: "bun test src/recovery/handoff" }],
      },
    ],
    failure: {
      status: "observed",
      behavior: { status: "known", value: "The original verification did not pass." },
      cause: "unknown",
      evidence: [{ kind: "trajectory", reference: "attempt:failed-check" }],
    },
    assumptions: [
      {
        claim: "The cause is a persistence error.",
        status: "unknown",
        evidence: [],
      },
    ],
    evidence: [{ kind: "trajectory", reference: "attempt:failed-check" }],
    preservedObligations: [
      { requirement: "Retain original acceptance checks.", sourceReference: "task-revision:1" },
    ],
    remainingWork: { status: "known", value: "Investigate the observed verification failure." },
    remainingDecisions: { status: "unknown" },
    reportedOwnership: {
      writerActivity: { status: "unknown" },
      backgroundActivity: { status: "unknown" },
      unresolvedNativeEffects: { status: "unknown" },
      reportedQuiescence: "unknown",
    },
  })
}

function makeRequest(f: ReturnType<typeof fixture>, requestID = "handoff-request-1") {
  const receipt = f.handoffs().request(requestInput(f.attemptID, requestID), architect)
  if (receipt.status === "conflict") throw new Error(receipt.message)
  return receipt.record
}

function reservation(
  requestID: string,
  draftVersion: number,
  reviewID: string = crypto.randomUUID(),
  round = 1,
): HandoffReviewReservationInput {
  return {
    requestID,
    reviewID,
    round,
    draftVersion,
    evidenceVersion: `evidence-${round}`,
    evidence: [{ kind: "trajectory", reference: "attempt:failed-check" }],
    effectiveContractVersion: "contract-task-revision-1",
    effectiveContract: {
      taskRevision: 1,
      acceptanceIDs: ["reopen"],
      decisions: [],
    },
    checkVersion: "recovery-checks-v1",
    checks: [
      {
        id: "failure-evidence",
        definition: { question: "Does evidence support the observed failure?" },
      },
      {
        id: "preserve-obligations",
        definition: { question: "Are still-valid obligations retained?" },
      },
    ],
  }
}

function outcome(
  status: "completed_with_concerns" | "disabled" | "unavailable" = "completed_with_concerns",
) {
  return HandoffReviewOutcome.parse({
    status,
    result:
      status === "completed_with_concerns"
        ? { findings: [{ id: "cause", disposition: "pending" }] }
        : null,
    concerns: status === "completed_with_concerns" ? ["The root cause remains unknown."] : [],
    errors: status === "unavailable" ? ["Local review transport is unavailable."] : [],
    limitation:
      status === "disabled"
        ? "Local review is disabled."
        : status === "unavailable"
          ? "The local review transport did not complete."
          : null,
    elapsedMs: status === "disabled" ? null : 37,
    usage: {
      inputTokens: status === "disabled" ? null : 82,
      outputTokens: 0,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUSD: null,
    },
  })
}

test("source-bound request and immutable draft history survive reopen and workspace removal", () => {
  const f = fixture()
  const requested = makeRequest(f)
  expect(requested.requestGeneration).toBe(1)
  expect(requested.source.attachment).toMatchObject({
    planID: f.planID,
    taskID: f.task.id,
    specRevision: 1,
    attemptID: f.attemptID,
    sourceSessionID: worker.sessionID,
    requestGeneration: 1,
  })
  expect(requested.source.task.proposal.objective).toBe(f.task.proposal.objective)
  expect(f.handoffs().request(requestInput(f.attemptID), architect).status).toBe("replayed")
  expect(() => f.handoffs().request(requestInput(f.attemptID, "forged"), worker)).toThrow(
    "Only the current Architect may authorize",
  )
  expect(() =>
    f.handoffs().request(requestInput(f.attemptID, "foreign"), {
      ...architect,
      sessionID: "other-architect",
    }),
  ).toThrow("not the current owner")

  const first = f
    .handoffs()
    .saveDraft(
      { requestID: requested.requestID, draftID: crypto.randomUUID(), draft: draft() },
      worker,
    )
  const second = f.handoffs().saveDraft(
    {
      requestID: requested.requestID,
      draftID: crypto.randomUUID(),
      draft: draft("Partial implementation and evidence are preserved."),
    },
    worker,
  )
  expect(first.status).toBe("created")
  expect(second.status).toBe("created")
  if (first.status === "conflict" || second.status === "conflict")
    throw new Error("Draft write conflicted")
  expect(first.record.draftVersion).toBe(1)
  expect(second.record.draftVersion).toBe(2)
  expect(
    f
      .handoffs()
      .saveDraft(
        { requestID: requested.requestID, draftID: first.record.draftID, draft: draft() },
        worker,
      ).status,
  ).toBe("replayed")

  const nextRequest = makeRequest(f, "handoff-request-2")
  expect(nextRequest.requestGeneration).toBe(2)
  rmSync(f.workspace, { recursive: true, force: true })
  const reopened = f.reopen()
  expect(reopened.handoffs.getRequest(requested.requestID)?.source.attempt.workspace).toBe(
    f.workspace,
  )
  expect(reopened.handoffs.getDraft(requested.requestID, 1)?.draft.completedWork[0]?.summary).toBe(
    "A useful partial change is preserved.",
  )
  expect(reopened.handoffs.getDraft(requested.requestID, 2)?.draft.completedWork[0]?.summary).toBe(
    "Partial implementation and evidence are preserved.",
  )

  const allEvents: unknown[] = []
  let cursor: string | undefined
  do {
    const page = reopened.handoffs.readHistory({
      requestID: requested.requestID,
      limit: 2,
      cursor,
    })!
    allEvents.push(...page.events)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(allEvents).toHaveLength(3)
  expect(() =>
    reopened.handoffs.readHistory({ requestID: requested.requestID, cursor: "bad" }),
  ).toThrow("Invalid handoff history cursor")
  expect(() =>
    reopened.handoffs.readHistory({ requestID: requested.requestID, cursor: "" }),
  ).toThrow("Invalid handoff history cursor")
  const firstPage = reopened.handoffs.readHistory({ requestID: requested.requestID, limit: 1 })!
  expect(() =>
    reopened.handoffs.readHistory({
      requestID: "handoff-request-2",
      cursor: firstPage.nextCursor!,
    }),
  ).toThrow("Invalid handoff history cursor")
})

test("request authorization rejects task specifications detached from their runner node", () => {
  const f = fixture()
  f.repository().atomic((db) => {
    db.query("UPDATE tasks SET body=json_set(body,'$.id',?) WHERE id=?").run(
      crypto.randomUUID(),
      f.task.id,
    )
  })
  expect(() => f.handoffs().request(requestInput(f.attemptID), architect)).toThrow(
    "Source runner node no longer matches",
  )
  expect(f.handoffs().getRequest("handoff-request-1")).toBeUndefined()
  expect(f.handoffs().readHistory({ requestID: "handoff-request-1" })).toBeUndefined()
})

test("review reservations are request-bound, immutable and atomically finalized with notification intent", () => {
  const f = fixture()
  const request = makeRequest(f)
  const draftReceipt = f
    .handoffs()
    .saveDraft(
      { requestID: request.requestID, draftID: crypto.randomUUID(), draft: draft() },
      worker,
    )
  if (draftReceipt.status === "conflict") throw new Error(draftReceipt.message)
  const input = reservation(
    request.requestID,
    draftReceipt.record.draftVersion,
    crypto.randomUUID(),
  )
  const reserved = f.handoffs().reserveRound(input, architect)
  expect(reserved.status).toBe("created")
  if (reserved.status === "conflict") throw new Error(reserved.message)
  expect(f.handoffs().reserveRound(input, architect).status).toBe("replayed")
  const contenderRepository = new TaskRepository(f.path, f.projectDirectory)
  try {
    const contender = new HandoffStore(contenderRepository)
    expect(contender.reserveRound(input, architect).status).toBe("replayed")
  } finally {
    contenderRepository.close()
  }
  expect(() =>
    f.handoffs().reserveRound(input, { ...architect, sessionID: "foreign-architect" }),
  ).toThrow("not the current owner")
  expect(
    f
      .handoffs()
      .reserveRound({ ...input, evidenceVersion: "changed-evidence", evidence: [] }, architect)
      .status,
  ).toBe("conflict")
  expect(() =>
    f.handoffs().reserveRound({ ...input, round: 2, checkVersion: "changed-checks" }, architect),
  ).toThrow("version is stale")

  const savedOutcome = outcome()
  const resultInput = {
    requestID: request.requestID,
    reviewID: input.reviewID,
    round: input.round,
    outcome: savedOutcome,
  }
  expect(f.handoffs().recordReviewOutcome(resultInput, architect).status).toBe("recorded")
  expect(f.handoffs().recordReviewOutcome(resultInput, architect).status).toBe("replayed")
  expect(
    f
      .handoffs()
      .recordReviewOutcome(
        { ...resultInput, outcome: { ...savedOutcome, concerns: ["Changed after completion"] } },
        architect,
      ).status,
  ).toBe("conflict")

  const beforeState = f
    .repository()
    .atomic(
      (db) =>
        db
          .query<{ state: string }, [string, string]>(
            "SELECT state FROM runner_nodes WHERE plan_id=? AND task_id=?",
          )
          .get(f.planID, f.task.id)!.state,
    )
  const finalInput = {
    finalizationID: crypto.randomUUID(),
    requestID: request.requestID,
    draftVersion: draftReceipt.record.draftVersion,
    reviewID: input.reviewID,
    round: 1,
  }
  const finalized = f.handoffs().finalize(finalInput, architect)
  expect(finalized.status).toBe("finalized")
  if (finalized.status === "conflict") throw new Error(finalized.message)
  expect(finalized.report.reviewStatus).toBe("reviewed")
  expect(finalized.report.limitation).toBeNull()
  expect(finalized.report.concerns).toEqual(["The root cause remains unknown."])
  expect(finalized.notification).toMatchObject({
    requestID: request.requestID,
    recipientSessionID: architect.sessionID,
    status: "pending",
  })
  expect(f.handoffs().finalize(finalInput, architect).status).toBe("replayed")
  expect(
    f.handoffs().finalize({ ...finalInput, finalizationID: crypto.randomUUID() }, architect).status,
  ).toBe("conflict")
  const finalizationContenderRepository = new TaskRepository(f.path, f.projectDirectory)
  try {
    const contender = new HandoffStore(finalizationContenderRepository)
    expect(contender.finalize(finalInput, architect).status).toBe("replayed")
  } finally {
    finalizationContenderRepository.close()
  }
  expect(f.handoffs().pendingNotifications()).toHaveLength(1)
  expect(
    f
      .repository()
      .atomic(
        (db) =>
          db
            .query<{ state: string }, [string, string]>(
              "SELECT state FROM runner_nodes WHERE plan_id=? AND task_id=?",
            )
            .get(f.planID, f.task.id)!.state,
      ),
  ).toBe(beforeState)

  rmSync(f.workspace, { recursive: true, force: true })
  expect(existsSync(f.workspace)).toBe(false)
  const reopened = f.reopen()
  expect(reopened.handoffs.getReviewRound(request.requestID, input.reviewID, 1)?.outcome).toEqual(
    savedOutcome,
  )
  expect(
    reopened.handoffs.getReport(request.requestID, finalized.report.reportID)?.source.attachment,
  ).toEqual(request.source.attachment)
  expect(
    reopened.handoffs.getReport(request.requestID, finalized.report.reportID)?.source.attempt
      .workspace,
  ).toBe(f.workspace)
  const page = reopened.handoffs.readHistory({ requestID: request.requestID, limit: 20 })!
  expect(page.events.map((event) => event.kind)).toEqual([
    "report-finalized",
    "review-completed",
    "review-reserved",
    "draft-saved",
    "request-created",
  ])
})

test("the assigned worker can review and finalize only its current request; stale workers and Architect continuations cannot", () => {
  const f = fixture()
  const request = makeRequest(f)
  const draftReceipt = f
    .handoffs()
    .saveDraft(
      { requestID: request.requestID, draftID: crypto.randomUUID(), draft: draft() },
      worker,
    )
  if (draftReceipt.status === "conflict") throw new Error(draftReceipt.message)
  expect(f.reopen().handoffs.getDraft(request.requestID, draftReceipt.record.draftVersion)).toEqual(
    draftReceipt.record,
  )
  const input = reservation(request.requestID, draftReceipt.record.draftVersion)
  expect(f.handoffs().reserveRound(input, worker).status).toBe("created")
  const savedOutcome = outcome()
  expect(
    f
      .handoffs()
      .recordReviewOutcome(
        { requestID: request.requestID, reviewID: input.reviewID, round: 1, outcome: savedOutcome },
        worker,
      ).status,
  ).toBe("recorded")
  const finalization = {
    finalizationID: crypto.randomUUID(),
    requestID: request.requestID,
    draftVersion: draftReceipt.record.draftVersion,
    reviewID: input.reviewID,
    round: 1,
  }
  const finalized = f.handoffs().finalize(finalization, worker)
  expect(finalized.status).toBe("finalized")
  if (finalized.status === "conflict") throw new Error(finalized.message)
  expect(finalized.report.finalizedBy).toEqual(worker)

  const historyBefore = f.handoffs().readHistory({ requestID: request.requestID })!.events.length
  expect(() =>
    f.handoffs().reserveRound(input, { ...worker, sessionID: "foreign-worker" }),
  ).toThrow("not the worker assigned")
  expect(() =>
    f
      .handoffs()
      .recordReviewOutcome(
        { requestID: request.requestID, reviewID: input.reviewID, round: 1, outcome: savedOutcome },
        { ...worker, sessionID: "foreign-worker" },
      ),
  ).toThrow("not the worker assigned")
  expect(f.handoffs().readHistory({ requestID: request.requestID })!.events).toHaveLength(
    historyBefore,
  )

  f.repository().atomic((db) => {
    db.query("INSERT INTO runner_continuations VALUES(?,?,?,?,?,?)").run(
      f.planID,
      "historical-architect-session",
      "architect-session",
      f.projectDirectory,
      null,
      1,
    )
  })
  const oldArchitect = { ...architect, sessionID: "historical-architect-session" }
  expect(() =>
    f.handoffs().reserveRound({ ...input, reviewID: crypto.randomUUID() }, oldArchitect),
  ).toThrow("not the current owner")
  expect(() =>
    f.handoffs().recordDisposition(
      {
        dispositionID: crypto.randomUUID(),
        requestID: request.requestID,
        reportID: finalized.report.reportID,
        decision: "continue",
        correction: { status: "not-applicable" },
        reason: "Keep the existing contract.",
        evidence: [],
        question: { status: "not-applicable" },
        answer: { status: "not-applicable" },
        relatedTaskIDs: [],
      },
      oldArchitect,
    ),
  ).toThrow("not the current owner")

  const nextRequest = makeRequest(f, "handoff-request-2")
  expect(nextRequest.requestGeneration).toBe(2)
  expect(() =>
    f
      .handoffs()
      .saveDraft(
        { requestID: request.requestID, draftID: crypto.randomUUID(), draft: draft("stale") },
        worker,
      ),
  ).toThrow("request generation is stale")
  expect(() =>
    f.handoffs().reserveRound({ ...input, reviewID: crypto.randomUUID(), round: 2 }, worker),
  ).toThrow("request generation is stale")
  expect(f.handoffs().getRequest(nextRequest.requestID)?.source.attachment.requestGeneration).toBe(
    2,
  )

  f.repository().atomic((db) => {
    db.query("UPDATE runner_attempts SET session_id=? WHERE id=?").run(
      "replacement-worker",
      f.attemptID,
    )
  })
  expect(() =>
    f
      .handoffs()
      .saveDraft(
        { requestID: nextRequest.requestID, draftID: crypto.randomUUID(), draft: draft() },
        worker,
      ),
  ).toThrow("source attempt is stale")
})

test("disabled/unavailable review limitations and append-only Architect dispositions preserve unknown answers", () => {
  const f = fixture()
  const request = makeRequest(f)
  const draftReceipt = f
    .handoffs()
    .saveDraft(
      { requestID: request.requestID, draftID: crypto.randomUUID(), draft: draft() },
      worker,
    )
  if (draftReceipt.status === "conflict") throw new Error(draftReceipt.message)
  const input = reservation(request.requestID, draftReceipt.record.draftVersion)
  f.handoffs().reserveRound(input, architect)
  const disabled = outcome("disabled")
  expect(
    f
      .handoffs()
      .recordReviewOutcome(
        { requestID: request.requestID, reviewID: input.reviewID, round: 1, outcome: disabled },
        architect,
      ).status,
  ).toBe("recorded")
  const finalized = f.handoffs().finalize(
    {
      finalizationID: crypto.randomUUID(),
      requestID: request.requestID,
      draftVersion: draftReceipt.record.draftVersion,
      reviewID: input.reviewID,
      round: 1,
    },
    architect,
  )
  if (finalized.status === "conflict") throw new Error(finalized.message)
  expect(finalized.report.reviewStatus).toBe("disabled")
  expect(finalized.report.limitation).toBe("Local review is disabled.")
  expect(finalized.report.review.outcome?.usage.inputTokens).toBeNull()
  expect(finalized.report.review.outcome?.result).toBeNull()

  const disposition = {
    dispositionID: crypto.randomUUID(),
    requestID: request.requestID,
    reportID: finalized.report.reportID,
    decision: "clarify" as const,
    correction: { status: "unknown" as const, reason: "The answer has not been received." },
    reason: "The available evidence does not yet settle the product decision.",
    evidence: [{ kind: "trajectory" as const, reference: "attempt:failed-check" }],
    question: { status: "recorded" as const, reference: "message:question-123" },
    answer: { status: "unknown" as const },
    relatedTaskIDs: [],
  }
  const firstDisposition = f.handoffs().recordDisposition(disposition, architect)
  expect(firstDisposition.status).toBe("recorded")
  if (firstDisposition.status === "conflict") throw new Error(firstDisposition.message)
  expect(firstDisposition.record.answer).toEqual({ status: "unknown" })
  expect(f.handoffs().recordDisposition(disposition, architect).status).toBe("replayed")
  expect(() =>
    f.handoffs().recordDisposition(
      {
        ...disposition,
        question: { status: "unknown" },
        answer: { status: "recorded", reference: "model-guessed-answer" },
      },
      architect,
    ),
  ).toThrow("actual question reference")

  const corrected = {
    ...disposition,
    dispositionID: crypto.randomUUID(),
    decision: "redirect" as const,
    correction: {
      status: "known" as const,
      value: "Continue with the unchanged authorized task outcome.",
    },
    reason: "A later recorded answer resolves the decision without weakening acceptance.",
    answer: { status: "recorded" as const, reference: "message:answer-456" },
  }
  expect(f.handoffs().recordDisposition(corrected, architect).status).toBe("recorded")

  const unavailableDraft = f.handoffs().saveDraft(
    {
      requestID: request.requestID,
      draftID: crypto.randomUUID(),
      draft: draft("An updated report preserves the unresolved cause."),
    },
    worker,
  )
  if (unavailableDraft.status === "conflict") throw new Error(unavailableDraft.message)
  const unavailableReview = reservation(
    request.requestID,
    unavailableDraft.record.draftVersion,
    input.reviewID,
    2,
  )
  f.handoffs().reserveRound(unavailableReview, architect)
  const unavailable = outcome("unavailable")
  f.handoffs().recordReviewOutcome(
    {
      requestID: request.requestID,
      reviewID: unavailableReview.reviewID,
      round: unavailableReview.round,
      outcome: unavailable,
    },
    architect,
  )
  const unavailableReport = f.handoffs().finalize(
    {
      finalizationID: crypto.randomUUID(),
      requestID: request.requestID,
      draftVersion: unavailableDraft.record.draftVersion,
      reviewID: unavailableReview.reviewID,
      round: unavailableReview.round,
    },
    architect,
  )
  if (unavailableReport.status === "conflict") throw new Error(unavailableReport.message)
  expect(unavailableReport.report.reviewStatus).toBe("unavailable")
  expect(unavailableReport.report.limitation).toBe("The local review transport did not complete.")
  expect(f.handoffs().pendingNotifications()).toHaveLength(2)

  rmSync(f.workspace, { recursive: true, force: true })
  expect(existsSync(f.workspace)).toBe(false)
  const reopened = f.reopen()
  expect(
    reopened.handoffs.getDisposition(request.requestID, corrected.dispositionID)?.correction,
  ).toEqual(corrected.correction)
  expect(
    reopened.handoffs.getReport(request.requestID, unavailableReport.report.reportID)?.source
      .attempt.workspace,
  ).toBe(f.workspace)
  const history = reopened.handoffs.readHistory({ requestID: request.requestID, limit: 20 })!
  const dispositionEvents = history.events.filter((event) => event.kind === "architect-disposition")
  expect(dispositionEvents).toHaveLength(2)
  expect((dispositionEvents[0]!.data as { answer: { status: string } }).answer.status).toBe(
    "recorded",
  )
  expect((dispositionEvents[1]!.data as { answer: { status: string } }).answer.status).toBe(
    "unknown",
  )
})
