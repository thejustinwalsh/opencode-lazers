import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { DateTime } from "effect"
import { TaskRepository } from "../storage.ts"
import { RunnerStore } from "../runner/store.ts"
import { Tool } from "@opencode/schema/tool"
import { makeFixture, firstAttemptID, secondAttemptID } from "../../test/trajectory/fixture.ts"
import { ProgressRecorder } from "./recorder.ts"
import { projectProgressFact } from "./projection.ts"
import { ProgressInput } from "./schema.ts"

const workerSession = "ses-failed"

test("retained worker inputs preserve steering identity and time without recording instruction context", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const messages = [
      { id: "user-request", type: "user", time: { created: 1000 }, text: "Implement the feature." },
      {
        id: "worker-steer",
        type: "synthetic",
        time: { created: 2000 },
        text: "Keep the same worker; correct the failing transition.",
      },
      { id: "untimed-steer", type: "synthetic", text: "Inspect the receipt." },
      {
        id: "loaded-instructions",
        type: "synthetic",
        text: "Private instruction context",
        metadata: { instruction: { paths: ["AGENTS.md"] } },
      },
      {
        id: "native-continuation",
        type: "synthetic",
        text: "The previous response was interrupted. Continue from where you left off without repeating completed content.",
      },
    ]
    recorder.reconcileMessages(workerSession, messages)
    recorder.reconcileMessages(workerSession, messages)
    new ProgressRecorder(fixture.store, "project").reconcileMessages(workerSession, messages)
    const inputs = fixture.store
      .progressFacts([firstAttemptID])
      .filter((row) => row.kind === "visible-text")
    expect(inputs).toHaveLength(3)
    const steer = inputs.find((row) => row.message_id === "worker-steer")!
    expect(steer.at).toBe(2000)
    expect(JSON.parse(steer.payload)).toMatchObject({
      messageType: "synthetic",
      createdAt: 2000,
      text: messages[1]!.text,
    })
    expect(projectProgressFact(steer)).toMatchObject({ messageType: "synthetic", createdAt: 2000 })
    const untimed = inputs.find((row) => row.message_id === "untimed-steer")!
    expect(projectProgressFact(untimed)).toMatchObject({
      kind: "synthetic",
      createdAt: null,
      at: null,
    })
    expect(JSON.stringify(inputs)).not.toContain("Private instruction context")
    const assigned = fixture.attempts[0]!.message_id
    expect(
      recorder.matchesAssignedInput(firstAttemptID, workerSession, assigned, "worker-steer"),
    ).toBe(true)
    expect(
      recorder.matchesAssignedInput(firstAttemptID, workerSession, assigned, "loaded-instructions"),
    ).toBe(false)
    expect(
      recorder.matchesAssignedInput(secondAttemptID, workerSession, assigned, "worker-steer"),
    ).toBe(false)
    expect(
      recorder.matchesAssignedInput(firstAttemptID, "foreign-session", assigned, "worker-steer"),
    ).toBe(false)
  } finally {
    fixture.close()
  }
})
type RetainedToolState = "running" | "completed"
type StoredToolPayload = {
  status?: unknown
  execution?: {
    status?: unknown
    source?: unknown
    sourceType?: unknown
    phase?: unknown
    conflict?: unknown
    evidence?: { status: string }[]
  }
  timing?: { endpoints?: Record<string, unknown> }
}

function permutations<T extends string>(values: T[]): T[][] {
  if (!values.length) return [[]]
  const unique = [...new Set(values)]
  return unique.flatMap((value) => {
    let removed = false
    const rest = values.filter((candidate) => {
      if (!removed && candidate === value) {
        removed = true
        return false
      }
      return true
    })
    return permutations(rest).map((suffix) => [value, ...suffix])
  })
}

function retainedToolMessage(
  messageID: string,
  callID: string,
  stateStatus: RetainedToolState,
  executed: boolean,
) {
  const completed = stateStatus === "completed"
  return {
    id: messageID,
    type: "assistant",
    time: { created: 100 },
    content: [
      {
        type: "tool",
        id: callID,
        name: "Bash",
        executed,
        time: { created: 90, ran: 200, ...(completed ? { completed: 300 } : {}) },
        state: {
          status: stateStatus,
          input: { command: "private" },
          ...(completed ? { content: [{ type: "text", text: "done" }] } : {}),
        },
      },
    ],
  }
}

function stableToolRow(row: ReturnType<RunnerStore["progressFacts"]>[number]) {
  return {
    seq: row.seq,
    at: row.at,
    recorded_at: row.recorded_at,
    call_id: row.call_id,
    message_id: row.message_id,
    sources_json: row.sources_json,
    event_ids_json: row.event_ids_json,
    payload: row.payload,
  }
}

function retainedToolHistory(size: number) {
  return Array.from({ length: size }, (_, index) => ({
    id: `msg-history-${index}`,
    type: "assistant",
    time: { created: 1_000 + index },
    content: [
      {
        type: "tool",
        id: `call-history-${index}`,
        name: "Bash",
        executed: true,
        time: { created: 900 + index, ran: 950 + index },
        state: { status: "running", input: { command: "private" } },
      },
    ],
  }))
}

function observeReplayWork(recorder: ProgressRecorder) {
  let appendAttempts = 0
  let reminderReconciliations = 0
  const instrumented = recorder as unknown as {
    appendIn: (db: Database, assignment: unknown, fact: unknown) => number
    reconcileReminder: (sessionID: string, messages: readonly unknown[]) => void
  }
  const appendIn = instrumented.appendIn
  const reconcileReminder = instrumented.reconcileReminder
  instrumented.appendIn = (...args) => {
    appendAttempts++
    return appendIn.apply(recorder, args)
  }
  instrumented.reconcileReminder = (...args) => {
    reminderReconciliations++
    return reconcileReminder.apply(recorder, args)
  }
  return {
    appendAttempts: () => appendAttempts,
    reminderReconciliations: () => reminderReconciliations,
    resetAppendAttempts: () => {
      appendAttempts = 0
    },
  }
}

function addTerminalAssignments(fixture: ReturnType<typeof makeFixture>, count: number) {
  const base = fixture.attempts[0]!
  const assignments = Array.from({ length: count }, (_, index) => ({
    attemptID: crypto.randomUUID(),
    number: index + 3,
    sessionID: `ses-terminal-${index.toString().padStart(3, "0")}`,
    messageID: `msg-terminal-assigned-${index.toString().padStart(3, "0")}`,
  }))
  fixture.store.atomic((db) => {
    for (const assignment of assignments)
      db.query(
        `INSERT INTO runner_attempts
         (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,
          state,started_at,token_count,tool_count,retry_count,cost)
         VALUES(?,?,?,?,?,?,?,?,NULL,?,'accepted',?,NULL,0,0,NULL)`,
      ).run(
        assignment.attemptID,
        base.plan_id,
        fixture.task.id,
        assignment.number,
        assignment.sessionID,
        assignment.messageID,
        base.workspace,
        base.base_commit,
        base.policy,
        10_000 + assignment.number,
      )
  })
  return assignments
}

function toolEvent(type: string, id: string, data: Record<string, unknown>, created: number) {
  return {
    id,
    type,
    created,
    data: { sessionID: workerSession, ...data },
  }
}

test.each(["lazers-implementor", "auditor"])(
  "%s hooks, native events and recovery coalesce into one durable identity",
  (agent) => {
    const fixture = makeFixture()
    let secondRepository: TaskRepository | undefined
    let reopened: TaskRepository | undefined
    try {
      fixture.store.atomic((db) =>
        db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
      )
      const recorder = new ProgressRecorder(fixture.store, "project")
      const otherRepository = new TaskRepository(fixture.repository.path, fixture.directory)
      secondRepository = otherRepository
      const otherStore = new RunnerStore(otherRepository)
      const otherRecorder = new ProgressRecorder(otherStore, "project")

      const toolID = "native-call-7"
      const call = {
        tool: "Bash",
        sessionID: workerSession,
        agent,
        messageID: "assistant-message-7",
        callID: toolID,
        status: "completed" as const,
        result: {
          content: [{ type: "text" as const, text: "Tests passed; token=canary-secret-value" }],
        },
      }
      recorder.recordNativeEvent(
        toolEvent(
          "session.tool.called",
          "event-call",
          {
            assistantMessageID: call.messageID,
            id: toolID,
            input: { script: "private-input" },
            executed: true,
          },
          100,
        ),
      )
      otherRecorder.recordToolHook(call)
      recorder.recordNativeEvent(
        toolEvent(
          "session.tool.success",
          "event-success",
          {
            assistantMessageID: call.messageID,
            id: toolID,
            content: [{ type: "text", text: "Tests passed; token=canary-secret-value" }],
            executed: true,
          },
          110,
        ),
      )
      recorder.recordNativeEvent(
        toolEvent(
          "session.tool.success",
          "event-success",
          { assistantMessageID: call.messageID, id: toolID, content: [], executed: true },
          110,
        ),
      )
      recorder.reconcileMessages(workerSession, [
        {
          id: call.messageID,
          type: "assistant",
          time: { created: 90 },
          content: [
            {
              type: "tool",
              id: toolID,
              name: "Bash",
              state: {
                status: "completed",
                input: { authorization: "do-not-retain-this-input" },
                content: [{ type: "text", text: "Tests passed; token=canary-secret-value" }],
              },
            },
          ],
        },
      ])

      const rows = fixture.store.progressFacts([firstAttemptID])
      expect(rows).toHaveLength(3) // tool, native assistant start and the recovery coverage gap
      const callRow = rows.find((row) => row.call_id === toolID)!
      expect(callRow).toMatchObject({
        project_id: "project",
        plan_id: fixture.attempts[0]!.plan_id,
        task_id: fixture.task.id,
        attempt_id: firstAttemptID,
        session_id: workerSession,
        message_id: call.messageID,
        kind: "tool",
      })
      expect(JSON.parse(callRow.sources_json).sort()).toEqual([
        "native-event",
        "recovery",
        "tool-hook",
      ])
      expect(JSON.parse(callRow.event_ids_json).sort()).toEqual(["event-call", "event-success"])
      expect(JSON.parse(callRow.payload)).toMatchObject({ tool: "Bash", status: "succeeded" })
      expect(callRow.payload).not.toContain("private-input")
      expect(callRow.payload).not.toContain("do-not-retain-this-input")
      expect(callRow.payload).not.toContain("canary-secret-value")

      const dbPath = fixture.repository.path
      const projectDirectory = fixture.repository.projectDirectory
      otherRepository.close()
      secondRepository = undefined
      fixture.repository.close()
      reopened = new TaskRepository(dbPath, projectDirectory)
      const reopenedStore = new RunnerStore(reopened)
      const recoveredRows = reopenedStore.progressFacts([firstAttemptID])
      expect(recoveredRows.map((row) => row.seq)).toEqual(rows.map((row) => row.seq))
      expect(recoveredRows.filter((row) => row.call_id === toolID)).toHaveLength(1)
    } finally {
      secondRepository?.close()
      reopened?.close()
      fixture.close()
    }
  },
)

test("requested file targets enrich only the exact active call without changing native outcomes", () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const call = {
      tool: "read",
      sessionID: workerSession,
      agent: "lazers-implementor",
      messageID: "msg-file-call",
      callID: "call-shared",
      input: {
        path: "src/visible.ts",
        body: "never store this file body",
        password: "never store this credential",
      },
    }
    expect(recorder.recordToolTargets(call)).toBeGreaterThan(0)
    recorder.recordNativeEvent(
      toolEvent(
        "session.tool.input.started",
        "input-file-call",
        { assistantMessageID: call.messageID, id: call.callID, name: call.tool },
        10_000,
      ),
    )
    recorder.recordNativeEvent(
      toolEvent(
        "session.tool.failed",
        "failed-file-call",
        {
          assistantMessageID: call.messageID,
          id: call.callID,
          error: { type: "ToolError", message: "failed after requesting the file" },
        },
        10_100,
      ),
    )
    recorder.recordToolHook({
      tool: call.tool,
      sessionID: call.sessionID,
      agent: call.agent,
      messageID: call.messageID,
      callID: call.callID,
      status: "error",
      error: new Tool.Error({ message: "same call failed" }),
    })
    expect(
      recorder.recordToolTargets({
        ...call,
        messageID: "stale-message",
        input: { path: "src/secret.ts" },
      }),
    ).toBeUndefined()
    recorder.recordNativeEvent(
      toolEvent(
        "session.tool.input.started",
        "conflicting-input",
        {
          assistantMessageID: "stale-message",
          id: call.callID,
          name: "edit",
        },
        10_200,
      ),
    )

    const rows = fixture.store.progressFacts([firstAttemptID])
    const fact = rows.find((row) => row.call_id === call.callID)!
    const payload = JSON.parse(fact.payload)
    expect(payload).toMatchObject({
      tool: "read",
      status: "failed",
      fileTargets: { coverage: "observed", operation: "read", paths: ["src/visible.ts"] },
    })
    expect(fact.message_id).toBe(call.messageID)
    expect(fact.payload).not.toContain("never store this file body")
    expect(fact.payload).not.toContain("never store this credential")

    const completedCall = {
      ...call,
      messageID: "msg-completed-read",
      callID: "call-completed-read",
    }
    recorder.recordToolTargets(completedCall)
    recorder.recordNativeEvent(
      toolEvent(
        "session.tool.input.started",
        "completed-read-input",
        {
          assistantMessageID: completedCall.messageID,
          id: completedCall.callID,
          name: completedCall.tool,
        },
        10_250,
      ),
    )
    recorder.recordNativeEvent(
      toolEvent(
        "session.tool.success",
        "completed-read-terminal",
        {
          assistantMessageID: completedCall.messageID,
          id: completedCall.callID,
          content: [{ type: "text", text: "NATIVE READ BODY DECOY" }],
        },
        10_260,
      ),
    )
    recorder.recordToolHook({
      ...completedCall,
      status: "completed",
      result: { content: [{ type: "text", text: "HOOK READ BODY DECOY" }] } as never,
    })
    recorder.reconcileMessages(workerSession, [
      {
        id: completedCall.messageID,
        type: "assistant",
        content: [
          {
            type: "tool",
            id: completedCall.callID,
            name: "read",
            state: {
              status: "completed",
              input: { path: "src/visible.ts", content: "RECOVERED READ BODY DECOY" },
              content: [{ type: "text", text: "RECOVERED READ BODY DECOY" }],
            },
          },
        ],
      },
    ])
    const completedFact = fixture.store
      .progressFacts([firstAttemptID])
      .find((row) => row.call_id === completedCall.callID)!
    expect(JSON.parse(completedFact.payload)).toMatchObject({
      status: "succeeded",
      fileTargets: { coverage: "observed", operation: "read", paths: ["src/visible.ts"] },
    })
    for (const decoy of [
      "NATIVE READ BODY DECOY",
      "HOOK READ BODY DECOY",
      "RECOVERED READ BODY DECOY",
    ])
      expect(completedFact.payload).not.toContain(decoy)

    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID),
    )
    expect(
      recorder.recordToolTargets({
        ...call,
        sessionID: "ses-accepted",
        messageID: "msg-second-session",
        input: { path: "src/second-session.ts" },
      }),
    ).toBeGreaterThan(0)
    const collisionRows = fixture.store
      .progressFacts([firstAttemptID, secondAttemptID])
      .filter((row) => row.call_id === call.callID)
    expect(collisionRows).toHaveLength(2)
    expect(
      collisionRows.map((row) => [row.session_id, JSON.parse(row.payload).fileTargets.paths[0]]),
    ).toEqual([
      ["ses-failed", "src/visible.ts"],
      ["ses-accepted", "src/second-session.ts"],
    ])

    const terminalFirst = "call-terminal-first"
    recorder.recordNativeEvent(
      toolEvent(
        "session.tool.failed",
        "terminal-first-event",
        {
          assistantMessageID: "msg-terminal-first",
          id: terminalFirst,
          error: { type: "ToolError", message: "terminal observed first" },
        },
        10_300,
      ),
    )
    expect(
      recorder.recordToolTargets({
        ...call,
        callID: terminalFirst,
        messageID: "msg-terminal-first",
      }),
    ).toBeUndefined()
    const terminalFact = fixture.store
      .progressFacts([firstAttemptID])
      .find((row) => row.call_id === terminalFirst)!
    expect(JSON.parse(terminalFact.payload)).toMatchObject({ status: "failed" })
    expect(JSON.parse(terminalFact.payload).fileTargets).toBeUndefined()

    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='failed' WHERE id=?").run(firstAttemptID),
    )
    expect(
      recorder.recordToolTargets({
        ...call,
        callID: "late-after-assignment-terminal",
        messageID: "late-message",
      }),
    ).toBeUndefined()
  } finally {
    fixture.close()
  }
})

test("two database connections allocate unique ordered sequences and reports resolve identity", async () => {
  const fixture = makeFixture()
  let secondRepository: TaskRepository | undefined
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    secondRepository = new TaskRepository(fixture.repository.path, fixture.directory)
    const first = new ProgressRecorder(fixture.store, "project")
    const secondStore = new RunnerStore(secondRepository)
    const second = new ProgressRecorder(secondStore, "project")
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        Promise.resolve().then(() =>
          (index % 2 ? first : second).report({
            sessionID: workerSession,
            agent: "lazers-implementor",
            callID: `report-${index}`,
            messageID: `message-${index}`,
            message: `Checkpoint ${index}`,
          }),
        ),
      ),
    )
    const rows = fixture.store.progressFacts([firstAttemptID])
    const reportRows = rows.filter((row) => row.kind === "commentary")
    expect(reportRows).toHaveLength(24)
    expect(new Set(reportRows.map((row) => row.seq)).size).toBe(24)
    expect(reportRows.map((row) => row.seq)).toEqual(
      [...reportRows].map((row) => row.seq).sort((a, b) => a - b),
    )
    const duplicate = first.report({
      sessionID: workerSession,
      agent: "lazers-implementor",
      callID: "report-0",
      messageID: "message-0",
      message: "Checkpoint 0",
    })
    expect(duplicate.sequence).toBe(reportRows.find((row) => row.call_id === "report-0")!.seq)
    expect(() =>
      first.report({
        sessionID: "ses-foreign-unassigned",
        agent: "lazers-implementor",
        callID: "forged",
        messageID: "forged-message",
        message: "not attached",
      }),
    ).toThrow("active assigned worker")
    expect(() =>
      first.report({
        sessionID: workerSession,
        agent: "architect",
        callID: "wrong-agent",
        messageID: "wrong-agent-message",
        message: "not allowed",
      }),
    ).toThrow("Only an assigned LAZERS implementor")
    expect(fixture.store.progressFacts([secondAttemptID])).toEqual([])
  } finally {
    secondRepository?.close()
    fixture.close()
  }
})

test("step costs are additive per step while cumulative session snapshots stay separate", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const step = {
      id: "step-event",
      type: "session.step.ended",
      created: 3000,
      data: {
        sessionID: workerSession,
        assistantMessageID: "assistant-step",
        finish: "stop",
        cost: 0.25,
        tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 1 } },
      },
    }
    recorder.recordNativeEvent(step)
    recorder.recordNativeEvent(step)
    recorder.recordNativeEvent({
      id: "usage-old",
      type: "session.usage.updated",
      created: 4000,
      data: {
        sessionID: workerSession,
        cost: 0.5,
        tokens: { input: 80, output: 30, reasoning: 10, cache: { read: 20, write: 10 } },
      },
    })
    recorder.recordNativeEvent({
      id: "usage-latest",
      type: "session.usage.updated",
      created: 5000,
      data: {
        sessionID: workerSession,
        cost: 0.75,
        tokens: { input: 90, output: 35, reasoning: 12, cache: { read: 24, write: 11 } },
      },
    })
    recorder.recordNativeEvent({
      id: "retry-event",
      type: "session.retry.scheduled",
      created: 5100,
      data: {
        sessionID: workerSession,
        assistantMessageID: "assistant-step",
        attempt: 2,
        at: 5100,
        error: { type: "ProviderError", message: "retry after timeout" },
      },
    })
    recorder.recordNativeEvent({
      id: "interrupted-event",
      type: "session.execution.interrupted",
      created: 5200,
      data: { sessionID: workerSession },
    })
    recorder.reconcileMessages(workerSession, [
      {
        id: "assistant-step",
        type: "assistant",
        time: { created: 2900 },
        cost: 0.25,
        tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 1 } },
        content: [],
        retry: {
          attempt: 2,
          at: 5100,
          error: { type: "ProviderError", message: "retry after timeout" },
        },
      },
      { id: "idle-step", type: "idle", time: { created: 5200 }, outcome: "interrupted" },
    ])
    const rows = fixture.store.progressFacts([firstAttemptID])
    const stepRow = rows.find((row) => row.kind === "step")!
    expect(JSON.parse(stepRow.payload)).toMatchObject({
      status: "ended",
      measurementBasis: "additive-step-measurement",
      usage: {
        input: 8,
        output: 3,
        reasoning: 1,
        cacheRead: 2,
        cacheWrite: 1,
        costUSD: 0.25,
      },
    })
    expect(rows.filter((row) => row.kind === "step")).toHaveLength(1)
    const usageRow = rows.find((row) => row.kind === "usage-snapshot")!
    expect(JSON.parse(usageRow.payload)).toMatchObject({
      measurementBasis: "cumulative-session-snapshot",
      usage: {
        input: 90,
        output: 35,
        reasoning: 12,
        cacheRead: 24,
        cacheWrite: 11,
        costUSD: 0.75,
      },
    })
    expect(JSON.parse(usageRow.event_ids_json)).toEqual(["usage-old", "usage-latest"])
    expect(rows.filter((row) => row.kind === "provider-retry")).toHaveLength(1)
    expect(rows.some((row) => JSON.parse(row.payload).outcome === "interrupted")).toBe(true)
  } finally {
    fixture.close()
  }
})

test("runtime checks and artifacts are durable facts but never acceptance authority", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    recorder.recordArtifact(firstAttemptID, "c".repeat(40))
    recorder.recordVerification(firstAttemptID, "effect-check", {
      id: "attempt-check",
      artifact: "c".repeat(40),
      inputIdentity: "c".repeat(40),
      exitCode: 0,
      timedOut: false,
      unchanged: false,
      startedAt: 100,
      endedAt: 200,
      command: "bun test",
      stdout: "must not be copied",
    })
    recorder.recordAttemptOutcome(firstAttemptID, "accepted")
    const rows = fixture.store.progressFacts([firstAttemptID])
    expect(rows.map((row) => row.kind)).toEqual(["artifact", "verification", "execution-outcome"])
    expect(JSON.parse(rows[1]!.payload)).toMatchObject({
      checkID: "attempt-check",
      result: "passed",
    })
    expect(rows[1]!.payload).not.toContain("must not be copied")
    expect(fixture.store.attempts(fixture.attempts[0]!.plan_id)[0]!.state).toBe("failed")
    expect(fixture.store.execution(fixture.task.id)?.state).toBe("accepted")
  } finally {
    fixture.close()
  }
})

test("failed tools, failed steps, retries, shell results and interrupted turns recover without final prose", () => {
  const fixture = makeFixture()
  let reopened: TaskRepository | undefined
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const failedTool = {
      tool: "Bash",
      sessionID: "ses-failed",
      agent: "lazers-implementor",
      messageID: "msg_failed_tool",
      callID: "call-failed-1",
      status: "error" as const,
      error: new Tool.Error({ message: "command failed with token=secret-canary" }),
    }
    recorder.recordToolHook(failedTool)
    recorder.recordNativeEvent(
      toolEvent(
        "session.tool.failed",
        "tool-error-event",
        {
          assistantMessageID: failedTool.messageID,
          id: failedTool.callID,
          error: { type: "ToolError", message: "command failed with token=secret-canary" },
          input: { command: "never retain this" },
        },
        6000,
      ),
    )
    recorder.recordNativeEvent({
      id: "step-failure-event",
      type: "session.step.failed",
      created: 6100,
      data: {
        sessionID: "ses-failed",
        assistantMessageID: "msg_failed_step",
        finish: "error",
        cost: 0.125,
        tokens: { input: 4, output: 2, reasoning: 1, cache: { read: 1, write: 0 } },
        error: { type: "ProviderError", message: "request failed" },
      },
    })
    recorder.recordNativeEvent({
      id: "retry-failure-event",
      type: "session.retry.scheduled",
      created: 6200,
      data: {
        sessionID: "ses-failed",
        assistantMessageID: "msg_failed_step",
        attempt: 3,
        at: 6200,
        error: { type: "ProviderError", message: "request failed" },
      },
    })
    recorder.recordNativeEvent({
      id: "execution-failure-event",
      type: "session.execution.failed",
      created: 6300,
      data: {
        sessionID: "ses-failed",
        error: { type: "ProviderError", message: "execution failed" },
      },
    })
    recorder.recordNativeEvent({
      id: "shell-ended-event",
      type: "session.shell.ended",
      created: 6400,
      data: {
        sessionID: "ses-failed",
        shell: {
          id: "shell-1",
          command: "bun test",
          status: "exited",
          exit: 1,
          time: { started: 6350 },
        },
        output: { output: "failed: api_key=hidden-canary", truncated: false },
      },
    })
    recorder.recordNativeEvent({
      id: "execution-interruption-event",
      type: "session.execution.interrupted",
      created: 6500,
      data: { sessionID: "ses-accepted" },
    })
    recorder.reconcileMessages("ses-failed", [
      {
        id: failedTool.messageID,
        type: "assistant",
        time: { created: 5900 },
        content: [
          {
            type: "tool",
            id: failedTool.callID,
            name: "Bash",
            state: {
              status: "error",
              input: { command: "must not reappear" },
              error: { type: "ToolError", message: "command failed with token=secret-canary" },
            },
          },
        ],
      },
      {
        id: "msg_failed_step",
        type: "assistant",
        time: { created: 6050 },
        finish: "error",
        cost: 0.125,
        tokens: { input: 4, output: 2, reasoning: 1, cache: { read: 1, write: 0 } },
        error: { type: "ProviderError", message: "request failed" },
        content: [],
      },
      {
        id: "shell-message",
        type: "shell",
        time: { created: 6350 },
        shellID: "shell-1",
        command: "bun test",
        status: "exited",
        exit: 1,
        output: { output: "failed: api_key=hidden-canary", truncated: false },
      },
    ])
    recorder.reconcileMessages("ses-accepted", [
      { id: "idle-interrupted", type: "idle", time: { created: 6500 }, outcome: "interrupted" },
    ])

    const rows = fixture.store.progressFacts([firstAttemptID, secondAttemptID])
    const failedAttempt = rows.filter((row) => row.attempt_id === firstAttemptID)
    expect(failedAttempt.map((row) => row.kind)).toEqual([
      "tool",
      "step",
      "provider-retry",
      "execution-outcome",
      "shell",
      "step",
      "execution-outcome",
      "gap",
    ])
    const tool = failedAttempt.find((row) => row.kind === "tool")!
    expect(JSON.parse(tool.payload)).toMatchObject({ status: "failed", tool: "Bash" })
    const step = failedAttempt.find((row) => row.kind === "step")!
    expect(JSON.parse(step.payload)).toMatchObject({
      status: "failed",
      measurementBasis: "additive-step-measurement",
      usage: { input: 4, output: 2, costUSD: 0.125 },
    })
    expect(
      JSON.parse(failedAttempt.find((row) => row.kind === "provider-retry")!.payload).attempt,
    ).toBe(3)
    expect(JSON.parse(failedAttempt.find((row) => row.kind === "shell")!.payload)).toMatchObject({
      status: "exited",
      exit: 1,
    })
    expect(failedAttempt.every((row) => !row.payload.includes("secret-canary"))).toBe(true)
    expect(failedAttempt.every((row) => !row.payload.includes("hidden-canary"))).toBe(true)
    expect(failedAttempt.every((row) => !row.payload.includes("must not retain"))).toBe(true)
    expect(rows.some((row) => JSON.parse(row.payload).outcome === "interrupted")).toBe(true)

    const dbPath = fixture.repository.path
    const projectDirectory = fixture.repository.projectDirectory
    fixture.repository.close()
    reopened = new TaskRepository(dbPath, projectDirectory)
    const reopenedStore = new RunnerStore(reopened)
    const recovered = reopenedStore.progressFacts([firstAttemptID, secondAttemptID])
    expect(recovered.map((row) => [row.attempt_id, row.kind, row.dedupe_key])).toEqual(
      rows.map((row) => [row.attempt_id, row.kind, row.dedupe_key]),
    )
  } finally {
    reopened?.close()
    fixture.close()
  }
})

test("native timing endpoints converge across hook, live, and retained recovery replay", () => {
  const numericFixture = makeFixture()
  const decodedFixture = makeFixture()
  let reopened: TaskRepository | undefined
  const originalNow = Date.now
  const point = (value: number, decoded: boolean) => (decoded ? DateTime.makeUnsafe(value) : value)
  const hook = {
    tool: "Bash",
    sessionID: workerSession,
    agent: "lazers-implementor",
    messageID: "msg-timing",
    callID: "call-timing",
    status: "completed" as const,
    result: { content: [{ type: "text" as const, text: "done" }] },
  }
  const nativeEvents = (decoded: boolean) => {
    const event = (id: string, type: string, created: number, data: Record<string, unknown>) => ({
      id,
      type,
      created,
      data: { sessionID: workerSession, ...data },
    })
    return [
      event("evt-step-start", "session.step.started", 900, {
        assistantMessageID: "msg-timing",
        agent: "lazers-implementor",
        model: { providerID: "openai", id: "test-model" },
        started: point(900, decoded),
      }),
      event("evt-tool-input", "session.tool.input.started", 1_000, {
        assistantMessageID: "msg-timing",
        id: "call-timing",
        name: "Bash",
      }),
      event("evt-tool-called", "session.tool.called", 1_100, {
        assistantMessageID: "msg-timing",
        id: "call-timing",
        input: { command: "private" },
        executed: true,
      }),
      event("evt-step-streamed", "session.step.streamed", 1_300, {
        assistantMessageID: "msg-timing",
      }),
      event("evt-tool-result", "session.tool.success", 1_200, {
        assistantMessageID: "msg-timing",
        id: "call-timing",
        content: [{ type: "text", text: "done" }],
        executed: true,
      }),
      event("evt-step-end", "session.step.ended", 1_400, {
        assistantMessageID: "msg-timing",
      }),
      event("evt-retry", "session.retry.scheduled", 1_500, {
        assistantMessageID: "msg-timing",
        attempt: 2,
        at: point(1_500, decoded),
        error: { type: "ProviderError", message: "retry" },
      }),
      event("evt-shell-start", "session.shell.started", 1_600, {
        shell: {
          id: "sh-timing",
          command: "bun test",
          status: "running",
          time: { started: point(1_600, decoded) },
        },
      }),
      event("evt-shell-end", "session.shell.ended", 1_700, {
        shell: {
          id: "sh-timing",
          command: "bun test",
          status: "exited",
          time: { started: point(1_600, decoded), completed: point(1_700, decoded) },
        },
        output: { output: "ok", truncated: false },
      }),
      event("evt-not-executed", "session.tool.called", 1_800, {
        assistantMessageID: "msg-timing",
        id: "call-not-executed",
        executed: false,
      }),
    ]
  }
  const retainedMessages = (decoded: boolean) => [
    {
      id: "msg-timing",
      type: "assistant",
      time: {
        created: point(890, decoded),
        streamed: point(1_290, decoded),
        completed: point(1_390, decoded),
      },
      content: [
        {
          type: "tool",
          id: "call-timing",
          name: "Bash",
          executed: true,
          time: {
            created: point(990, decoded),
            ran: point(1_090, decoded),
            completed: point(1_190, decoded),
          },
          state: {
            status: "completed",
            input: { command: "private" },
            content: [{ type: "text", text: "done" }],
          },
        },
        {
          type: "tool",
          id: "call-ran-only",
          name: "Bash",
          time: { ran: point(1_250, decoded) },
          state: { status: "running", input: {} },
        },
      ],
      retry: {
        attempt: 2,
        at: point(1_490, decoded),
        error: { type: "ProviderError", message: "retry" },
      },
    },
    {
      id: "shell-message",
      type: "shell",
      time: { created: point(1_590, decoded), completed: point(1_690, decoded) },
      shellID: "sh-timing",
      command: "bun test",
      status: "exited",
      output: { output: "ok", truncated: false },
    },
  ]
  const run = (
    fixture: ReturnType<typeof makeFixture>,
    decoded: boolean,
    recoveryFirst: boolean,
  ) => {
    const recorder = new ProgressRecorder(fixture.store, "project")
    if (recoveryFirst) {
      recorder.recordToolHook(hook)
      recorder.reconcileMessages(workerSession, retainedMessages(decoded))
      for (const event of nativeEvents(decoded)) recorder.recordNativeEvent(event)
    } else {
      for (const event of nativeEvents(decoded)) recorder.recordNativeEvent(event)
      recorder.reconcileMessages(workerSession, retainedMessages(decoded))
      recorder.recordToolHook(hook)
    }
    recorder.recordVerification(firstAttemptID, "timing-check", {
      id: "timing-check",
      artifact: "a".repeat(40),
      inputIdentity: "a".repeat(40),
      exitCode: 0,
      timedOut: false,
      unchanged: true,
      startedAt: point(1_900, decoded),
      endedAt: point(2_000, decoded),
    })
    return recorder
  }

  try {
    run(numericFixture, false, true)
    run(decodedFixture, true, false)
    const rows = (fixture: ReturnType<typeof makeFixture>) =>
      fixture.store.progressFacts([firstAttemptID])
    const byKind = (fixture: ReturnType<typeof makeFixture>, kind: string, id?: string) => {
      const row = rows(fixture).find(
        (value) => value.kind === kind && (!id || value.call_id === id),
      )!
      return { row, payload: JSON.parse(row.payload) as Record<string, unknown> }
    }
    const timingFor = (fixture: ReturnType<typeof makeFixture>, kind: string, id?: string) =>
      byKind(fixture, kind, id).payload.timing

    for (const kind of ["tool", "step", "provider-retry", "shell", "verification"]) {
      const numericTiming = timingFor(
        numericFixture,
        kind,
        kind === "tool" ? "call-timing" : undefined,
      )
      const decodedTiming = timingFor(
        decodedFixture,
        kind,
        kind === "tool" ? "call-timing" : undefined,
      )
      expect(numericTiming).toEqual(decodedTiming)
    }
    expect(timingFor(numericFixture, "tool", "call-timing")).toMatchObject({
      unit: "unix-epoch-ms",
      endpoints: {
        inputAt: { at: 1_000, source: "native-event", sourceType: "session.tool.input.started" },
        calledAt: { at: 1_100, source: "native-event", sourceType: "session.tool.called" },
        completedAt: { at: 1_200, source: "native-event", sourceType: "session.tool.success" },
      },
    })
    const toolPayload = byKind(numericFixture, "tool", "call-timing").payload
    expect(toolPayload).toMatchObject({
      status: "succeeded",
      callStatus: "called",
      execution: { status: "executed", source: "native-event" },
    })
    const notExecuted = byKind(numericFixture, "tool", "call-not-executed").payload
    expect(notExecuted).toMatchObject({
      status: "not-executed",
      callStatus: "called",
      execution: { status: "not-executed", source: "native-event" },
    })
    const ranOnly = byKind(numericFixture, "tool", "call-ran-only").payload
    expect(ranOnly).toMatchObject({
      status: "running",
      callStatus: "called",
      timing: {
        endpoints: { calledAt: { at: 1_250, source: "recovery" } },
      },
    })
    expect(ranOnly).not.toHaveProperty("execution")
    const stepPayload = byKind(numericFixture, "step").payload
    expect(stepPayload).toMatchObject({
      status: "ended",
      timing: {
        endpoints: {
          startedAt: { at: 900, source: "native-event" },
          streamedAt: { at: 1_300, source: "native-event" },
          completedAt: { at: 1_400, source: "native-event" },
        },
      },
    })
    expect(stepPayload).not.toHaveProperty("usage")
    expect(stepPayload).not.toHaveProperty("measurementBasis")
    expect(timingFor(numericFixture, "provider-retry")).toMatchObject({
      endpoints: { scheduledAt: { at: 1_500, source: "native-event" } },
    })
    expect(timingFor(numericFixture, "shell")).toMatchObject({
      endpoints: {
        startedAt: { at: 1_600, source: "native-event" },
        completedAt: { at: 1_700, source: "native-event" },
      },
    })
    expect(timingFor(numericFixture, "verification")).toMatchObject({
      endpoints: {
        startedAt: { at: 1_900, source: "runtime" },
        completedAt: { at: 2_000, source: "runtime" },
      },
    })
    expect(rows(numericFixture).every((row) => Number.isSafeInteger(row.recorded_at))).toBe(true)

    const beforeReplay = rows(numericFixture).map((row) => [
      row.seq,
      row.at,
      row.recorded_at,
      row.payload,
      row.event_ids_json,
    ])
    const dbPath = numericFixture.repository.path
    const projectDirectory = numericFixture.repository.projectDirectory
    numericFixture.repository.close()
    reopened = new TaskRepository(dbPath, projectDirectory)
    const reopenedStore = new RunnerStore(reopened)
    const reopenedRecorder = new ProgressRecorder(reopenedStore, "project")
    for (const event of nativeEvents(false)) reopenedRecorder.recordNativeEvent(event)
    reopenedRecorder.recordToolHook(hook)
    reopenedRecorder.reconcileMessages(workerSession, retainedMessages(false))
    const afterReplay = reopenedStore
      .progressFacts([firstAttemptID])
      .map((row) => [row.seq, row.at, row.recorded_at, row.payload, row.event_ids_json])
    expect(afterReplay).toEqual(beforeReplay)

    const beforeStaleRecovery = reopenedStore.progressFacts([firstAttemptID])
    const knownToolTiming = JSON.parse(
      beforeStaleRecovery.find((row) => row.call_id === "call-timing")!.payload,
    ).timing
    const knownStepTiming = JSON.parse(
      beforeStaleRecovery.find((row) => row.kind === "step")!.payload,
    ).timing
    const staleMessages = [
      {
        id: "msg-timing",
        type: "assistant",
        time: { created: 800 },
        content: [
          {
            type: "tool",
            id: "call-timing",
            name: "Bash",
            time: { created: 800 },
            state: { status: "running", input: {} },
          },
        ],
      },
    ]
    reopenedRecorder.reconcileMessages(workerSession, staleMessages)
    const staleTool = reopenedStore
      .progressFacts([firstAttemptID])
      .find((row) => row.call_id === "call-timing")!
    const staleStep = reopenedStore
      .progressFacts([firstAttemptID])
      .find((row) => row.kind === "step")!
    expect(JSON.parse(staleTool.payload)).toMatchObject({
      status: "succeeded",
      timing: knownToolTiming,
    })
    expect(JSON.parse(staleStep.payload)).toMatchObject({
      status: "ended",
      timing: knownStepTiming,
    })
    const staleReplaySnapshot = reopenedStore
      .progressFacts([firstAttemptID])
      .map((row) => [row.seq, row.at, row.recorded_at, row.payload, row.event_ids_json])
    reopenedRecorder.reconcileMessages(workerSession, staleMessages)
    expect(
      reopenedStore
        .progressFacts([firstAttemptID])
        .map((row) => [row.seq, row.at, row.recorded_at, row.payload, row.event_ids_json]),
    ).toEqual(staleReplaySnapshot)

    const priorRecordedAt = reopenedStore
      .progressFacts([firstAttemptID])
      .find((row) => row.call_id === "call-timing")!.recorded_at!
    const priorAt = reopenedStore
      .progressFacts([firstAttemptID])
      .find((row) => row.call_id === "call-timing")!.at
    const originalCalledEvent = nativeEvents(false).find((event) => event.id === "evt-tool-called")!
    Date.now = () => 0
    try {
      reopenedRecorder.recordNativeEvent({
        ...originalCalledEvent,
        id: "evt-tool-called-replay",
      })
    } finally {
      Date.now = originalNow
    }
    const afterRollback = reopenedStore
      .progressFacts([firstAttemptID])
      .find((row) => row.call_id === "call-timing")!
    expect(afterRollback.recorded_at).toBeGreaterThanOrEqual(priorRecordedAt)
    expect(afterRollback.at).toBe(priorAt)
    expect(rows(decodedFixture).map((row) => row.kind)).toContain("verification")
  } finally {
    Date.now = originalNow
    reopened?.close()
    numericFixture.close()
    decodedFixture.close()
  }
})

test("retained unavailable routes are canonical on first write and idempotent through replay and reopen", () => {
  const originalNow = Date.now
  const retainedMessages = [
    {
      id: "msg-null-retained-route",
      type: "assistant",
      model: null,
      time: { created: 14_000 },
      content: [],
    },
    {
      id: "msg-malformed-retained-effort",
      type: "assistant",
      model: { providerID: "openrouter", id: "vendor/model", variant: 7 },
      time: { created: 14_100 },
      content: [],
    },
  ]

  for (const reopenBeforeReplay of [false, true]) {
    const fixture = makeFixture()
    let reopenedRepository: TaskRepository | undefined
    let store = fixture.store
    let recorder = new ProgressRecorder(store, "project")
    let clock = 50_000
    try {
      Date.now = () => clock
      recorder.reconcileMessages(workerSession, retainedMessages)

      const snapshot = () =>
        store.progressFacts([firstAttemptID]).map((row) => ({
          seq: row.seq,
          at: row.at,
          recorded_at: row.recorded_at,
          source: row.source,
          sources_json: row.sources_json,
          kind: row.kind,
          message_id: row.message_id,
          payload: row.payload,
        }))
      const firstWrite = snapshot()
      const firstRows = store.progressFacts([firstAttemptID])
      const firstSteps = firstRows.filter((row) => row.kind === "step")
      expect(firstWrite).toHaveLength(firstRows.length)
      expect(firstSteps).toHaveLength(2)
      for (const row of firstSteps) {
        expect(row.kind).toBe("step")
        expect(row.source).toBe("recovery")
        expect(row.at).toBe(row.message_id === "msg-null-retained-route" ? 14_000 : 14_100)
        expect(JSON.parse(row.payload)).toMatchObject({
          routeEvidence: { status: "identity-unavailable" },
          route: null,
        })
      }

      if (reopenBeforeReplay) {
        const dbPath = fixture.repository.path
        const projectDirectory = fixture.repository.projectDirectory
        fixture.repository.close()
        reopenedRepository = new TaskRepository(dbPath, projectDirectory)
        store = new RunnerStore(reopenedRepository)
        recorder = new ProgressRecorder(store, "project")
        expect(snapshot()).toEqual(firstWrite)
      }

      for (let replay = 0; replay < 3; replay++) {
        clock += 100
        recorder.reconcileMessages(workerSession, retainedMessages)
        expect(snapshot()).toEqual(firstWrite)
      }
    } finally {
      Date.now = originalNow
      reopenedRepository?.close()
      fixture.close()
    }
  }
})

test("retained terminal execution wins over stale snapshots in every replay order", () => {
  const fixture = makeFixture()
  let reopened: TaskRepository | undefined
  const originalNow = Date.now
  let clock = 10_000
  const sequences = permutations([
    "running",
    "completed",
    "completed",
    "running",
    "running",
  ] as RetainedToolState[])
  const stableByCallID = new Map<string, ReturnType<typeof stableToolRow>>()
  try {
    Date.now = () => clock++
    const recorder = new ProgressRecorder(fixture.store, "project")
    for (const [index, sequence] of sequences.entries()) {
      const callID = `retained-terminal-${index}`
      const messageID = `retained-terminal-message-${index}`
      let terminal: ReturnType<typeof stableToolRow> | undefined
      for (const state of sequence) {
        recorder.reconcileMessages(workerSession, [
          retainedToolMessage(messageID, callID, state, state === "completed"),
        ])
        const rows = fixture.store.progressFacts([firstAttemptID])
        const matchingRows = rows.filter((row) => row.call_id === callID)
        expect(matchingRows).toHaveLength(1)
        const row = matchingRows[0]!
        if (!terminal && state === "completed") {
          const payload = JSON.parse(row.payload) as StoredToolPayload
          expect(payload.execution).toMatchObject({
            status: "executed",
            source: "recovery",
            phase: 2,
          })
          expect(payload.status).toBe("succeeded")
          expect(payload.timing?.endpoints?.completedAt).toMatchObject({
            at: 300,
            source: "recovery",
          })
          terminal = stableToolRow(row)
        } else if (terminal) {
          expect(stableToolRow(row)).toEqual(terminal)
        }
      }
      expect(terminal).toBeDefined()
      stableByCallID.set(callID, terminal!)
    }

    const dbPath = fixture.repository.path
    const projectDirectory = fixture.repository.projectDirectory
    fixture.repository.close()
    reopened = new TaskRepository(dbPath, projectDirectory)
    const reopenedStore = new RunnerStore(reopened)
    const reopenedRecorder = new ProgressRecorder(reopenedStore, "project")
    for (const [index, sequence] of sequences.entries()) {
      const callID = `retained-terminal-${index}`
      const messageID = `retained-terminal-message-${index}`
      for (const state of sequence)
        reopenedRecorder.reconcileMessages(workerSession, [
          retainedToolMessage(messageID, callID, state, state === "completed"),
        ])
      const row = reopenedStore
        .progressFacts([firstAttemptID])
        .find((item) => item.call_id === callID)!
      expect(stableToolRow(row)).toEqual(stableByCallID.get(callID)!)
    }
  } finally {
    Date.now = originalNow
    reopened?.close()
    fixture.close()
  }
})

test("equally authoritative retained execution conflicts survive permutations and reopen", () => {
  const fixture = makeFixture()
  let reopened: TaskRepository | undefined
  const originalNow = Date.now
  let clock = 20_000
  const sequences = permutations(["not-executed", "executed", "executed", "not-executed"])
  const stableByCallID = new Map<string, ReturnType<typeof stableToolRow>>()
  try {
    Date.now = () => clock++
    const recorder = new ProgressRecorder(fixture.store, "project")
    for (const [index, sequence] of sequences.entries()) {
      const callID = `retained-conflict-${index}`
      const messageID = `retained-conflict-message-${index}`
      const seen = new Set<string>()
      let conflict: ReturnType<typeof stableToolRow> | undefined
      for (const executedValue of sequence) {
        seen.add(executedValue)
        recorder.reconcileMessages(workerSession, [
          retainedToolMessage(messageID, callID, "running", executedValue === "executed"),
        ])
        const rows = fixture.store.progressFacts([firstAttemptID])
        const row = rows.find((item) => item.call_id === callID)!
        if (seen.size === 2 && !conflict) {
          const payload = JSON.parse(row.payload) as StoredToolPayload
          expect(payload.execution).toMatchObject({
            status: "unknown",
            source: "recovery",
            sourceType: "retained-assistant-tool.executed",
            phase: 1,
            conflict: true,
          })
          const evidence = payload.execution?.evidence ?? []
          expect(evidence.map((item) => item.status).sort()).toEqual(["executed", "not-executed"])
          conflict = stableToolRow(row)
        } else if (conflict) {
          expect(stableToolRow(row)).toEqual(conflict)
        }
      }
      expect(conflict).toBeDefined()
      stableByCallID.set(callID, conflict!)
    }

    const legacyCallID = "retained-legacy-conflict"
    const legacyMessageID = "retained-legacy-conflict-message"
    for (const executed of [false, true])
      recorder.reconcileMessages(workerSession, [
        retainedToolMessage(legacyMessageID, legacyCallID, "running", executed),
      ])
    const conflictedRow = fixture.store
      .progressFacts([firstAttemptID])
      .find((row) => row.call_id === legacyCallID)!
    const conflictedPayload = JSON.parse(conflictedRow.payload) as Record<string, unknown>
    const legacyPayload = {
      ...conflictedPayload,
      execution: {
        status: "unknown",
        source: "recovery",
        sourceType: "retained-assistant-tool.executed",
        meaning: "Execution state is conflicting in equally authoritative native observations",
      },
    }
    fixture.store.atomic((db) =>
      db
        .query("UPDATE runner_progress SET payload=? WHERE seq=?")
        .run(JSON.stringify(legacyPayload), conflictedRow.seq),
    )
    const legacyBeforeReplay = stableToolRow(
      fixture.store.progressFacts([firstAttemptID]).find((row) => row.call_id === legacyCallID)!,
    )
    for (const executed of [false, true, true, false])
      recorder.reconcileMessages(workerSession, [
        retainedToolMessage(legacyMessageID, legacyCallID, "running", executed),
      ])
    const legacyAfterReplay = fixture.store
      .progressFacts([firstAttemptID])
      .find((row) => row.call_id === legacyCallID)!
    expect(stableToolRow(legacyAfterReplay)).toEqual(legacyBeforeReplay)
    expect(JSON.parse(legacyAfterReplay.payload).execution).toMatchObject({
      status: "unknown",
      meaning: "Execution state is conflicting in equally authoritative native observations",
    })
    stableByCallID.set(legacyCallID, legacyBeforeReplay)

    const dbPath = fixture.repository.path
    const projectDirectory = fixture.repository.projectDirectory
    fixture.repository.close()
    reopened = new TaskRepository(dbPath, projectDirectory)
    const reopenedStore = new RunnerStore(reopened)
    const reopenedRecorder = new ProgressRecorder(reopenedStore, "project")
    for (const [index, sequence] of sequences.entries()) {
      const callID = `retained-conflict-${index}`
      const messageID = `retained-conflict-message-${index}`
      for (const executedValue of sequence)
        reopenedRecorder.reconcileMessages(workerSession, [
          retainedToolMessage(messageID, callID, "running", executedValue === "executed"),
        ])
      const row = reopenedStore
        .progressFacts([firstAttemptID])
        .find((item) => item.call_id === callID)!
      expect(stableToolRow(row)).toEqual(stableByCallID.get(callID)!)
    }
    for (const executed of [false, true])
      reopenedRecorder.reconcileMessages(workerSession, [
        retainedToolMessage(legacyMessageID, legacyCallID, "running", executed),
      ])
    const legacyReopenedRow = reopenedStore
      .progressFacts([firstAttemptID])
      .find((item) => item.call_id === legacyCallID)!
    expect(stableToolRow(legacyReopenedRow)).toEqual(stableByCallID.get(legacyCallID)!)
  } finally {
    Date.now = originalNow
    reopened?.close()
    fixture.close()
  }
})

test("recorded-at migration preserves legacy progress identity and leaves legacy time unknown", () => {
  const fixture = makeFixture()
  try {
    const legacy = fixture.store.atomic((db) => {
      db.query(
        `INSERT INTO runner_progress
         (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,source,
          sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        fixture.directory,
        "project",
        fixture.attempts[0]!.plan_id,
        fixture.task.id,
        firstAttemptID,
        workerSession,
        1234,
        "recovery",
        '["recovery"]',
        "commentary",
        "[]",
        null,
        "msg-legacy-progress",
        "legacy-progress-row",
        '{"text":"legacy"}',
      )
      const row = db
        .query<{ seq: number }, [string]>("SELECT seq FROM runner_progress WHERE dedupe_key=?")
        .get("legacy-progress-row")!
      // S2-4: the legacy layout also predates the runner generation record.
      db.query("DELETE FROM schema_modules WHERE module='runner'").run()
      db.exec("ALTER TABLE runner_progress DROP COLUMN recorded_at")
      return row.seq
    })

    new RunnerStore(fixture.repository)
    const migrated = fixture.store
      .progressFacts([firstAttemptID])
      .find((row) => row.seq === legacy)!
    expect(migrated).toMatchObject({ seq: legacy, at: 1234, recorded_at: null })
    new RunnerStore(fixture.repository)
    const columns = fixture.store.atomic((db) =>
      db.query<{ name: string }, []>("PRAGMA table_info(runner_progress)").all(),
    )
    expect(columns.filter((column) => column.name === "recorded_at")).toHaveLength(1)
    expect(
      fixture.store
        .progressFacts([firstAttemptID])
        .filter((row) => row.dedupe_key === "legacy-progress-row"),
    ).toHaveLength(1)
  } finally {
    fixture.close()
  }
})

test("startup reconciliation resolves a claimed reminder by exact synthetic identity or keeps admission unknown", () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const claim = recorder.claimReminder(
      "ses-accepted",
      "Provide the remaining handoff.",
      "msg_restart_reminder",
    )!
    const beforeRestart = fixture.store
      .progressFacts([secondAttemptID])
      .find((row) => row.kind === "reminder")!
    expect(JSON.parse(beforeRestart.payload).delivery).toBe("dispatching")
    const restarted = new ProgressRecorder(fixture.store, "project")
    restarted.reconcileMessages("ses-accepted", [
      {
        id: claim.messageID,
        type: "synthetic",
        text: "Provide the remaining handoff.",
        metadata: claim.ownership,
      },
    ])
    const admitted = fixture.store
      .progressFacts([secondAttemptID])
      .find((row) => row.kind === "reminder")!
    expect(JSON.parse(admitted.payload).delivery).toBe("admitted")
    expect(JSON.parse(admitted.sources_json)).toContain("recovery")
    const admittedRecordedAt = admitted.recorded_at
    restarted.reconcileMessages("ses-accepted", [
      {
        id: claim.messageID,
        type: "synthetic",
        text: "Provide the remaining handoff.",
        metadata: claim.ownership,
      },
    ])
    const replayedAdmission = fixture.store
      .progressFacts([secondAttemptID])
      .find((row) => row.kind === "reminder")!
    expect(replayedAdmission.recorded_at).toBe(admittedRecordedAt)
    expect(restarted.finishReminder(claim, "unknown")).toBe(false)

    const secondClaim = restarted.claimReminder(
      "ses-accepted",
      "Provide the remaining handoff.",
      "unused-random-id",
    )
    expect(secondClaim).toBeUndefined()

    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    const interruptedClaim = restarted.claimReminder(
      "ses-failed",
      "Provide the remaining handoff.",
      "msg_crash_before_response",
    )!
    const afterCrash = new ProgressRecorder(fixture.store, "project")
    afterCrash.reconcileMessages("ses-failed", [])
    const uncertain = fixture.store
      .progressFacts([firstAttemptID])
      .find((row) => row.kind === "reminder")!
    expect(JSON.parse(uncertain.payload).delivery).toBe("unknown")
    expect(
      afterCrash.claimReminder("ses-failed", "Provide the remaining handoff.", "new-id"),
    ).toBeUndefined()
    expect(interruptedClaim.messageID).toBe("msg_crash_before_response")
  } finally {
    fixture.close()
  }
})

test("native synthetic admission event completes only its owned reminder claim", () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const claim = recorder.claimReminder(
      "ses-accepted",
      "Provide the remaining handoff.",
      "msg_event_reminder",
    )!
    const event = {
      id: "synthetic-admitted-event",
      type: "session.synthetic",
      created: 9000,
      data: {
        sessionID: "ses-accepted",
        text: "Provide the remaining handoff.",
        metadata: claim.ownership,
      },
    }
    recorder.recordNativeEvent(event)
    recorder.recordNativeEvent(event)
    const row = fixture.store
      .progressFacts([secondAttemptID])
      .find((fact) => fact.kind === "reminder")!
    expect(JSON.parse(row.payload).delivery).toBe("admitted")
    expect(JSON.parse(row.event_ids_json)).toEqual(["synthetic-admitted-event"])
    expect(JSON.parse(row.sources_json)).toContain("native-event")
    expect(recorder.finishReminder(claim, "unknown")).toBe(false)
  } finally {
    fixture.close()
  }
})

test("unchanged recovery performs no SQLite write while fresh and changed facts remain durable across connections", () => {
  const fixture = makeFixture()
  let observer: Database | undefined
  let reopened: TaskRepository | undefined
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const running = retainedToolMessage("msg-noop", "call-noop", "running", true)
    recorder.reconcileMessages(workerSession, [running])
    observer = new Database(fixture.repository.path, { readonly: true })
    const state = () => ({
      dataVersion: observer!.query("PRAGMA data_version").get(),
      sequence: observer!
        .query("SELECT seq FROM sqlite_sequence WHERE name='runner_progress'")
        .get(),
      facts: observer!.query("SELECT * FROM runner_progress ORDER BY seq").all(),
      revisions: observer!
        .query("SELECT * FROM observation_revisions ORDER BY project_directory")
        .all(),
    })
    const first = state()
    expect(first.facts.length).toBeGreaterThan(0)
    recorder.reconcileMessages(workerSession, [running])
    expect(state()).toEqual(first)

    // Another connection's material update must be read afresh, never cached.
    reopened = new TaskRepository(fixture.repository.path, fixture.directory)
    const otherRecorder = new ProgressRecorder(new RunnerStore(reopened), "project")
    const completed = retainedToolMessage("msg-noop", "call-noop", "completed", true)
    const beforeChange = state()
    otherRecorder.reconcileMessages(workerSession, [completed])
    const changed = state()
    expect(changed.facts).not.toEqual(beforeChange.facts)
    expect(changed.dataVersion).not.toEqual(beforeChange.dataVersion)
    expect(changed.sequence).toEqual(beforeChange.sequence)
    expect(changed.revisions).not.toEqual(beforeChange.revisions)
    recorder.reconcileMessages(workerSession, [completed])
    expect(state()).toEqual(changed)

    const newMessage = retainedToolMessage("msg-new", "call-new", "completed", true)
    recorder.reconcileMessages(workerSession, [completed, newMessage])
    const inserted = state()
    expect(inserted.facts.length).toBeGreaterThan(changed.facts.length)
    expect(inserted.sequence).not.toEqual(changed.sequence)
    expect(inserted.dataVersion).not.toEqual(changed.dataVersion)
    otherRecorder.reconcileMessages(workerSession, [completed, newMessage])
    expect(state()).toEqual(inserted)
  } finally {
    observer?.close()
    reopened?.close()
    fixture.close()
  }
})

test("warm unchanged recovery skips per-message fact append and merge attempts across history sizes", () => {
  for (const historySize of [1, 4, 16]) {
    const fixture = makeFixture()
    try {
      const recorder = new ProgressRecorder(fixture.store, "project")
      const work = observeReplayWork(recorder)
      const history = retainedToolHistory(historySize)
      const state = () =>
        fixture.store.atomic((db) => ({
          facts: db.query("SELECT * FROM runner_progress ORDER BY seq").all(),
          sequence: db.query("SELECT seq FROM sqlite_sequence WHERE name='runner_progress'").get(),
          revision: db
            .query("SELECT revision FROM observation_revisions WHERE project_directory=?")
            .get(fixture.directory),
        }))

      recorder.reconcileMessages(workerSession, history)
      // The pre-memo repeated-replay path attempted one tool and one assistant
      // step append per message, followed by the fixed recovery-gap append.
      expect(work.appendAttempts()).toBe(2 * historySize + 1)
      const durable = state()

      work.resetAppendAttempts()
      recorder.reconcileMessages(workerSession, history)

      expect(work.reminderReconciliations()).toBe(2)
      expect(work.appendAttempts()).toBe(0)
      expect(state()).toEqual(durable)
    } finally {
      fixture.close()
    }
  }
})

test("bounded recovery memo preserves warm reuse across 122 terminal sessions and unrelated activity", () => {
  const fixture = makeFixture()
  let otherRepository: TaskRepository | undefined
  try {
    const assignments = addTerminalAssignments(fixture, 122)
    const attemptIDs = assignments.map((assignment) => assignment.attemptID)
    const sessionIDs = assignments.map((assignment) => assignment.sessionID)
    const recorder = new ProgressRecorder(fixture.store, "project")
    const work = observeReplayWork(recorder)
    otherRepository = new TaskRepository(fixture.repository.path, fixture.directory)
    const otherRecorder = new ProgressRecorder(new RunnerStore(otherRepository), "project")
    const cache = recorder as unknown as {
      reconcileStates: Map<
        string,
        { assignmentFingerprint: string; stamps: Map<string, { light: string; full?: string }> }
      >
    }
    const retainedFor = (sessionID: string) => [
      retainedToolMessage(
        `msg-retained-${sessionID}`,
        `call-retained-${sessionID}`,
        "completed",
        true,
      ),
    ]
    const replayAll = () => {
      for (const sessionID of sessionIDs)
        recorder.reconcileMessages(sessionID, retainedFor(sessionID))
    }
    const state = () => ({
      facts: fixture.store.progressFacts(attemptIDs),
      sequence: fixture.store.atomic((db) =>
        db.query("SELECT seq FROM sqlite_sequence WHERE name='runner_progress'").get(),
      ),
      revision: fixture.store.atomic((db) =>
        db
          .query("SELECT revision FROM observation_revisions WHERE project_directory=?")
          .get(fixture.directory),
      ),
    })

    expect(
      recorder.assignments().filter((assignment) => sessionIDs.includes(assignment.sessionID)),
    ).toHaveLength(122)

    replayAll()
    expect(work.appendAttempts()).toBe(122 * 3)
    expect(cache.reconcileStates.size).toBe(122)
    expect(cache.reconcileStates.size).toBeLessThanOrEqual(256)
    const retainedMetadata = [...cache.reconcileStates.entries()]
    expect(retainedMetadata.every(([sessionID]) => sessionIDs.includes(sessionID))).toBe(true)
    expect(
      retainedMetadata.every(
        ([, memo]) =>
          /^[a-f0-9]{64}$/.test(memo.assignmentFingerprint) &&
          [...memo.stamps.values()].every(
            (stamp) =>
              /^[a-f0-9]{64}$/.test(stamp.light) && /^[a-f0-9]{64}$/.test(stamp.full ?? ""),
          ),
      ),
    ).toBe(true)
    expect(JSON.stringify([...retainedMetadata.map(([, memo]) => [...memo.stamps])])).not.toContain(
      "private",
    )
    const cold = state()

    work.resetAppendAttempts()
    replayAll()
    expect(work.appendAttempts()).toBe(0)
    expect(state()).toEqual(cold)

    work.resetAppendAttempts()
    replayAll()
    expect(work.appendAttempts()).toBe(0)
    const warm = state()

    otherRecorder.recordNativeObservation({
      sessionID: "ses-accepted",
      listenerID: "unrelated-worker-listener",
      directory: fixture.directory,
      phase: "unrelated-progress-activity",
    })
    const afterUnrelatedActivity = state()
    expect(afterUnrelatedActivity.facts).toEqual(warm.facts)
    expect(afterUnrelatedActivity.sequence).not.toEqual(warm.sequence)

    work.resetAppendAttempts()
    replayAll()
    expect(work.appendAttempts()).toBe(0)
    const afterRecheck = state()
    expect(afterRecheck).toEqual(afterUnrelatedActivity)

    work.resetAppendAttempts()
    replayAll()
    expect(work.appendAttempts()).toBe(0)
    expect(state()).toEqual(afterRecheck)
    expect(cache.reconcileStates.size).toBe(122)
  } finally {
    otherRepository?.close()
    fixture.close()
  }
})

test("recovery fingerprint distinguishes an absent property from an own undefined route", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const retained = {
      id: "msg-route-ownership",
      type: "assistant",
      time: { created: 1_000 },
      content: [],
    }
    recorder.reconcileMessages(workerSession, [retained])
    const step = () =>
      fixture.store.progressFacts([firstAttemptID]).find((row) => row.kind === "step")!
    expect(JSON.parse(step().payload)).not.toHaveProperty("routeEvidence")

    recorder.reconcileMessages(workerSession, [{ ...retained, model: undefined }])

    expect(JSON.parse(step().payload)).toMatchObject({
      routeEvidence: { status: "identity-unavailable" },
      route: null,
    })
  } finally {
    fixture.close()
  }
})

test("fresh native UTC and zoned timestamps reuse recovery by their recorded epoch millis", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const work = observeReplayWork(recorder)
    const timestamp = (millis: number, zone: "numeric" | "utc" | "zoned" | "offset") => {
      if (zone === "numeric") return millis
      if (zone === "utc") return DateTime.makeUnsafe(millis)
      return DateTime.makeZonedUnsafe(millis, {
        timeZone: zone === "offset" ? 0 : "America/Los_Angeles",
      })
    }
    const retained = (
      zone: "numeric" | "utc" | "zoned" | "offset",
      values: {
        created: number
        toolCreated: number
        ran: number
        streamed?: number
        completed?: number
        toolCompleted?: number
      },
    ) => {
      const terminal = values.completed !== undefined
      return [
        {
          id: "msg-native-datetime",
          type: "assistant",
          time: {
            created: timestamp(values.created, zone),
            ...(values.streamed !== undefined
              ? { streamed: timestamp(values.streamed, zone) }
              : {}),
            ...(values.completed !== undefined
              ? { completed: timestamp(values.completed, zone) }
              : {}),
          },
          content: [
            {
              type: "tool",
              id: "call-native-datetime",
              name: "Bash",
              executed: true,
              time: {
                created: timestamp(values.toolCreated, zone),
                ran: timestamp(values.ran, zone),
                ...(values.toolCompleted !== undefined
                  ? { completed: timestamp(values.toolCompleted, zone) }
                  : {}),
              },
              state: {
                status: terminal ? "completed" : "running",
                input: { command: "private" },
                ...(terminal ? { content: [{ type: "text", text: "done" }] } : {}),
              },
            },
          ],
        },
      ]
    }
    const state = () =>
      fixture.store.atomic((db) => ({
        facts: db
          .query<
            {
              kind: string
              at: number
              payload: string
              call_id: string | null
              event_ids_json: string
            },
            []
          >("SELECT * FROM runner_progress ORDER BY seq")
          .all(),
        sequence: db.query("SELECT seq FROM sqlite_sequence WHERE name='runner_progress'").get(),
      }))
    const initial = { created: 10_000, toolCreated: 9_000, ran: 9_500 }

    recorder.reconcileMessages(workerSession, retained("numeric", initial))
    expect(work.appendAttempts()).toBe(3)
    const cold = state()
    const initialStep = cold.facts.find((row) => row.kind === "step")!
    const initialTool = cold.facts.find((row) => row.call_id === "call-native-datetime")!
    expect(initialStep.at).toBe(initial.created)
    expect(JSON.parse(initialStep.payload).timing.endpoints.startedAt.at).toBe(initial.created)
    expect(JSON.parse(initialTool.payload).timing.endpoints).toMatchObject({
      inputAt: { at: initial.toolCreated },
      calledAt: { at: initial.ran },
    })

    work.resetAppendAttempts()
    recorder.reconcileMessages(workerSession, retained("utc", initial))
    expect(work.appendAttempts()).toBe(0)
    expect(state()).toEqual(cold)

    // A zone changes calendar presentation, but the recorder projects both
    // DateTime variants to the same truncated safe epoch-millisecond instant.
    work.resetAppendAttempts()
    recorder.reconcileMessages(workerSession, retained("zoned", initial))
    expect(work.appendAttempts()).toBe(0)
    expect(state()).toEqual(cold)

    const changed = {
      created: initial.created - 1,
      toolCreated: initial.toolCreated - 1,
      ran: initial.ran - 1,
    }
    work.resetAppendAttempts()
    recorder.reconcileMessages(workerSession, retained("utc", changed))
    expect(work.appendAttempts()).toBe(3)
    const changedState = state()
    const changedStep = changedState.facts.find((row) => row.kind === "step")!
    const changedTool = changedState.facts.find((row) => row.call_id === "call-native-datetime")!
    expect(changedStep.at).toBe(initial.created)
    expect(JSON.parse(changedStep.payload).timing.endpoints.startedAt.at).toBe(changed.created)
    expect(JSON.parse(changedTool.payload).timing.endpoints).toMatchObject({
      inputAt: { at: changed.toolCreated },
      calledAt: { at: changed.ran },
    })
    expect(changedTool.at).toBe(initial.created)

    const late = {
      ...changed,
      streamed: changed.created + 20,
      completed: changed.created + 30,
      toolCompleted: changed.ran + 10,
    }
    work.resetAppendAttempts()
    recorder.reconcileMessages(workerSession, retained("zoned", late))
    expect(work.appendAttempts()).toBe(3)
    const lateState = state()
    const lateStep = lateState.facts.find((row) => row.kind === "step")!
    const lateTool = lateState.facts.find((row) => row.call_id === "call-native-datetime")!
    expect(JSON.parse(lateStep.payload)).toMatchObject({
      status: "ended",
      timing: {
        endpoints: {
          streamedAt: { at: late.streamed },
          completedAt: { at: late.completed },
        },
      },
    })
    expect(JSON.parse(lateTool.payload)).toMatchObject({
      status: "succeeded",
      timing: { endpoints: { completedAt: { at: late.toolCompleted } } },
    })

    work.resetAppendAttempts()
    recorder.reconcileMessages(workerSession, retained("offset", late))
    expect(work.appendAttempts()).toBe(0)
    expect(state()).toEqual(lateState)

    const nativeInputAt = late.toolCreated - 2
    recorder.recordNativeEvent({
      id: "evt-native-datetime-input",
      type: "session.tool.input.started",
      created: DateTime.makeZonedUnsafe(nativeInputAt, { timeZone: "America/New_York" }),
      data: {
        sessionID: workerSession,
        assistantMessageID: "msg-native-datetime",
        id: "call-native-datetime",
        name: "Bash",
      },
    })
    const afterNativeEvent = state()
    work.resetAppendAttempts()
    recorder.reconcileMessages(workerSession, retained("utc", late))
    // Retained content is unchanged, so the native update is not re-merged by recovery.
    expect(work.appendAttempts()).toBe(0)
    const replayedTool = state().facts.find((row) => row.call_id === "call-native-datetime")!
    expect(JSON.parse(replayedTool.payload).timing.endpoints.inputAt).toMatchObject({
      at: nativeInputAt,
      source: "native-event",
    })
    expect(JSON.parse(replayedTool.event_ids_json)).toContain("evt-native-datetime-input")
    expect(state()).toEqual(afterNativeEvent)

    work.resetAppendAttempts()
    recorder.reconcileMessages(workerSession, retained("zoned", late))
    expect(work.appendAttempts()).toBe(0)
    expect(state()).toEqual(afterNativeEvent)
  } finally {
    fixture.close()
  }
})

test("unsafe timestamp lookalikes, getters, and cycles never warm recovery fingerprints", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const work = observeReplayWork(recorder)
    let lookalikeToJSONCalls = 0
    class TimestampLookalike {
      epochMilliseconds = 20_000
      toJSON() {
        lookalikeToJSONCalls++
        return { epochMilliseconds: this.epochMilliseconds }
      }
    }
    const lookalike = new TimestampLookalike()
    const fakeDateTimeMessage = {
      ...retainedToolMessage("msg-fake-datetime", "call-fake-datetime", "running", true),
      time: { created: lookalike },
    }
    const cyclicMessage = retainedToolMessage("msg-cyclic", "call-cyclic", "running", true) as {
      [key: string]: unknown
    }
    cyclicMessage.self = cyclicMessage
    let getterReads = 0
    const getterMessage = retainedToolMessage("msg-getter", "call-getter", "running", true)
    Object.defineProperty(getterMessage, "unsafe", {
      enumerable: true,
      get: () => {
        getterReads++
        return "do not read"
      },
    })

    for (const message of [fakeDateTimeMessage, cyclicMessage, getterMessage]) {
      recorder.reconcileMessages(workerSession, [message])
      expect(work.appendAttempts()).toBe(3)
      work.resetAppendAttempts()

      recorder.reconcileMessages(workerSession, [message])
      expect(work.appendAttempts()).toBe(3)
      work.resetAppendAttempts()
    }
    expect(getterReads).toBe(0)
    expect(lookalikeToJSONCalls).toBe(0)
  } finally {
    fixture.close()
  }
})

test("DateTime values in non-timestamp payloads do not normalize away meaningful route changes", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const work = observeReplayWork(recorder)
    const message = (modelID: string) => {
      const model = Object.assign(DateTime.makeUnsafe(20_000), {
        providerID: "openai",
        id: modelID,
      })
      return [
        {
          ...retainedToolMessage(
            "msg-non-timestamp-datetime",
            "call-non-timestamp-datetime",
            "running",
            true,
          ),
          model,
        },
      ]
    }

    recorder.reconcileMessages(workerSession, message("model-a"))
    expect(work.appendAttempts()).toBe(3)
    const step = () =>
      fixture.store.progressFacts([firstAttemptID]).find((row) => row.kind === "step")!
    expect(JSON.parse(step().payload).routeEvidence).toMatchObject({
      status: "observed",
      route: { providerID: "openai", modelID: "model-a" },
    })

    work.resetAppendAttempts()
    recorder.reconcileMessages(workerSession, message("model-b"))
    expect(work.appendAttempts()).toBe(3)
    expect(JSON.parse(step().payload).routeEvidence).toMatchObject({
      status: "identity-unavailable",
    })
  } finally {
    fixture.close()
  }
})

test("retained recovery reprojects after same- and other-connection native updates", () => {
  const fixture = makeFixture()
  let otherRepository: TaskRepository | undefined
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const work = observeReplayWork(recorder)
    otherRepository = new TaskRepository(fixture.repository.path, fixture.directory)
    const otherRecorder = new ProgressRecorder(new RunnerStore(otherRepository), "project")
    const retained = retainedToolMessage("msg-noop", "call-noop", "running", true)
    const state = () =>
      fixture.store.atomic((db) => ({
        facts: db
          .query<{ call_id: string | null; payload: string; event_ids_json: string }, []>(
            "SELECT * FROM runner_progress ORDER BY seq",
          )
          .all(),
        sequence: db.query("SELECT seq FROM sqlite_sequence WHERE name='runner_progress'").get(),
        revision: db
          .query("SELECT revision FROM observation_revisions WHERE project_directory=?")
          .get(fixture.directory),
      }))

    recorder.reconcileMessages(workerSession, [retained])
    const beforeNativeUpdate = state()
    recorder.recordNativeEvent(
      toolEvent(
        "session.tool.success",
        "event-late-success",
        {
          assistantMessageID: "msg-noop",
          id: "call-noop",
          content: [{ type: "text", text: "done" }],
          executed: true,
        },
        300,
      ),
    )
    const afterNativeUpdate = state()
    expect(afterNativeUpdate).not.toEqual(beforeNativeUpdate)

    work.resetAppendAttempts()
    recorder.reconcileMessages(workerSession, [retained])

    expect(work.appendAttempts()).toBe(0)
    const afterSameConnectionReplay = state()
    expect(afterSameConnectionReplay).toEqual(afterNativeUpdate)
    const sameConnectionTool = afterSameConnectionReplay.facts.find(
      (row) => row.call_id === "call-noop",
    ) as {
      payload: string
      event_ids_json: string
    }
    expect(JSON.parse(sameConnectionTool.payload)).toMatchObject({
      status: "succeeded",
      timing: {
        endpoints: {
          inputAt: { at: 90, source: "recovery" },
          calledAt: { at: 200, source: "recovery" },
          completedAt: { at: 300, source: "native-event" },
        },
      },
    })

    otherRecorder.recordNativeEvent(
      toolEvent(
        "session.tool.input.started",
        "event-late-input",
        {
          assistantMessageID: "msg-noop",
          id: "call-noop",
          name: "Bash",
        },
        80,
      ),
    )
    const afterOtherConnectionUpdate = state()
    expect(afterOtherConnectionUpdate).not.toEqual(afterSameConnectionReplay)

    work.resetAppendAttempts()
    recorder.reconcileMessages(workerSession, [retained])

    expect(work.appendAttempts()).toBe(0)
    const afterRetainedReplay = state()
    expect(afterRetainedReplay).toEqual(afterOtherConnectionUpdate)
    const replayedTool = afterRetainedReplay.facts.find((row) => row.call_id === "call-noop") as {
      payload: string
      event_ids_json: string
    }
    expect(JSON.parse(replayedTool.payload)).toMatchObject({
      status: "succeeded",
      timing: {
        endpoints: {
          inputAt: { at: 80, source: "native-event" },
          calledAt: { at: 200, source: "recovery" },
          completedAt: { at: 300, source: "native-event" },
        },
      },
    })
    expect(JSON.parse(replayedTool.event_ids_json)).toEqual(
      expect.arrayContaining(["event-late-input", "event-late-success"]),
    )

    work.resetAppendAttempts()
    recorder.reconcileMessages(workerSession, [retained])
    expect(work.appendAttempts()).toBe(0)
    expect(state()).toEqual(afterRetainedReplay)
  } finally {
    otherRepository?.close()
    fixture.close()
  }
})

test("more than 25 distinct observations on one fact are all stored and read back", () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const base = { assistantMessageID: "msg-many", id: "call-many", name: "bash" }
    for (let index = 0; index < 40; index++)
      recorder.recordNativeEvent(
        toolEvent("session.tool.input.started", `many-${index}`, base, 20_000 + index),
      )
    const facts = fixture.store
      .progressFacts([firstAttemptID])
      .filter((fact) => fact.call_id === "call-many")
    expect(facts).toHaveLength(1)
    const observations = JSON.parse(facts[0]!.payload).observations as Array<{ eventID: string }>
    expect(new Set(observations.map((item) => item.eventID)).size).toBe(40)
    expect(projectProgressFact(facts[0]!).observations).toHaveLength(40)
  } finally {
    fixture.close()
  }
})

test("a 5,000-character progress note is accepted and read back whole", () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const note = Array.from({ length: 500 }, (_, index) => `step ${index}`.padEnd(10, ".")).join("")
    expect(note.length).toBeGreaterThanOrEqual(5000)
    expect(ProgressInput.safeParse({ message: note }).success).toBe(true)
    const saved = recorder.report({
      sessionID: workerSession,
      agent: "lazers-implementor",
      callID: "long-note",
      messageID: "message-long-note",
      message: note,
    })
    expect(saved.text).toBe(note)
    const row = fixture.store
      .progressFacts([firstAttemptID])
      .find((entry) => entry.kind === "commentary")!
    expect(JSON.parse(row.payload).text).toBe(note)
    expect(projectProgressFact(row).text).toBe(note)
  } finally {
    fixture.close()
  }
})
