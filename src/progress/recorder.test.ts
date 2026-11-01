import { expect, test } from "bun:test"
import { TaskRepository } from "../storage.ts"
import { RunnerStore } from "../runner/store.ts"
import { Tool } from "@opencode/schema/tool"
import { makeFixture, firstAttemptID, secondAttemptID } from "../../test/trajectory/fixture.ts"
import { ProgressRecorder } from "./recorder.ts"

const workerSession = "ses-failed"

function toolEvent(type: string, id: string, data: Record<string, unknown>, created: number) {
  return {
    id,
    type,
    created,
    data: { sessionID: workerSession, ...data },
  }
}

test("hook, native tool events, and retained recovery coalesce into one durable identity", () => {
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
      agent: "lazers-implementor",
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
    expect(rows).toHaveLength(2) // the coalesced call and the explicit recovery coverage gap
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
      unchanged: true,
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
