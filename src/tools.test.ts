import { afterEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Agent, Location } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../test/proposal.ts"
import { nativeTools } from "../test/retry-process.ts"
import { TaskRepository } from "./storage.ts"
import { submitTask } from "./submission.ts"
import { RunnerStore } from "./runner/store.ts"
import { GetInstructionsOutput } from "./tasks/contract.ts"
import { registerTaskTools } from "./tools.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]
type CodeModeResult = {
  output?: unknown
  content?:
    | string
    | ReadonlyArray<{ type: "text"; text: string } | { type: "file"; uri: string; mime: string }>
}

// Pinned OpenCode 2.2.5 resultValue: output wins when defined; otherwise join
// text content and return null for empty content.
function resultValue(result: CodeModeResult) {
  if (result.output !== undefined) return result.output
  const content =
    typeof result.content === "string"
      ? result.content
      : (result.content ?? []).flatMap((item) => (item.type === "text" ? [item.text] : [])).join("")
  return content.length ? content : null
}

test("pinned Code Mode resultValue prefers defined output and joins text only as fallback", () => {
  expect(resultValue({ output: { typed: true }, content: "ignored text" })).toEqual({
    typed: true,
  })
  expect(
    resultValue({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    }),
  ).toBe("firstsecond")
  expect(resultValue({ content: [] })).toBeNull()
})

const context = {
  sessionID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionID")))("session"),
  agent: Agent.ID.make("architect"),
  messageID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Session.Message.ID")))(
    "message",
  ),
  id: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Tool.CallID")))("call"),
  progress: () => Effect.void,
} satisfies Parameters<RegisteredTool["execute"]>[1]
const cleanup: (() => void)[] = []
const keyedProposal = (idempotencyKey = "test-submission") => ({
  ...validProposal(),
  idempotencyKey,
})
afterEach(() => {
  for (const clean of cleanup.splice(0)) clean()
})

async function setup(
  deny = false,
  timeoutDefaults?: { inactivityTimeoutMs: number; hardTimeoutMs: number },
  fallowGate?: () => Promise<unknown>,
) {
  const directory = mkdtempSync(join(tmpdir(), "lazers-tool-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), process.cwd())
  cleanup.push(() => {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const tools = new Map<string, RegisteredTool>()
  const editor: ToolEditor = {
    add: (tool) => {
      tools.set(tool.name, tool)
    },
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  const assertions: string[] = []
  await Effect.runPromise(
    Effect.scoped(
      registerTaskTools(
        {
          location: Schema.decodeUnknownSync(Location.Info)({
            directory: process.cwd(),
            project: { id: "project", directory: process.cwd(), canonical: process.cwd() },
          }),
          permission: {
            assert: ({ action }) => {
              assertions.push(action)
              return deny ? Effect.die(new Error("Permission denied")) : Effect.void
            },
          },
          tool: {
            transform: (callback) =>
              Effect.sync(() => {
                callback(editor)
                return { dispose: Effect.void }
              }),
          },
        },
        repository,
        undefined,
        timeoutDefaults,
        fallowGate,
      ),
    ),
  )
  return { tools, repository, assertions }
}

test("registered tools submit, retrieve, and list the same durable task", async () => {
  const { tools, repository, assertions } = await setup()
  const submit = await Effect.runPromise(
    tools.get("lz-submit-task")!.execute(keyedProposal(), context),
  )
  const submitted = JSON.parse(String(submit.content))
  // OpenCode rejects undeclared structured output after tool execution. In the
  // submit path that would discard a receipt after the database commit.
  expect(tools.get("lz-submit-task")!.output).toBeUndefined()
  expect(submit).not.toHaveProperty("output")
  expect(submitted.status).toBe("submitted")
  expect(submitted).toMatchObject({
    reference: "LZ-1",
    title: "Keep submitted tasks after the plugin restarts",
    goal: "Keep submitted tasks after the plugin restarts",
    doneWhen: [{ id: "reopen", assertion: "A task can be retrieved after reopening the database" }],
    boundaries: {
      writeScope: ["src/**", "README.md"],
      exclusions: ["Do not dispatch workers"],
      constraints: ["Use plugin-owned SQLite storage"],
    },
    state: "submitted",
  })
  expect(submitted.note).toContain("does not start execution")
  const get = await Effect.runPromise(
    tools.get("lz-get-task")!.execute({ taskID: submitted.taskID, format: "structured" }, context),
  )
  expect(JSON.parse(String(get.content)).task.provenance.sessionID).toBe("session")
  const byReference = await Effect.runPromise(
    tools
      .get("lz-get-task")!
      .execute({ taskID: submitted.reference, format: "structured" }, context),
  )
  expect(JSON.parse(String(byReference.content))).toMatchObject({
    status: "found",
    reference: submitted.reference,
    task: { id: submitted.taskID },
  })
  const list = await Effect.runPromise(tools.get("lz-list-tasks")!.execute({ limit: 5 }, context))
  expect(JSON.parse(String(list.content)).tasks[0].taskID).toBe(submitted.taskID)
  expect(JSON.parse(String(list.content)).tasks[0].reference).toBe(submitted.reference)
  expect(tools.get("lz-list-tasks")!.output).toBeUndefined()
  expect(list).not.toHaveProperty("output")
  expect(tools.get("lz-get-task")!.output).toBeDefined()
  expect(get.output).toEqual(JSON.parse(String(get.content)))
  expect(repository.list()).toHaveLength(1)
  expect(assertions).toEqual(["lz-submit-task", "lz-get-task", "lz-get-task", "lz-list-tasks"])
})

test("registered task authoring validates partial timing against project defaults", async () => {
  const defaults = { inactivityTimeoutMs: 500, hardTimeoutMs: 1_000 }
  const { tools, repository } = await setup(false, defaults)
  const submit = tools.get("lz-submit-task")!
  const invalid = keyedProposal("project-default-task-deadline-invalid")
  delete invalid.verification[0]!.timeoutMs
  invalid.verification[0]!.inactivityTimeoutMs = 2_000
  const rejected = JSON.parse(
    String((await Effect.runPromise(submit.execute(invalid, context))).content),
  )
  expect(rejected).toMatchObject({
    status: "invalid",
    errors: [{ path: "verification.0.inactivityTimeoutMs" }],
  })
  expect(repository.list()).toHaveLength(0)

  const valid = keyedProposal("project-default-task-deadline-valid")
  delete valid.verification[0]!.timeoutMs
  valid.verification[0]!.inactivityTimeoutMs = 800
  const accepted = JSON.parse(
    String((await Effect.runPromise(submit.execute(valid, context))).content),
  )
  expect(accepted.status).toBe("submitted")
  expect(repository.get(accepted.taskID)?.proposal.verification[0]).toEqual({
    id: "tests",
    command: "bun test",
    inactivityTimeoutMs: 800,
  })
})

test("native task submission round-trips all task-kind/v1 values through effective reads", async () => {
  const { tools } = await setup()
  const kinds = [
    "bug-repair",
    "feature-implementation",
    "refactoring",
    "testing",
    "documentation",
    "maintenance",
  ] as const
  for (const primaryKind of kinds) {
    const input = {
      ...keyedProposal(`native-kind-${primaryKind}`),
      classification: { taxonomy: "task-kind/v1", primaryKind },
    }
    const submitted = JSON.parse(
      String(
        await Effect.runPromise(tools.get("lz-submit-task")!.execute(input, context)).then(
          (r) => r.content,
        ),
      ),
    )
    expect(submitted.status).toBe("submitted")
    const detail = await Effect.runPromise(
      tools
        .get("lz-get-task")!
        .execute({ taskID: submitted.taskID, format: "structured" }, context),
    )
    expect(detail.output).toMatchObject({
      status: "found",
      task: { proposal: { classification: input.classification } },
      classification: {
        revision: 1,
        classification: input.classification,
        provenance: { kind: "embedded", sessionID: "session" },
      },
      classificationHistory: [{ revision: 1, classification: input.classification }],
    })
    const page = await Effect.runPromise(
      tools.get("lz-query-tasks")!.execute({ search: submitted.taskID }, context),
    )
    expect(page.output).toMatchObject({
      tasks: [
        {
          taskID: submitted.taskID,
          classification: { revision: 1, classification: input.classification },
        },
      ],
    })
  }
})

test("Architect classification tool appends, exactly replays, and returns conflict on changed content", async () => {
  const { tools } = await setup()
  const submitted = JSON.parse(
    String(
      await Effect.runPromise(tools.get("lz-submit-task")!.execute(keyedProposal(), context)).then(
        (r) => r.content,
      ),
    ),
  )
  const classification = tools.get("lz-classify-task")!
  const input = {
    taskID: submitted.taskID,
    requestID: "tool-classification-1",
    classification: { taxonomy: "task-kind/v1", primaryKind: "maintenance" },
    reason: "The requested outcome is repository tooling upkeep.",
  }
  expect(classification.options?.permission).toBe("lz-classify-task")
  const recorded = JSON.parse(
    String(await Effect.runPromise(classification.execute(input, context)).then((r) => r.content)),
  )
  expect(recorded).toMatchObject({
    status: "recorded",
    annotation: { revision: 2, agent: "architect" },
  })
  const replayed = JSON.parse(
    String(await Effect.runPromise(classification.execute(input, context)).then((r) => r.content)),
  )
  expect(replayed).toMatchObject({ status: "replayed", annotation: recorded.annotation })
  // The tool supplies no revision: a new request appends to the current history (last write
  // wins) and a legacy expectedRevision is ignored, neither enforced nor an error.
  const appended = JSON.parse(
    String(
      await Effect.runPromise(
        classification.execute(
          {
            ...input,
            requestID: "tool-classification-2",
            classification: { taxonomy: "task-kind/v1", primaryKind: "documentation" },
            expectedRevision: 1,
          },
          context,
        ),
      ).then((r) => r.content),
    ),
  )
  expect(appended).toMatchObject({ status: "recorded", annotation: { revision: 3 } })
  const conflict = JSON.parse(
    String(
      await Effect.runPromise(
        classification.execute({ ...input, reason: "Different content." }, context),
      ).then((r) => r.content),
    ),
  )
  expect(conflict).toMatchObject({ status: "conflict" })
  const detail = await Effect.runPromise(
    tools.get("lz-get-task")!.execute({ taskID: submitted.taskID, format: "structured" }, context),
  )
  expect(detail.output).toMatchObject({
    classification: {
      revision: 3,
      classification: { taxonomy: "task-kind/v1", primaryKind: "documentation" },
    },
    classificationHistory: [
      { revision: 1, classification: validProposal().classification },
      { revision: 2, classification: input.classification },
      { revision: 3 },
    ],
  })
})

test("Architect correction controls record, replay, revise, retract, and inspect explicit membership", async () => {
  const { tools, repository } = await setup()
  const submit = tools.get("lz-submit-task")!
  const rootReceipt = JSON.parse(
    String(
      await Effect.runPromise(submit.execute(keyedProposal("correction-tool-root"), context)).then(
        (r) => r.content,
      ),
    ),
  )
  const childReceipt = JSON.parse(
    String(
      await Effect.runPromise(submit.execute(keyedProposal("correction-tool-child"), context)).then(
        (r) => r.content,
      ),
    ),
  )
  const runner = new RunnerStore(repository)
  const rootTask = repository.get(rootReceipt.taskID)!
  const childTask = repository.get(childReceipt.taskID)!
  const plan = runner.submit(
    {
      requestID: "native-correction-accepted-fixture",
      objective: "Retain both accepted physical task histories.",
      baseCommit: "a".repeat(40),
      nodes: [
        { taskID: rootTask.id, revision: 1 },
        { taskID: childTask.id, revision: 1 },
      ],
      dependencies: [],
      integrationOrder: [rootTask.id, childTask.id],
      verification: validProposal().verification,
      acceptance: validProposal().acceptance,
    },
    "architect",
  )
  for (const [task, suffix] of [
    [rootTask, "root"],
    [childTask, "child"],
  ] as const) {
    runner.move(plan.planID, task.id, "READY")
    runner.move(plan.planID, task.id, "DISPATCH")
    runner.move(plan.planID, task.id, "VERIFY")
    runner.move(plan.planID, task.id, "ACCEPT")
    runner.record(plan.planID, task.id, "ARTIFACT_ACCEPTED", {
      artifact: `${suffix}-native-artifact`,
    })
  }
  repository.atomic((db) => {
    db.query("UPDATE runner_plans SET state='accepted', artifact='native-plan' WHERE id=?").run(
      plan.planID,
    )
    const setArtifact = db.query("UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=?")
    setArtifact.run("root-native-artifact", plan.planID, rootTask.id)
    setArtifact.run("child-native-artifact", plan.planID, childTask.id)
    const insertAttempt = db.query(
      `INSERT INTO runner_attempts
       (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,
        started_at,token_count,tool_count,retry_count,cost)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    for (const [task, suffix, tokens] of [
      [rootTask, "root", 100],
      [childTask, "child", 50],
    ] as const) {
      insertAttempt.run(
        crypto.randomUUID(),
        plan.planID,
        task.id,
        1,
        `native-worker-${suffix}`,
        `native-message-${suffix}`,
        process.cwd(),
        "a".repeat(40),
        `${suffix}-native-artifact`,
        "{}",
        "accepted",
        Date.now(),
        tokens,
        5,
        0,
        null,
      )
    }
  })
  const acceptedHistory = () =>
    repository.atomic((db) => ({
      plan: db
        .query<{ state: string; artifact: string | null }, [string]>(
          "SELECT state, artifact FROM runner_plans WHERE id=?",
        )
        .get(plan.planID),
      nodes: db
        .query<{ task_id: string; state: string; artifact: string | null }, [string]>(
          "SELECT task_id, state, artifact FROM runner_nodes WHERE plan_id=? ORDER BY task_id",
        )
        .all(plan.planID),
      attempts: db
        .query<
          { task_id: string; state: string; artifact: string | null; token_count: number | null },
          [string]
        >(
          "SELECT task_id, state, artifact, token_count FROM runner_attempts WHERE plan_id=? ORDER BY task_id",
        )
        .all(plan.planID),
      accepts: db
        .query<{ task_id: string | null; event: string; payload: string }, [string]>(
          "SELECT task_id, event, payload FROM runner_transitions WHERE plan_id=? AND event IN ('ACCEPT','ARTIFACT_ACCEPTED') ORDER BY id",
        )
        .all(plan.planID),
    }))
  const acceptedBefore = acceptedHistory()
  const correction = tools.get("lz-correct-task")!
  const inspect = tools.get("lz-inspect-task-corrections")!
  expect(correction.options?.permission).toBe("lz-correct-task")
  expect(correction.options?.codemode).toBe(true)
  expect(correction.output).toBeUndefined()
  expect(inspect.options).toMatchObject({
    codemode: true,
    pinned: true,
    permission: "lz-inspect-task-corrections",
  })
  expect(inspect.output).toBeDefined()
  const input = {
    taskID: childReceipt.taskID,
    originalTaskID: rootReceipt.taskID,
    requestID: "tool-correction-1",
    reason: "Both accepted records satisfy the same original goal.",
  }
  const recorded = JSON.parse(
    String(await Effect.runPromise(correction.execute(input, context)).then((r) => r.content)),
  )
  expect(recorded).toMatchObject({
    status: "recorded",
    correction: {
      taskID: childReceipt.taskID,
      originalTaskID: rootReceipt.taskID,
      revision: 1,
      requestID: input.requestID,
      reason: input.reason,
      sessionID: "session",
      agent: "architect",
    },
  })
  expect(acceptedHistory()).toEqual(acceptedBefore)
  const replayed = JSON.parse(
    String(
      await Effect.runPromise(
        correction.execute(input, {
          ...context,
          sessionID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionID")))(
            "replay-session",
          ),
        }),
      ).then((r) => r.content),
    ),
  )
  expect(replayed).toEqual({ status: "replayed", correction: recorded.correction })
  expect(
    JSON.parse(
      String(
        await Effect.runPromise(
          correction.execute({ ...input, reason: "Different reviewed content." }, context),
        ).then((r) => r.content),
      ),
    ).status,
  ).toBe("conflict")

  const group = await Effect.runPromise(inspect.execute({ taskID: childReceipt.taskID }, context))
  const groupOutput = JSON.parse(String(group.content))
  expect(groupOutput).toMatchObject({
    status: "found",
    identity: { projectDirectory: process.cwd(), storage: "available", revision: 1 },
    task: {
      taskID: childReceipt.taskID,
      rootTaskID: rootReceipt.taskID,
      relation: "linked",
    },
    members: [childReceipt.taskID, rootReceipt.taskID]
      .sort()
      .map((taskID: string) => ({ taskID, rootTaskID: rootReceipt.taskID })),
  })
  expect(
    groupOutput.members.find((member: { taskID: string }) => member.taskID === childReceipt.taskID)
      .history[0],
  ).toMatchObject({
    requestID: input.requestID,
    reason: input.reason,
    sessionID: "session",
    agent: "architect",
    revision: 1,
  })

  const retracted = JSON.parse(
    String(
      await Effect.runPromise(
        correction.execute(
          {
            ...input,
            originalTaskID: null,
            requestID: "tool-correction-retract",
            expectedRevision: 99,
            reason: "Review confirms these are independent after all.",
          },
          context,
        ),
      ).then((r) => r.content),
    ),
  )
  expect(retracted).toMatchObject({ status: "recorded", correction: { revision: 2 } })
  expect(acceptedHistory()).toEqual(acceptedBefore)
  expect(
    (await Effect.runPromise(inspect.execute({ taskID: childReceipt.taskID }, context))).output,
  ).toMatchObject({
    task: { rootTaskID: childReceipt.taskID, relation: "independent", revision: 2 },
    members: [{ taskID: childReceipt.taskID }],
  })
})

test("a replayed submission receipt reports current queued state without claiming execution", async () => {
  const { tools, repository } = await setup()
  const input = keyedProposal()
  const first = await Effect.runPromise(tools.get("lz-submit-task")!.execute(input, context))
  const receipt = JSON.parse(String(first.content))
  const task = repository.get(receipt.taskID)!
  new RunnerStore(repository).submit(
    {
      requestID: "queued-summary",
      objective: task.proposal.objective,
      baseCommit: "a".repeat(40),
      nodes: [{ taskID: task.id, revision: task.revision }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: task.proposal.verification,
      acceptance: task.proposal.acceptance,
    },
    "architect",
  )
  const replay = await Effect.runPromise(tools.get("lz-submit-task")!.execute(input, context))
  expect(JSON.parse(String(replay.content))).toMatchObject({
    taskID: receipt.taskID,
    reference: receipt.reference,
    state: "queued",
    note: "Submission records the task; it does not start execution.",
  })
})

test("Architect can durably retire a legacy task and replay the same disposition", async () => {
  const { tools, repository, assertions } = await setup()
  const submit = await Effect.runPromise(
    tools.get("lz-submit-task")!.execute(keyedProposal(), context),
  )
  const { taskID } = JSON.parse(String(submit.content))
  const input = {
    taskID,
    requestID: "dispose-tool-test",
    disposition: "superseded",
    reason: "Replaced by the integrated implementation.",
    evidence: [{ kind: "verification", reference: "bun test" }],
    relatedTaskIDs: [],
  }
  const dispose = tools.get("lz-dispose-task")!
  const recorded = JSON.parse(
    String(
      await Effect.runPromise(dispose.execute(input, context)).then((result) => result.content),
    ),
  )
  expect(recorded.status).toBe("recorded")
  const replayed = JSON.parse(
    String(
      await Effect.runPromise(dispose.execute(input, context)).then((result) => result.content),
    ),
  )
  expect(replayed.status).toBe("replayed")
  expect(repository.list()).toHaveLength(0)
  expect(
    JSON.parse(
      String(
        await Effect.runPromise(
          tools.get("lz-query-tasks")!.execute({ includeRetired: true }, context),
        ).then((result) => result.content),
      ),
    ).tasks[0].disposition.disposition,
  ).toBe("superseded")
  expect(assertions).toContain("lz-dispose-task")
})

test("the registered disposition tool records reviewed fulfillment without changing cancelled execution readback", async () => {
  const { tools, repository } = await setup()
  const submit = await Effect.runPromise(
    tools.get("lz-submit-task")!.execute(keyedProposal("external-fulfillment-tool"), context),
  )
  const { taskID } = JSON.parse(String(submit.content)) as { taskID: string }
  const task = repository.get(taskID)!
  if (task.provenance.startingRevision.kind !== "git")
    throw new Error("Expected a committed starting revision")
  const runner = new RunnerStore(repository)
  const plan = runner.submit(
    {
      requestID: "external-fulfillment-tool-plan",
      objective: task.proposal.objective,
      baseCommit: task.provenance.startingRevision.commit,
      nodes: [{ taskID, revision: task.revision }],
      dependencies: [],
      integrationOrder: [taskID],
      verification: task.proposal.verification,
      acceptance: task.proposal.acceptance,
    },
    "architect",
  )
  runner.move(plan.planID, taskID, "CANCEL")
  repository.atomic((db) =>
    db.query("UPDATE runner_plans SET state='cancelled' WHERE id=?").run(plan.planID),
  )
  const dispositionInput = {
    taskID,
    requestID: "external-fulfillment-tool-review",
    disposition: "fulfilled",
    reason: "The reviewed external patch satisfies the unchanged specification.",
    evidence: [{ kind: "artifact", reference: "reviews/externally-applied.patch" }],
    relatedTaskIDs: [],
  }
  const disposition = JSON.parse(
    String(
      await Effect.runPromise(
        tools.get("lz-dispose-task")!.execute(dispositionInput, context),
      ).then((result) => result.content),
    ),
  )
  expect(disposition).toMatchObject({
    status: "recorded",
    disposition: { disposition: "fulfilled", evidence: dispositionInput.evidence },
  })

  const publicReadback = JSON.parse(
    String(
      await Effect.runPromise(
        tools.get("lz-get-task")!.execute({ taskID, format: "structured" }, context),
      ).then((result) => result.content),
    ),
  )
  expect(publicReadback).toMatchObject({
    status: "found",
    disposition: { disposition: "fulfilled", evidence: dispositionInput.evidence },
    recordedState: "cancelled",
    execution: { state: "cancelled", planID: plan.planID },
    attempts: [],
  })
  expect(runner.nodes(plan.planID)[0]?.state).toBe("cancelled")
  expect(runner.attempts(plan.planID)).toEqual([])
  expect(runner.effects(plan.planID)).toEqual([])

  const quietDraftSubmit = await Effect.runPromise(
    tools
      .get("lz-submit-task")!
      .execute(keyedProposal("external-fulfillment-quiet-draft"), context),
  )
  const { taskID: quietTaskID } = JSON.parse(String(quietDraftSubmit.content)) as {
    taskID: string
  }
  const quietTask = repository.get(quietTaskID)!
  const quietPlan = runner.submit(
    {
      requestID: "external-fulfillment-quiet-draft-plan",
      objective: quietTask.proposal.objective,
      baseCommit: task.provenance.startingRevision.commit,
      nodes: [{ taskID: quietTaskID, revision: quietTask.revision }],
      dependencies: [],
      integrationOrder: [quietTaskID],
      verification: quietTask.proposal.verification,
      acceptance: quietTask.proposal.acceptance,
    },
    "architect",
  )
  const quietDisposition = {
    taskID: quietTaskID,
    requestID: "external-fulfillment-quiet-draft-review",
    disposition: "fulfilled",
    reason: "The reviewed external change fulfills this quiet draft task.",
    evidence: [{ kind: "verification", reference: "reviews/external-verification.txt" }],
    relatedTaskIDs: [],
  }
  expect(
    JSON.parse(
      String(
        await Effect.runPromise(
          tools.get("lz-dispose-task")!.execute(quietDisposition, context),
        ).then((result) => result.content),
      ),
    ),
  ).toMatchObject({ status: "recorded", disposition: { disposition: "fulfilled" } })
  const quietReadback = JSON.parse(
    String(
      await Effect.runPromise(
        tools.get("lz-get-task")!.execute({ taskID: quietTaskID, format: "structured" }, context),
      ).then((result) => result.content),
    ),
  )
  expect(quietReadback).toMatchObject({
    status: "found",
    disposition: { disposition: "fulfilled", evidence: quietDisposition.evidence },
    recordedState: "queued",
    execution: { state: "queued", planID: quietPlan.planID },
    attempts: [],
  })
  expect(runner.nodes(quietPlan.planID)[0]?.state).toBe("queued")
  expect(runner.attempts(quietPlan.planID)).toEqual([])
})

test("invalid, foreign, and non-Architect disposition requests do not write", async () => {
  const { tools, repository } = await setup()
  const dispose = tools.get("lz-dispose-task")!
  const implementor = { ...context, agent: Agent.ID.make("lazers-implementor") }
  const query = spyOn(Database.prototype, "query")
  try {
    await expect(
      Effect.runPromise(
        dispose.execute(
          {
            taskID: "invalid-task-id",
            requestID: "non-architect-invalid",
            disposition: "fulfilled",
            reason: "Not authorized.",
            evidence: [{ kind: "human", reference: "review" }],
            relatedTaskIDs: [],
          },
          implementor,
        ),
      ),
    ).rejects.toThrow("restricted to Architect")
    expect(query).not.toHaveBeenCalled()

    await expect(
      Effect.runPromise(
        dispose.execute(
          {
            taskID: "invalid-task-id",
            requestID: "architect-invalid",
            disposition: "fulfilled",
            reason: "Invalid ID must fail before storage.",
            evidence: [{ kind: "human", reference: "review" }],
            relatedTaskIDs: [],
          },
          context,
        ),
      ),
    ).rejects.toThrow()
    expect(query).not.toHaveBeenCalled()
  } finally {
    query.mockRestore()
  }

  const foreignRepository = new TaskRepository(repository.path, "/foreign/project")
  cleanup.push(() => foreignRepository.close())
  const foreignTask = submitTask(foreignRepository, keyedProposal("foreign-disposition"), () => ({
    projectID: "foreign-project",
    projectDirectory: "/foreign/project",
    workspaceDirectory: "/foreign/project",
    sessionID: "foreign-session",
    startingRevision: { kind: "unborn" },
  }))
  if (foreignTask.status !== "submitted") throw new Error("Expected foreign task")
  await expect(
    Effect.runPromise(
      dispose.execute(
        {
          taskID: foreignTask.taskID,
          requestID: "architect-foreign",
          disposition: "fulfilled",
          reason: "Foreign task must not be recorded.",
          evidence: [{ kind: "human", reference: "review" }],
          relatedTaskIDs: [],
        },
        context,
      ),
    ),
  ).rejects.toThrow("Task not found in this project")
  expect(repository.taskDisposition(foreignTask.taskID)).toBeUndefined()
  expect(foreignRepository.taskDisposition(foreignTask.taskID)).toBeUndefined()
  expect(
    repository.atomic(
      (db) =>
        db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM task_dispositions").get()!
          .count,
    ),
  ).toBe(0)
})

test("task disposition is Architect-only even when native permission allows the tool", async () => {
  const { tools } = await setup()
  const implementor = { ...context, agent: Agent.ID.make("lazers-implementor") }
  await expect(
    Effect.runPromise(
      tools.get("lz-dispose-task")!.execute(
        {
          taskID: crypto.randomUUID(),
          requestID: "implementor-dispose",
          disposition: "rejected",
          reason: "No.",
          evidence: [{ kind: "human", reference: "review" }],
        },
        implementor,
      ),
    ),
  ).rejects.toThrow("restricted to Architect")
})

test("non-Architect correction and classification denials precede parsing and database access", async () => {
  const { tools } = await setup()
  const query = spyOn(Database.prototype, "query")
  const exec = spyOn(Database.prototype, "exec")
  try {
    const implementor = { ...context, agent: Agent.ID.make("lazers-implementor") }
    for (const [name, input] of [
      ["lz-classify-task", {}],
      ["lz-correct-task", {}],
      ["lz-inspect-task-corrections", { taskID: "invalid-id" }],
    ] as const) {
      await expect(Effect.runPromise(tools.get(name)!.execute(input, implementor))).rejects.toThrow(
        "restricted to Architect",
      )
    }
    expect(query).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
  } finally {
    query.mockRestore()
    exec.mockRestore()
  }
})

test("permission denial prevents task writes", async () => {
  const { tools, repository } = await setup(true)
  await expect(
    Effect.runPromise(tools.get("lz-submit-task")!.execute(keyedProposal(), context)),
  ).rejects.toThrow("Permission denied")
  expect(repository.list()).toEqual([])
})

test("retained tool callbacks survive disposal of the registration connection", async () => {
  const { tools, repository } = await setup()
  const path = repository.path
  const projectDirectory = repository.projectDirectory
  repository.close()
  const submit = await Effect.runPromise(
    tools.get("lz-submit-task")!.execute(keyedProposal(), context),
  )
  const receipt = JSON.parse(String(submit.content))
  expect(receipt.status).toBe("submitted")
  for (const [name, input] of [
    ["lz-get-task", { taskID: receipt.taskID }],
    ["lz-list-tasks", { limit: 5 }],
    ["lz-query-tasks", {}],
  ] as const) {
    const read = await Effect.runPromise(tools.get(name)!.execute(input, context))
    expect(String(read.content)).toContain(receipt.taskID)
  }
  const reopened = new TaskRepository(path, projectDirectory)
  try {
    expect(reopened.list()).toHaveLength(1)
    expect(reopened.get(receipt.taskID)?.provenance.sessionID).toBe("session")
  } finally {
    reopened.close()
  }
})

test("tool execution returns validation guidance without persisting an invalid task", async () => {
  const { tools, repository } = await setup()
  const result = await Effect.runPromise(
    tools.get("lz-submit-task")!.execute({ objective: "Incomplete" }, context),
  )
  const output = JSON.parse(String(result.content))
  expect(output.status).toBe("invalid")
  expect(output.errors.length).toBeGreaterThan(0)
  expect(repository.list()).toEqual([])
})

test("task reads expose structured Code Mode outputs and require their own permissions", async () => {
  const { tools, assertions } = await setup()
  await Effect.runPromise(tools.get("lz-submit-task")!.execute(keyedProposal(), context))
  const query = tools.get("lz-query-tasks")!
  const output = await Effect.runPromise(query.execute({ search: "" }, context))
  expect(query.options?.codemode).toBe(true)
  expect(query.output).toBeDefined()
  expect(output.output).toEqual(JSON.parse(String(output.content)))
  expect(tools.get("lz-submit-task")!.options?.codemode).toBe(true)
  expect(assertions.at(-1)).toBe("lz-query-tasks")
  const denied = await setup(true)
  for (const [name, input] of [
    ["lz-query-tasks", {}],
    ["lz-get-task", { taskID: crypto.randomUUID() }],
    ["lz-list-tasks", { limit: 2 }],
  ] as const) {
    await expect(
      Effect.runPromise(denied.tools.get(name)!.execute(input, context)),
    ).rejects.toThrow("Permission denied")
  }
})

test("registered Code Mode implementor fetch yields readable instructions before typed data", async () => {
  const { tools } = await setup()
  const proposal = {
    ...keyedProposal(),
    guidance:
      "Reuse `TaskRepository` in src/storage.ts. Keep advice separate from required outcomes.",
  }
  const receipt = await Effect.runPromise(tools.get("lz-submit-task")!.execute(proposal, context))
  const { taskID } = JSON.parse(String(receipt.content))
  const instructionsTool = tools.get("lz-get-task")!
  const result = await Effect.runPromise(
    tools
      .get("lz-get-task")!
      .execute({ taskID }, { ...context, agent: Agent.ID.make("lazers-implementor") }),
  )
  expect(instructionsTool.options).toMatchObject({ codemode: true, pinned: true })
  expect(instructionsTool.output).toBeDefined()
  expect(tools.has("lz-get-task-instructions")).toBe(false)
  const value = resultValue(result)
  if (typeof value !== "string") throw new Error("Readable Code Mode output must be a string")
  expect(typeof value).toBe("string")
  expect(GetInstructionsOutput.parse(value)).toBe(value)
  const prose = value
  expect(prose).toContain(`# Task ${taskID}`)
  expect(prose).toContain("## Done when")
  expect(prose).toContain("## Verification")
  expect(prose.indexOf("## Done when")).toBeLessThan(prose.indexOf("## Constraints"))
  expect(prose).toContain("## Implementation guidance (advisory)")
  expect(prose).toContain(proposal.guidance)
  expect(prose).toContain("## Write scope")
  expect(prose).toContain("## Exclusions")
  expect(prose).toContain("## Context references")
  expect(prose).not.toContain('"proposal"')
  expect(result.output).toBe(prose)
  expect(resultValue({ ...result, content: "This fallback must not override output" })).toBe(
    result.output,
  )

  const structured = await Effect.runPromise(
    tools
      .get("lz-get-task")!
      .execute(
        { taskID, format: "structured" },
        { ...context, agent: Agent.ID.make("lazers-implementor") },
      ),
  )
  const structuredValue = resultValue(structured)
  expect(structuredValue).toHaveProperty("task.id", taskID)
  expect(structuredValue).toHaveProperty("task.proposal.objective", validProposal().objective)
  expect(structuredValue).toHaveProperty("task.proposal.guidance", proposal.guidance)
})

test("readable task fetch handles missing and unavailable revisions", async () => {
  const { tools } = await setup()
  const receipt = await Effect.runPromise(
    tools.get("lz-submit-task")!.execute(keyedProposal(), context),
  )
  const { taskID } = JSON.parse(String(receipt.content))
  const instructions = tools.get("lz-get-task")!

  const missing = await Effect.runPromise(
    instructions.execute({ taskID: crypto.randomUUID(), format: "instructions" }, context),
  )
  const unavailable = await Effect.runPromise(
    instructions.execute({ taskID, revision: 2, format: "instructions" }, context),
  )
  expect(resultValue(missing)).toBe("Task not_found.")
  expect(resultValue(unavailable)).toBe("Task revision_unavailable.")
})

test("native schema/runtime require keys, validate before database access, and leave rejected keys reusable", async () => {
  const { repository } = await setup()
  const { tools, call } = await nativeTools(repository, { workspace: "/no-git-access" })
  const schema = tools.get("lz-submit-task")!.input as {
    required: string[]
    properties: { idempotencyKey: { minLength: number; maxLength: number; pattern: string } }
  }
  expect(schema.required).toContain("idempotencyKey")
  expect(schema.properties.idempotencyKey).toMatchObject({
    minLength: 1,
    maxLength: 200,
    pattern: "\\S",
  })
  const query = spyOn(Database.prototype, "query")
  const exec = spyOn(Database.prototype, "exec")
  try {
    for (const idempotencyKey of [undefined, null, 1, "", " \t", "k".repeat(201)]) {
      const result = await call("lz-submit-task", { ...validProposal(), idempotencyKey })
      expect(result.status).toBe("invalid")
      expect(result.errors[0].path).toBe("idempotencyKey")
    }
    const result = await call("lz-submit-task", { ...keyedProposal(), verification: [] })
    expect(result.status).toBe("invalid")
    expect(result.errors[0].path).toBe("acceptance.0.evidence.0.verificationID")
    expect(query).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
  } finally {
    query.mockRestore()
    exec.mockRestore()
  }
  const allowed = await nativeTools(repository)
  expect((await allowed.call("lz-submit-task", keyedProposal())).status).toBe("submitted")
  expect(repository.list()).toHaveLength(1)
})

test("permission denial precedes every lookup/write for first, replay, conflict and read invocations", async () => {
  const { repository } = await setup()
  let deny = false
  const { tools, call, assertions } = await nativeTools(repository, { denied: () => deny })
  const receipt = await call("lz-submit-task", keyedProposal())
  const original = repository.get(receipt.taskID)
  const correctionInput = {
    taskID: receipt.taskID,
    originalTaskID: null,
    requestID: "permission-correction-replay",
    reason: "Reviewed as independent before permission is revoked.",
  }
  expect((await call("lz-correct-task", correctionInput)).status).toBe("recorded")
  deny = true
  const query = spyOn(Database.prototype, "query")
  const exec = spyOn(Database.prototype, "exec")
  const calls = [
    ["lz-submit-task", { ...keyedProposal(), idempotencyKey: "new-denied-key" }],
    ["lz-submit-task", keyedProposal()],
    ["lz-submit-task", { ...keyedProposal(), objective: "Changed content" }],
    ["lz-submit-task", validProposal()],
    ["lz-get-task", { taskID: receipt.taskID }],
    ["lz-list-tasks", { limit: 20 }],
    ["lz-query-tasks", {}],
    [
      "lz-classify-task",
      {
        taskID: receipt.taskID,
        requestID: "permission-denied-classification",
        expectedRevision: 1,
        classification: { taxonomy: "task-kind/v1", primaryKind: "maintenance" },
        reason: "Denied calls must not query project metadata.",
      },
    ],
    ["lz-correct-task", correctionInput],
    ["lz-correct-task", { ...correctionInput, reason: "Changed payload." }],
    ["lz-correct-task", {}],
    ["lz-inspect-task-corrections", { taskID: receipt.taskID }],
    ["lz-inspect-task-corrections", { taskID: "invalid-id" }],
  ] as const
  try {
    for (const [name, input] of calls) {
      await expect(Effect.runPromise(tools.get(name)!.execute(input, context))).rejects.toThrow(
        "Permission denied",
      )
    }
    expect(query).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
  } finally {
    query.mockRestore()
    exec.mockRestore()
  }
  expect(assertions).toEqual(["lz-submit-task", "lz-correct-task", ...calls.map(([name]) => name)])
  expect(repository.list()).toEqual([original!])
  deny = false
  expect(await call("lz-submit-task", keyedProposal())).toEqual(receipt)
  expect(
    (await call("lz-submit-task", { ...keyedProposal(), idempotencyKey: "new-denied-key" })).status,
  ).toBe("submitted")
})

test("native retries and conflicts skip inaccessible Git; canonical project scope crosses worktrees but not repositories", async () => {
  const { repository } = await setup()
  const first = await nativeTools(repository)
  const receipt = await first.call("lz-submit-task", keyedProposal())
  const original = repository.get(receipt.taskID)
  const retry = await nativeTools(repository, {
    workspace: "/unavailable-worktree",
    session: "other-session",
  })
  expect(await retry.call("lz-submit-task", keyedProposal())).toEqual(receipt)
  expect(await retry.call("lz-submit-task", { ...keyedProposal(), objective: "Changed" })).toEqual({
    status: "conflict",
    message: "idempotencyKey already identifies different validated content",
  })
  expect(repository.list()).toEqual([original!])
  const other = new TaskRepository(repository.path, "/another-canonical-repository")
  try {
    // Use an accessible Git worktree, but an independent host canonical identity.
    const isolated = await nativeTools(other, { workspace: process.cwd() })
    expect(
      await isolated.call("lz-get-task", { taskID: receipt.taskID, format: "structured" }),
    ).toEqual({
      status: "not_found",
    })
    const isolatedInstructions = await Effect.runPromise(
      isolated.tools
        .get("lz-get-task")!
        .execute({ taskID: receipt.taskID, format: "instructions" }, isolated.context),
    )
    expect(resultValue(isolatedInstructions)).toBe("Task not_found.")
    expect((await isolated.call("lz-list-tasks", { limit: 20 })).tasks).toEqual([])
    const independent = await isolated.call("lz-submit-task", {
      ...keyedProposal(),
      objective: "Other repository",
    })
    expect(independent.status).toBe("submitted")
    expect(independent.taskID).not.toBe(receipt.taskID)
    expect((await isolated.call("lz-list-tasks", { limit: 20 })).tasks).toHaveLength(1)
    expect(
      await first.call("lz-get-task", { taskID: independent.taskID, format: "structured" }),
    ).toEqual({
      status: "not_found",
    })
  } finally {
    other.close()
  }
})

test("lz-submit-task is refused with the typed FALLOW_CONFIG_REQUIRED result while the project has no Fallow config", async () => {
  let configured = false
  const gate = async () =>
    configured
      ? undefined
      : {
          status: "refused",
          code: "FALLOW_CONFIG_REQUIRED",
          project: "/repo",
          nothingQueued: true,
          next: ["lz-fallow-config (mode suggest)"],
        }
  const { tools } = await setup(false, undefined, gate)
  const submit = tools.get("lz-submit-task")!
  const refused = JSON.parse(
    String((await Effect.runPromise(submit.execute(keyedProposal(), context))).content),
  )
  expect(refused).toMatchObject({
    status: "refused",
    code: "FALLOW_CONFIG_REQUIRED",
    nothingQueued: true,
  })
  configured = true
  const accepted = JSON.parse(
    String((await Effect.runPromise(submit.execute(keyedProposal(), context))).content),
  )
  expect(accepted.status).toBe("submitted")
})
