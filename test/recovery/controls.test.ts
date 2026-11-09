import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { SessionMessage } from "@opencode/schema/session-message"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema } from "effect"
import { HandoffDraft } from "../../src/recovery/handoff/schema.ts"
import { HandoffReviewer } from "../../src/recovery/handoff/review.ts"
import {
  HANDOFF_REVIEW_RESERVATION_LEASE_MS,
  HandoffStore,
} from "../../src/recovery/handoff/store.ts"
import { registerRecoveryTools } from "../../src/recovery/tools.ts"
import { TaskRepository } from "../../src/storage.ts"
import { makeFixture, secondAttemptID } from "../trajectory/fixture.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
})

function toolContext(sessionID: string, agent: string, suffix: string, messageID?: string) {
  return {
    sessionID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionID")))(sessionID),
    agent: Agent.ID.make(agent),
    messageID: SessionMessage.ID.make(messageID ?? `msg_${suffix}`),
    id: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Tool.CallID")))(`call_${suffix}`),
    progress: () => Effect.void,
  } as unknown as Parameters<RegisteredTool["execute"]>[1]
}

type ConcernReceipt = { status: string; record: { version: number } }
type DecisionReceipt = {
  status: string
  record: { version: number; followUp?: { condition: string } }
}
type ConcernPage = {
  concerns: Array<{
    concern: {
      version: number
      evidenceBoundary: { fromSequence: number; throughSequence: number }
    }
    dispositions: Array<{ followUp?: { condition: string } }>
  }>
  nextCursor: string | null
}
type CheckpointState = {
  delivery: { status: string; detail?: string }
  command: {
    messageID: string
    source: { sessionID: string; workspace: string }
  }
  consumption: { messageID: string } | null
  response: { completed: string } | null
}
type CheckpointResponse = { record: { observedCallID: string; reportedBy: { sessionID: string } } }
type HandoffRequest = { record: { requestID: string; requestGeneration: number } }
type HandoffReview = {
  status: string
  fingerprint: string
  limitation: string | null
  errors?: string[]
  draftID: string
  draftVersion: number
  reviewID: string
  round: number
}
type HandoffFinalization = {
  report: {
    reportID: string
    reviewStatus: string
    finalizedBy: { sessionID: string }
    review: { reviewer: { sessionID: string }; round: number }
    reviewResult?: { fingerprint: string; status: string }
  }
}
type HandoffRead = {
  reports: Array<{ reportID: string }>
  dispositions: Array<{ version: number; correction: { value: string } }>
}

function draft() {
  return HandoffDraft.parse({
    target: {
      outcome: { status: "known", value: "Preserve the original authorized task outcome." },
      originalUserIntent: { status: "unknown", reason: "The task record is the available source." },
      workerInterpretation: { status: "known", value: "Implement the recorded acceptance." },
      contractReferences: [{ kind: "acceptance", reference: "task:accepted" }],
    },
    completedWork: [],
    partialWork: [{ summary: "Recorded the observed partial result.", evidence: [] }],
    workspaceState: { status: "known", value: "The original workspace is retained." },
    approaches: [],
    failure: {
      status: "blocked",
      behavior: { status: "known", value: "The expected check could not complete." },
      cause: "unknown",
      evidence: [{ kind: "verification", reference: "check:observed" }],
    },
    assumptions: [],
    evidence: [{ kind: "trajectory", reference: "attempt:current" }],
    preservedObligations: [
      { requirement: "Keep task acceptance unchanged.", sourceReference: "task:accepted" },
    ],
    remainingWork: { status: "known", value: "Complete the missing behavior and rerun checks." },
    remainingDecisions: { status: "not-applicable" },
    reportedOwnership: {
      writerActivity: { status: "known", value: "The worker is still assigned." },
      backgroundActivity: { status: "unknown" },
      unresolvedNativeEffects: { status: "unknown" },
      reportedQuiescence: "unknown",
    },
  })
}

async function setup(
  options: {
    deny?: boolean
    syntheticError?: boolean
    replaceDuringSessionRead?: boolean
    reviewResult?: "completed" | "feedback"
  } = {},
) {
  const fixture = makeFixture()
  fixture.store.atomic((db) => {
    db.query("UPDATE runner_attempts SET state='running',policy=? WHERE id=?").run(
      JSON.stringify({ agent: "lazers-implementor" }),
      secondAttemptID,
    )
  })
  const tools = new Map<string, RegisteredTool>()
  const permissionCalls: string[] = []
  const syntheticCalls: Array<{ sessionID: string; id: string; text: string }> = []
  const reviewInputs: unknown[] = []
  const messages = new Map<string, Array<{ id: string; type: string }>>()
  let insertedDuringRead = false
  const editor: ToolEditor = {
    add: (tool) => tools.set(tool.name, tool),
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  const transform = ((callback: Parameters<Plugin.Context["tool"]["transform"]>[0]) =>
    Effect.sync(() => {
      callback(editor)
      return { dispose: Effect.void }
    })) as Plugin.Context["tool"]["transform"]
  const fakeContext = {
    permission: {
      assert: (input: Parameters<Plugin.Context["permission"]["assert"]>[0]) => {
        permissionCalls.push(String(input.action))
        return options.deny ? Effect.die(new Error("Permission denied")) : Effect.void
      },
    },
    tool: { transform },
    location: {
      directory: fixture.directory,
      project: { id: "project", canonical: fixture.directory },
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) => {
        if (options.replaceDuringSessionRead && !insertedDuringRead) {
          insertedDuringRead = true
          fixture.store.atomic((db) => {
            db.query(
              `INSERT INTO runner_attempts
               (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,
                started_at,token_count,tool_count,retry_count,cost)
               SELECT ?,plan_id,task_id,number+1,?,?,workspace,base_commit,policy,'running',
                      started_at+1,0,0,0,NULL FROM runner_attempts WHERE id=?`,
            ).run(crypto.randomUUID(), "ses-race-replacement", "msg-race", secondAttemptID)
          })
        }
        return Effect.succeed({
          id: String(sessionID),
          projectID: "project",
          agent: "lazers-implementor",
          location: { directory: fixture.directory },
        })
      },
      synthetic: (input: { sessionID: string; id: string; text: string }) => {
        syntheticCalls.push({
          sessionID: String(input.sessionID),
          id: String(input.id),
          text: input.text,
        })
        if (options.syntheticError) return Effect.fail(new Error("admission reply was lost"))
        messages.set(String(input.sessionID), [
          ...(messages.get(String(input.sessionID)) ?? []),
          { id: String(input.id), type: "synthetic" },
        ])
        return Effect.succeed({ id: input.id })
      },
      context: ({ sessionID }: { sessionID: string }) =>
        Effect.succeed(messages.get(String(sessionID)) ?? []),
    },
    rpc: () => ({
      review: (input: unknown) => {
        reviewInputs.push(input)
        if (options.reviewResult) {
          const questions =
            typeof input === "object" && input !== null && "questions" in input
              ? input.questions
              : undefined
          const questionIDs =
            typeof questions === "object" && questions !== null ? Object.keys(questions) : []
          const probability = options.reviewResult === "completed" ? 0.95 : 0.1
          return Effect.succeed({
            model: "d1-omni-2b",
            answers: Object.fromEntries(
              questionIDs.map((id) => [id, { type: "noul", noul: probability }]),
            ),
            usage: { input_tokens: 42, output_tokens: 0 },
          })
        }
        return Effect.fail(new Error("local review is unavailable"))
      },
    }),
  } as unknown as Pick<Plugin.Context, "tool" | "permission" | "location" | "session" | "rpc">
  const register = (repository: TaskRepository = fixture.repository) =>
    Effect.runPromise(Effect.scoped(registerRecoveryTools(fakeContext, repository)))
  await register()
  cleanup.push(() => fixture.close())
  return {
    fixture,
    tools,
    permissionCalls,
    syntheticCalls,
    reviewInputs,
    messages,
    register,
    invoke: async <T = unknown>(
      name: string,
      input: unknown,
      call: ReturnType<typeof toolContext>,
    ): Promise<T> => {
      const tool = tools.get(name)
      if (!tool) throw new Error(`Missing registered tool ${name}`)
      const result = await Effect.runPromise(tool.execute(input, call))
      return result.output as T
    },
  }
}

const architect = (suffix: string) => toolContext("ses-owner", "architect", suffix)
const worker = (suffix: string, messageID?: string) =>
  toolContext("ses-accepted", "lazers-implementor", suffix, messageID)

test("registered controls preserve concern decisions, tracked same-worker checkpoint and reviewed handoff", async () => {
  const f = await setup()
  for (const name of [
    "lz-inspect-recovery",
    "lz-record-recovery-concern",
    "lz-disposition-recovery-concern",
    "lz-checkpoint-recovery-worker",
    "lz-respond-recovery-checkpoint",
    "lz-request-handoff",
    "lz-submit-handoff",
    "lz-verify-handoff",
    "lz-disposition-handoff",
    "lz-read-handoff",
  ])
    expect(f.tools.has(name)).toBe(true)
  expect(f.tools.has("lz-finalize-handoff")).toBe(false)

  const concernID = crypto.randomUUID()
  const firstConcernInput = {
    requestID: "concern-version-1",
    concernID,
    sourceAttemptID: secondAttemptID,
    expectedVersion: 0,
    ruleID: "no-forward-progress",
    reason: "The latest check did not establish the agreed outcome.",
    evidenceBoundary: { fromSequence: 12, throughSequence: 15 },
    evidence: [{ kind: "verification", reference: "check:observed" }],
  }
  const firstConcern = await f.invoke<ConcernReceipt>(
    "lz-record-recovery-concern",
    firstConcernInput,
    architect("concern-v1"),
  )
  expect(firstConcern.record.version).toBe(1)
  const duplicateConcern = await f.invoke<ConcernReceipt>(
    "lz-record-recovery-concern",
    firstConcernInput,
    architect("concern-retry"),
  )
  expect(duplicateConcern.status).toBe("replayed")

  const followUpInput = {
    requestID: "decision-version-1",
    dispositionID: crypto.randomUUID(),
    concernID,
    expectedVersion: 1,
    decision: "follow-up",
    reason: "Reassess after the worker attempts the identified next check.",
    evidenceBoundary: { fromSequence: 12, throughSequence: 15 },
    followUp: {
      kind: "condition" as const,
      condition: "The next independent verification completes.",
    },
  }
  const decision = await f.invoke<DecisionReceipt>(
    "lz-disposition-recovery-concern",
    followUpInput,
    architect("decision"),
  )
  expect(decision.record.followUp?.condition).toContain("verification")
  await expect(
    f.invoke(
      "lz-disposition-recovery-concern",
      { ...followUpInput, expectedVersion: 2, requestID: "stale-decision" },
      architect("stale-decision"),
    ),
  ).rejects.toThrow("version conflict")

  const secondConcern = await f.invoke<ConcernReceipt>(
    "lz-record-recovery-concern",
    {
      ...firstConcernInput,
      requestID: "concern-version-2",
      expectedVersion: 1,
      reason: "A new verification event is now available for reassessment.",
      evidenceBoundary: { fromSequence: 16, throughSequence: 18 },
      evidence: [{ kind: "verification", reference: "check:next" }],
    },
    architect("concern-v2"),
  )
  expect(secondConcern.record.version).toBe(2)

  const inspected = await f.invoke<ConcernPage>(
    "lz-inspect-recovery",
    { attemptID: secondAttemptID },
    architect("inspect"),
  )
  expect(inspected.concerns[0]?.concern.version).toBe(2)
  expect(inspected.concerns[0]?.dispositions[0]?.followUp).toEqual(followUpInput.followUp)
  expect(inspected.nextCursor).toBeNull()
  expect(f.syntheticCalls).toHaveLength(0)

  const checkpointInput = {
    requestID: "checkpoint-once",
    attemptID: secondAttemptID,
    concernID,
    expectedVersion: 2,
    evidenceBoundary: { fromSequence: 16, throughSequence: 18 },
    guidance: "Report what changed, any blockers, and a materially useful next approach.",
  }
  const checkpoint = await f.invoke<CheckpointState>(
    "lz-checkpoint-recovery-worker",
    checkpointInput,
    architect("checkpoint"),
  )
  expect(checkpoint.delivery).toMatchObject({ status: "admitted" })
  expect(checkpoint.command.source.sessionID).toBe("ses-accepted")
  expect(checkpoint.command.source.workspace).toBe(f.fixture.directory)
  expect(checkpoint.consumption).toBeNull()
  expect(checkpoint.response).toBeNull()
  expect(f.syntheticCalls).toHaveLength(1)
  expect(f.syntheticCalls[0]?.text).toContain("continue the same task and workspace")
  const replayedCheckpoint = await f.invoke<CheckpointState>(
    "lz-checkpoint-recovery-worker",
    checkpointInput,
    architect("checkpoint-replay"),
  )
  expect(replayedCheckpoint.command.messageID).toBe(checkpoint.command.messageID)
  expect(f.syntheticCalls).toHaveLength(1)

  const responseInput = {
    requestID: checkpointInput.requestID,
    completed: "Compared the new check with the requested outcome.",
    attempted: ["Reran the focused check."],
    currentBlockers: [],
    nextApproach: "Inspect the failing boundary and make a targeted correction.",
    evidence: [{ kind: "verification", reference: "check:next" }],
  }
  const syntheticHistory = f.messages.get("ses-accepted") ?? []
  const prematureCall = worker("checkpoint-premature", "msg_premature_response")
  f.messages.set("ses-accepted", [{ id: String(prematureCall.messageID), type: "assistant" }])
  await expect(
    f.invoke("lz-respond-recovery-checkpoint", responseInput, prematureCall),
  ).rejects.toThrow("exact checkpoint request")
  f.messages.set("ses-accepted", syntheticHistory)

  const responseCall = worker("checkpoint-response", "msg_worker_response")
  f.messages.set("ses-accepted", [
    ...(f.messages.get("ses-accepted") ?? []),
    { id: String(responseCall.messageID), type: "assistant" },
  ])
  const response = await f.invoke<CheckpointResponse>(
    "lz-respond-recovery-checkpoint",
    responseInput,
    responseCall,
  )
  expect(response.record.observedCallID).toBe(String(responseCall.id))
  expect(response.record.reportedBy.sessionID).toBe("ses-accepted")
  const completedCheckpoint = await f.invoke<CheckpointState>(
    "lz-checkpoint-recovery-worker",
    checkpointInput,
    architect("checkpoint-readback"),
  )
  expect(completedCheckpoint.consumption?.messageID).toBe(checkpoint.command.messageID)
  expect(completedCheckpoint.response?.completed).toContain("Compared")

  const request = await f.invoke<HandoffRequest>(
    "lz-request-handoff",
    {
      requestID: "handoff-source-request",
      sourceAttemptID: secondAttemptID,
      request: {
        purpose: "Preserve observed progress and identify the remaining recovery work.",
        references: [{ kind: "trajectory", reference: "attempt:current" }],
      },
    },
    architect("handoff-request"),
  )
  expect(request.record.requestID).toBe("handoff-source-request")

  const submittedDraft = draft()
  const draftID = crypto.randomUUID()
  await expect(
    f.invoke(
      "lz-submit-handoff",
      {
        finalizationID: crypto.randomUUID(),
        requestID: request.record.requestID,
        draftVersion: 1,
        reviewID: crypto.randomUUID(),
        round: 1,
      },
      worker("handoff-submit-before-review"),
    ),
  ).rejects.toThrow("Draft version is not attached")
  const review = await f.invoke<HandoffReview>(
    "lz-verify-handoff",
    {
      requestID: request.record.requestID,
      draftID,
      draft: submittedDraft,
      evidence: [{ kind: "trajectory", reference: "attempt:current" }],
    },
    worker("handoff-review"),
  )
  expect(review.status).toBe("unavailable")
  expect(review.limitation).toBeTruthy()
  expect(review.draftID).toBe(draftID)
  expect(review.draftVersion).toBe(1)

  const revisedDraft = HandoffDraft.parse({
    ...submittedDraft,
    remainingWork: {
      status: "known",
      value: "This newer unreviewed version must not inherit the old review.",
    },
  })
  const seededVersion = new HandoffStore(f.fixture.repository).saveDraft(
    {
      requestID: request.record.requestID,
      draftID: crypto.randomUUID(),
      draft: revisedDraft,
    },
    { sessionID: "ses-accepted", agent: "lazers-implementor", role: "worker" },
  )
  if (seededVersion.status === "conflict") throw new Error(seededVersion.message)
  expect(seededVersion.record.draftVersion).toBe(2)
  await expect(
    f.invoke(
      "lz-submit-handoff",
      {
        finalizationID: crypto.randomUUID(),
        requestID: request.record.requestID,
        draftVersion: seededVersion.record.draftVersion,
        reviewID: review.reviewID,
        round: review.round,
      },
      worker("handoff-stale-submit"),
    ),
  ).rejects.toThrow("Review result is missing, stale, or belongs to another draft/caller")

  const finalized = await f.invoke<HandoffFinalization>(
    "lz-submit-handoff",
    {
      finalizationID: crypto.randomUUID(),
      requestID: request.record.requestID,
      draftVersion: review.draftVersion,
      reviewID: review.reviewID,
      round: review.round,
    },
    worker("handoff-submit"),
  )
  expect(finalized.report.reviewStatus).toBe("unavailable")
  const detail = await f.invoke<HandoffRead>(
    "lz-read-handoff",
    { requestID: request.record.requestID },
    architect("handoff-read"),
  )
  expect(detail.reports[0]?.reportID).toBe(finalized.report.reportID)

  const correctionInput = {
    dispositionID: crypto.randomUUID(),
    requestID: request.record.requestID,
    reportID: finalized.report.reportID,
    expectedVersion: 0,
    decision: "correct",
    correction: { status: "known", value: "The remaining work is the narrow failing check." },
    reason: "Clarify the next worker's starting point without changing the task contract.",
    evidence: [{ kind: "verification", reference: "check:observed" }],
    question: { status: "not-applicable" },
    answer: { status: "not-applicable" },
    relatedTaskIDs: [],
  }
  const correction = await f.invoke<DecisionReceipt>(
    "lz-disposition-handoff",
    correctionInput,
    architect("handoff-correction"),
  )
  expect(correction.record.version).toBe(1)
  await expect(
    f.invoke(
      "lz-disposition-handoff",
      {
        ...correctionInput,
        dispositionID: crypto.randomUUID(),
      },
      architect("stale-handoff-disposition"),
    ),
  ).rejects.toThrow("version conflict")
  const workerRead = await f.invoke<HandoffRead>(
    "lz-read-handoff",
    { requestID: request.record.requestID },
    worker("handoff-worker-read"),
  )
  expect(workerRead.dispositions[0]?.correction.value).toContain("failing check")

  const newerRequest = await f.invoke<HandoffRequest>(
    "lz-request-handoff",
    {
      requestID: "handoff-follow-up-request",
      sourceAttemptID: secondAttemptID,
      request: {
        purpose: "Capture any new material evidence without replacing the prior handoff.",
        references: [{ kind: "trajectory", reference: "attempt:current" }],
      },
    },
    architect("handoff-follow-up-request"),
  )
  expect(newerRequest.record.requestGeneration).toBe(request.record.requestGeneration + 1)
  const olderReadAfterNewRequest = await f.invoke<HandoffRead>(
    "lz-read-handoff",
    { requestID: request.record.requestID },
    architect("handoff-read-older"),
  )
  expect(olderReadAfterNewRequest.reports[0]?.reportID).toBe(finalized.report.reportID)

  const reopenedRepository = new TaskRepository(f.fixture.repository.path, f.fixture.directory)
  try {
    const reopenedStore = new HandoffStore(reopenedRepository)
    const persistedConcern = reopenedStore.readConcerns(
      { attemptID: secondAttemptID },
      { sessionID: "ses-owner", agent: "architect", role: "architect" },
    )
    expect(persistedConcern?.concerns[0]?.concern.version).toBe(2)
    expect(persistedConcern?.concerns[0]?.concern.evidenceBoundary).toEqual({
      fromSequence: 16,
      throughSequence: 18,
    })
    expect(persistedConcern?.concerns[0]?.dispositions[0]?.followUp).toEqual(followUpInput.followUp)
    const persistedHandoff = reopenedStore.readHandoff(
      { requestID: request.record.requestID },
      { sessionID: "ses-owner", agent: "architect", role: "architect" },
    )
    expect(persistedHandoff?.dispositions[0]?.version).toBe(1)
  } finally {
    reopenedRepository.close()
  }
})

test("registered verification lets the current Architect review only an existing worker draft", async () => {
  const f = await setup()
  const request = await f.invoke<HandoffRequest>(
    "lz-request-handoff",
    {
      requestID: "architect-review-existing-draft",
      sourceAttemptID: secondAttemptID,
      request: {
        purpose: "Review the worker's exact persisted handoff without changing its authorship.",
        references: [{ kind: "trajectory", reference: "attempt:current" }],
      },
    },
    architect("architect-review-request"),
  )
  const submittedDraft = draft()
  const draftID = crypto.randomUUID()
  const workerReview = await f.invoke<HandoffReview>(
    "lz-verify-handoff",
    {
      requestID: request.record.requestID,
      draftID,
      draft: submittedDraft,
      evidence: [{ kind: "trajectory", reference: "attempt:worker-review" }],
    },
    worker("worker-create-draft"),
  )
  expect(workerReview.draftVersion).toBe(1)

  const store = new HandoffStore(f.fixture.repository)
  const persistedWorkerDraft = store.getDraft(request.record.requestID, 1)
  expect(persistedWorkerDraft).toMatchObject({
    draftID,
    author: { sessionID: "ses-accepted", agent: "lazers-implementor", role: "worker" },
    draft: submittedDraft,
  })
  const architectReview = await f.invoke<HandoffReview>(
    "lz-verify-handoff",
    {
      requestID: request.record.requestID,
      draftVersion: 1,
      evidence: [{ kind: "trajectory", reference: "attempt:architect-review" }],
      reviewID: workerReview.reviewID,
    },
    architect("architect-review-existing"),
  )
  expect(architectReview).toMatchObject({
    status: "unavailable",
    draftID,
    draftVersion: 1,
    reviewID: workerReview.reviewID,
    round: 2,
  })
  expect(store.getReviewRound(request.record.requestID, workerReview.reviewID, 2)).toMatchObject({
    draftVersion: 1,
    reviewer: { sessionID: "ses-owner", agent: "architect", role: "architect" },
  })
  expect(store.getDraft(request.record.requestID, 1)).toEqual(persistedWorkerDraft)
  expect(f.reviewInputs).toHaveLength(2)
  expect(f.reviewInputs[1]).toMatchObject({ state: { draft: submittedDraft } })

  const changedDraft = HandoffDraft.parse({
    ...submittedDraft,
    remainingWork: { status: "known", value: "An Architect must not substitute this data." },
  })
  await expect(
    f.invoke(
      "lz-verify-handoff",
      {
        requestID: request.record.requestID,
        draftID: crypto.randomUUID(),
        draft: changedDraft,
        evidence: [],
      },
      architect("architect-cannot-author"),
    ),
  ).rejects.toThrow("Architects may review only an existing worker-authored draft version")
  expect(store.getDraft(request.record.requestID, 2)).toBeUndefined()

  const changedWorkerSubmission = await f.invoke<{ status: string; message: string }>(
    "lz-verify-handoff",
    {
      requestID: request.record.requestID,
      draftID,
      draft: changedDraft,
      evidence: [{ kind: "trajectory", reference: "attempt:changed-data" }],
    },
    worker("worker-changed-data"),
  )
  expect(changedWorkerSubmission).toMatchObject({
    status: "conflict",
    message: "draftID already identifies different handoff content",
  })
  expect(store.getDraft(request.record.requestID, 1)).toEqual(persistedWorkerDraft)

  const existingDraftInput = {
    requestID: request.record.requestID,
    draftVersion: 1,
    evidence: [{ kind: "trajectory" as const, reference: "attempt:architect-review" }],
    reviewID: workerReview.reviewID,
  }
  await expect(
    f.invoke(
      "lz-verify-handoff",
      existingDraftInput,
      toolContext("ses-foreign", "architect", "foreign-review"),
    ),
  ).rejects.toThrow("Handoff caller is not the current owner of the source plan")
  await expect(
    f.invoke(
      "lz-verify-handoff",
      { ...existingDraftInput, draftVersion: 2 },
      architect("architect-stale-draft"),
    ),
  ).rejects.toThrow("Draft version is not attached to this request")
  await expect(
    f.invoke(
      "lz-verify-handoff",
      { ...existingDraftInput, draftID, draft: changedDraft },
      architect("architect-changed-data"),
    ),
  ).rejects.toThrow(/Unrecognized key|Invalid input/)
  expect(f.reviewInputs).toHaveLength(2)
})

test("registered Architect replays a terminal worker result and finalizes its exact review", async () => {
  const f = await setup({ reviewResult: "completed" })
  const request = await f.invoke<HandoffRequest>(
    "lz-request-handoff",
    {
      requestID: "architect-terminal-replay",
      sourceAttemptID: secondAttemptID,
      request: {
        purpose: "Finalize the exact terminal result already produced for the worker draft.",
        references: [{ kind: "trajectory", reference: "attempt:current" }],
      },
    },
    architect("terminal-request"),
  )
  const evidence = [{ kind: "trajectory" as const, reference: "attempt:terminal-result" }]
  const workerResult = await f.invoke<HandoffReview>(
    "lz-verify-handoff",
    {
      requestID: request.record.requestID,
      draftID: crypto.randomUUID(),
      draft: draft(),
      evidence,
    },
    worker("terminal-worker-review"),
  )
  expect(workerResult.status).toBe("completed")

  const finalization = {
    finalizationID: crypto.randomUUID(),
    requestID: request.record.requestID,
    draftVersion: workerResult.draftVersion,
    reviewID: workerResult.reviewID,
    round: workerResult.round,
    fingerprint: workerResult.fingerprint,
  }
  await expect(
    f.invoke("lz-submit-handoff", finalization, architect("terminal-submit-before-review")),
  ).rejects.toThrow("Review result is missing, stale, or belongs to another draft/caller")

  const architectResult = await f.invoke<HandoffReview>(
    "lz-verify-handoff",
    {
      requestID: request.record.requestID,
      draftVersion: workerResult.draftVersion,
      reviewID: workerResult.reviewID,
      evidence,
    },
    architect("terminal-architect-replay"),
  )
  expect(architectResult).toMatchObject({
    status: "completed",
    round: workerResult.round,
    fingerprint: workerResult.fingerprint,
  })
  expect(f.reviewInputs).toHaveLength(1)

  await expect(
    f.invoke(
      "lz-submit-handoff",
      { ...finalization, finalizationID: crypto.randomUUID(), fingerprint: "f".repeat(64) },
      architect("terminal-submit-stale-result"),
    ),
  ).rejects.toThrow("Review result is missing, stale, or belongs to another draft/caller")
  await expect(
    f.invoke(
      "lz-submit-handoff",
      finalization,
      toolContext("ses-foreign", "architect", "terminal-submit-foreign"),
    ),
  ).rejects.toThrow("Handoff caller is not the current owner of the source plan")

  const finalized = await f.invoke<HandoffFinalization>(
    "lz-submit-handoff",
    { ...finalization, finalizationID: crypto.randomUUID() },
    architect("terminal-submit"),
  )
  expect(finalized.report).toMatchObject({
    reviewStatus: "reviewed",
    finalizedBy: { sessionID: "ses-owner" },
    review: { reviewer: { sessionID: "ses-accepted" }, round: workerResult.round },
    reviewResult: { fingerprint: workerResult.fingerprint, status: "completed" },
  })
  const store = new HandoffStore(f.fixture.repository)
  expect(
    store.getReviewRound(request.record.requestID, workerResult.reviewID, 1)?.reviewer,
  ).toEqual({ sessionID: "ses-accepted", agent: "lazers-implementor", role: "worker" })
  expect(store.getReviewRound(request.record.requestID, workerResult.reviewID, 2)).toBeUndefined()
  expect(
    store
      .readHistory({ requestID: request.record.requestID })!
      .events.filter((event) => event.kind === "review-finalization-authorized"),
  ).toHaveLength(1)
})

test("registered Architect finalizes the terminal result after three consumed review rounds", async () => {
  const f = await setup({ reviewResult: "feedback" })
  const request = await f.invoke<HandoffRequest>(
    "lz-request-handoff",
    {
      requestID: "architect-exhausted-review",
      sourceAttemptID: secondAttemptID,
      request: {
        purpose: "Preserve the unresolved handoff after the bounded review chain is exhausted.",
        references: [{ kind: "trajectory", reference: "attempt:current" }],
      },
    },
    architect("exhausted-request"),
  )
  let lastReview: HandoffReview | undefined
  for (let round = 1; round <= 3; round++) {
    lastReview = await f.invoke<HandoffReview>(
      "lz-verify-handoff",
      round === 1
        ? {
            requestID: request.record.requestID,
            draftID: crypto.randomUUID(),
            draft: draft(),
            evidence: [{ kind: "trajectory", reference: `attempt:round-${round}` }],
          }
        : {
            requestID: request.record.requestID,
            draftVersion: 1,
            reviewID: lastReview!.reviewID,
            evidence: [{ kind: "trajectory", reference: `attempt:round-${round}` }],
          },
      worker(`exhausted-worker-round-${round}`),
    )
    expect(lastReview.round).toBe(round)
  }
  if (!lastReview) throw new Error("The review chain did not run")
  expect(lastReview.status).toBe("completed_with_concerns")
  const roundThree = lastReview
  const store = new HandoffStore(f.fixture.repository)
  const persistedRound = store.getReviewRound(request.record.requestID, roundThree.reviewID, 3)
  if (!persistedRound?.outcome) throw new Error("The third review result was not persisted")
  const persistedResult = persistedRound.outcome.result
  if (
    typeof persistedResult !== "object" ||
    persistedResult === null ||
    Array.isArray(persistedResult)
  )
    throw new Error("The third review result is not a structured result")
  const historicalOutcome = {
    ...persistedRound.outcome,
    status: "feedback" as const,
    result: { ...persistedResult, status: "feedback" },
  }
  f.fixture.repository.atomic((db) => {
    db.query(
      `UPDATE recovery_handoff_rounds SET payload=?,outcome_json=?
       WHERE project_directory=? AND review_id=? AND round=?`,
    ).run(
      JSON.stringify({ ...persistedRound, outcome: historicalOutcome }),
      JSON.stringify(historicalOutcome),
      f.fixture.repository.projectDirectory,
      roundThree.reviewID,
      3,
    )
  })

  const exhaustedResult = await f.invoke<HandoffReview>(
    "lz-verify-handoff",
    {
      requestID: request.record.requestID,
      draftVersion: roundThree.draftVersion,
      reviewID: roundThree.reviewID,
      evidence: [{ kind: "trajectory", reference: "attempt:after-budget" }],
    },
    architect("exhausted-new-evidence"),
  )
  expect(exhaustedResult).toMatchObject({
    status: "completed_with_concerns",
    round: 3,
  })
  expect(exhaustedResult.errors?.[0]).toContain("three reserved review rounds are exhausted")
  expect(exhaustedResult.limitation).toBe("The review round budget is exhausted.")
  expect(f.reviewInputs).toHaveLength(3)

  const finalized = await f.invoke<HandoffFinalization>(
    "lz-submit-handoff",
    {
      finalizationID: crypto.randomUUID(),
      requestID: request.record.requestID,
      draftVersion: roundThree.draftVersion,
      reviewID: roundThree.reviewID,
      round: exhaustedResult.round,
      fingerprint: exhaustedResult.fingerprint,
    },
    architect("exhausted-submit"),
  )
  expect(finalized.report.reviewResult).toMatchObject({
    status: "completed_with_concerns",
    round: 3,
    limitation: "The review round budget is exhausted.",
  })
  expect(store.getReviewRound(request.record.requestID, roundThree.reviewID, 4)).toBeUndefined()
  expect(store.getReviewRound(request.record.requestID, roundThree.reviewID, 3)).toMatchObject({
    reviewer: { sessionID: "ses-accepted", agent: "lazers-implementor", role: "worker" },
    outcome: { status: "feedback" },
  })
})

test("registered Architect verification recovers an expired worker review reservation", async () => {
  const f = await setup()
  const request = await f.invoke<HandoffRequest>(
    "lz-request-handoff",
    {
      requestID: "architect-recover-expired-review",
      sourceAttemptID: secondAttemptID,
      request: {
        purpose: "Recover the existing worker review reservation without replacing its data.",
        references: [{ kind: "trajectory", reference: "attempt:current" }],
      },
    },
    architect("architect-recovery-request"),
  )
  const store = new HandoffStore(f.fixture.repository)
  const sourceWorker = {
    sessionID: "ses-accepted",
    agent: "lazers-implementor",
    role: "worker" as const,
  }
  const saved = store.saveDraft(
    {
      requestID: request.record.requestID,
      draftID: crypto.randomUUID(),
      draft: draft(),
    },
    sourceWorker,
  )
  if (saved.status === "conflict") throw new Error(saved.message)

  let enterTransport!: () => void
  let releaseTransport!: () => void
  const transportStarted = new Promise<void>((resolve) => (enterTransport = resolve))
  const transportGate = new Promise<void>((resolve) => (releaseTransport = resolve))
  const interruptedReviewer = new HandoffReviewer(
    store,
    {
      systemOne: async () => {
        enterTransport()
        await transportGate
        throw new Error("The original review was interrupted.")
      },
    },
    () => {},
  )
  const reviewID = crypto.randomUUID()
  const reviewEvidence = [{ kind: "trajectory" as const, reference: "attempt:interrupted-review" }]
  const originalReview = interruptedReviewer.review(
    {
      requestID: request.record.requestID,
      draftVersion: saved.record.draftVersion,
      evidence: reviewEvidence,
      reviewID,
    },
    sourceWorker,
    new AbortController().signal,
  )
  await transportStarted
  const reservation = store.getReviewRound(request.record.requestID, reviewID, 1)
  expect(reservation?.outcome).toBeUndefined()
  if (!reservation) throw new Error("Review reservation was not persisted before inference")
  f.fixture.repository.atomic((db) => {
    const expired = {
      ...reservation,
      reservedAt: new Date(Date.now() - HANDOFF_REVIEW_RESERVATION_LEASE_MS - 1).toISOString(),
    }
    db.query(
      `UPDATE recovery_handoff_rounds SET payload=?
       WHERE project_directory=? AND review_id=? AND round=?`,
    ).run(JSON.stringify(expired), f.fixture.repository.projectDirectory, reviewID, 1)
  })

  let recovered: HandoffReview
  try {
    recovered = await f.invoke<HandoffReview>(
      "lz-verify-handoff",
      {
        requestID: request.record.requestID,
        draftVersion: saved.record.draftVersion,
        evidence: reviewEvidence,
        reviewID,
      },
      architect("architect-recover-review"),
    )
  } finally {
    releaseTransport()
  }
  expect(recovered).toMatchObject({
    status: "unavailable",
    draftID: saved.record.draftID,
    draftVersion: saved.record.draftVersion,
    reviewID,
    round: 1,
  })
  expect(recovered.errors?.[0]).toContain("interrupted before a result")
  expect(f.reviewInputs).toHaveLength(0)
  const lateWorkerReview = await originalReview
  if (lateWorkerReview.status !== "unavailable")
    throw new Error("The interrupted worker review did not observe the Architect's recovery")
  expect(lateWorkerReview.reviewID).toBe(reviewID)
  expect(lateWorkerReview.round).toBe(1)
  const completed = store
    .readHistory({ requestID: request.record.requestID })!
    .events.find((event) => event.kind === "review-completed")
  expect(completed?.data).toMatchObject({
    reviewer: sourceWorker,
    completedBy: { sessionID: "ses-owner", agent: "architect", role: "architect" },
    recovered: true,
  })

  const finalization = {
    finalizationID: crypto.randomUUID(),
    requestID: request.record.requestID,
    draftVersion: recovered.draftVersion,
    reviewID: recovered.reviewID,
    round: recovered.round,
    fingerprint: recovered.fingerprint,
  }
  await expect(
    f.invoke(
      "lz-submit-handoff",
      { ...finalization, draftVersion: recovered.draftVersion + 1 },
      architect("expired-submit-stale-draft"),
    ),
  ).rejects.toThrow("Draft version is not attached to this request")

  const restartedRepository = new TaskRepository(f.fixture.repository.path, f.fixture.directory)
  try {
    await f.register(restartedRepository)
    await expect(
      f.invoke(
        "lz-submit-handoff",
        finalization,
        toolContext("ses-foreign", "architect", "expired-submit-foreign"),
      ),
    ).rejects.toThrow("Handoff caller is not the current owner of the source plan")
    const finalized = await f.invoke<HandoffFinalization>(
      "lz-submit-handoff",
      finalization,
      architect("expired-submit-after-restart"),
    )
    expect(finalized.report).toMatchObject({
      reviewStatus: "unavailable",
      finalizedBy: { sessionID: "ses-owner" },
      review: { reviewer: sourceWorker, round: 1 },
      reviewResult: { fingerprint: recovered.fingerprint, status: "unavailable" },
    })
    const persistedHistory = new HandoffStore(restartedRepository).readHistory({
      requestID: request.record.requestID,
    })!
    expect(
      persistedHistory.events.filter((event) => event.kind === "review-finalization-authorized"),
    ).toHaveLength(1)
  } finally {
    restartedRepository.close()
  }
})

test("ambiguous checkpoint admission is persisted and never resent on replay", async () => {
  const f = await setup({ syntheticError: true })
  const concernID = crypto.randomUUID()
  await f.invoke(
    "lz-record-recovery-concern",
    {
      requestID: "uncertain-concern",
      concernID,
      sourceAttemptID: secondAttemptID,
      expectedVersion: 0,
      ruleID: "blocked",
      reason: "The worker needs an evidence-backed check-in.",
      evidenceBoundary: { fromSequence: 0, throughSequence: 3 },
      evidence: [{ kind: "trajectory", reference: "attempt:current" }],
    },
    architect("uncertain-concern"),
  )
  const input = {
    requestID: "uncertain-checkpoint",
    attemptID: secondAttemptID,
    concernID,
    expectedVersion: 1,
    evidenceBoundary: { fromSequence: 0, throughSequence: 3 },
  }
  const uncertain = await f.invoke<CheckpointState>(
    "lz-checkpoint-recovery-worker",
    input,
    architect("uncertain-checkpoint"),
  )
  expect(uncertain.delivery.status).toBe("unknown")
  expect(uncertain.consumption).toBeNull()
  expect(uncertain.response).toBeNull()
  const replay = await f.invoke<CheckpointState>(
    "lz-checkpoint-recovery-worker",
    input,
    architect("uncertain-checkpoint-replay"),
  )
  expect(replay.delivery.status).toBe("unknown")
  expect(f.syntheticCalls).toHaveLength(1)
})

test("a replacement racing native session lookup is rechecked before synthetic steering", async () => {
  const f = await setup({ replaceDuringSessionRead: true })
  const concernID = crypto.randomUUID()
  await f.invoke(
    "lz-record-recovery-concern",
    {
      requestID: "race-concern",
      concernID,
      sourceAttemptID: secondAttemptID,
      expectedVersion: 0,
      ruleID: "needs-reassessment",
      reason: "The current result needs a same-worker checkpoint.",
      evidenceBoundary: { fromSequence: 2, throughSequence: 4 },
      evidence: [{ kind: "trajectory", reference: "attempt:current" }],
    },
    architect("race-concern"),
  )
  const result = await f.invoke<CheckpointState>(
    "lz-checkpoint-recovery-worker",
    {
      requestID: "race-checkpoint",
      attemptID: secondAttemptID,
      concernID,
      expectedVersion: 1,
      evidenceBoundary: { fromSequence: 2, throughSequence: 4 },
    },
    architect("race-checkpoint"),
  )
  expect(result.delivery.status).toBe("unknown")
  expect(result.delivery.detail).toContain("replaced")
  expect(f.syntheticCalls).toHaveLength(0)
})

test("stale concern versions, foreign workers, and replacement attempts cannot steer the old worker", async () => {
  const f = await setup()
  const concernID = crypto.randomUUID()
  const concernInput = {
    requestID: "owner-bound-concern",
    concernID,
    sourceAttemptID: secondAttemptID,
    expectedVersion: 0,
    ruleID: "stalled",
    reason: "The task still needs evidence-based reassessment.",
    evidenceBoundary: { fromSequence: 1, throughSequence: 2 },
    evidence: [{ kind: "trajectory", reference: "attempt:current" }],
  }
  await f.invoke("lz-record-recovery-concern", concernInput, architect("owner-concern"))
  const checkpointInput = {
    requestID: "replacement-checkpoint",
    attemptID: secondAttemptID,
    concernID,
    expectedVersion: 1,
    evidenceBoundary: { fromSequence: 1, throughSequence: 2 },
  }
  await expect(
    f.invoke(
      "lz-checkpoint-recovery-worker",
      { ...checkpointInput, expectedVersion: 2 },
      architect("stale-version"),
    ),
  ).rejects.toThrow("not attached")
  await expect(
    f.invoke(
      "lz-checkpoint-recovery-worker",
      checkpointInput,
      toolContext("ses-other", "architect", "foreign-owner"),
    ),
  ).rejects.toThrow("current owner")
  f.fixture.store.atomic((db) => {
    db.query(
      `INSERT INTO runner_attempts
         (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,
          started_at,token_count,tool_count,retry_count,cost)
         SELECT ?,plan_id,task_id,number+1,?,?,workspace,base_commit,policy,'running',
                started_at+1,0,0,0,NULL FROM runner_attempts WHERE id=?`,
    ).run(crypto.randomUUID(), "ses-replacement", "msg-replacement", secondAttemptID)
  })
  await expect(
    f.invoke("lz-checkpoint-recovery-worker", checkpointInput, architect("replacement-try")),
  ).rejects.toThrow("replaced")
  expect(f.syntheticCalls).toHaveLength(0)
})

test("permission denial occurs before recovery reads and does not prompt", async () => {
  const f = await setup({ deny: true })
  await expect(
    f.invoke("lz-inspect-recovery", { attemptID: secondAttemptID }, architect("denied-inspect")),
  ).rejects.toThrow("Permission denied")
  expect(f.permissionCalls).toEqual(["lz-inspect-recovery"])
  expect(f.syntheticCalls).toHaveLength(0)
})
