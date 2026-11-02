import { expect, test } from "bun:test"
import { inspectTrajectory } from "./read.ts"
import { InspectTrajectoryInput } from "./schema.ts"
import { makeFixture, cursorSecret, taskID, firstAttemptID } from "../../test/trajectory/fixture.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { projectProgressFact } from "../progress/projection.ts"
import { openReadOnlyTrajectoryStore } from "./store.ts"

function parse(input: unknown) {
  return InspectTrajectoryInput.parse(input)
}

test("trajectory specifications preserve legacy policy references and omit absent ones", async () => {
  for (const withoutPolicy of [false, true]) {
    const fixture = makeFixture({ withoutPolicy })
    try {
      const before = JSON.stringify(fixture.repository.get(taskID))
      const report = await inspectTrajectory(
        fixture.store,
        fixture.host,
        "project",
        parse({ taskID }),
        cursorSecret,
      )
      const specification = report.task.specification as { requirements: Record<string, unknown> }
      expect(Object.hasOwn(specification.requirements, "policyReference")).toBe(!withoutPolicy)
      if (!withoutPolicy) expect(specification.requirements.policyReference).toBe("AGENTS.md")
      expect(JSON.stringify(fixture.repository.get(taskID))).toBe(before)
    } finally {
      fixture.close()
    }
  }
})

test("trajectory presents commentary separately from automatic worker facts without granting authority", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    const executionBefore = fixture.store.execution(taskID)
    const recorder = new ProgressRecorder(fixture.store, "project")
    recorder.report({
      sessionID: "ses-failed",
      agent: "lazers-implementor",
      callID: "read-progress-call",
      messageID: "msg_progress_note",
      message: "The implementation and checks are complete.",
    })
    recorder.recordNativeEvent({
      id: "read-tool-event",
      type: "session.tool.success",
      created: 4000,
      data: {
        sessionID: "ses-failed",
        assistantMessageID: "msg_auto_tool",
        id: "auto-tool-call",
        executed: true,
        content: [{ type: "text", text: "check completed" }],
      },
    })
    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID }),
      cursorSecret,
    )
    const commentary = report.trajectory.events.find((event) => event.kind === "commentary")
    const automatic = report.trajectory.events.find((event) => event.kind === "worker-tool")
    expect(commentary).toMatchObject({
      attemptID: firstAttemptID,
      text: "The implementation and checks are complete.",
    })
    expect(automatic).toMatchObject({
      attemptID: firstAttemptID,
      tool: null,
      status: "succeeded",
      result: "check completed",
      recordedAt: expect.any(Number),
      execution: { status: "executed", source: "native-event" },
      timing: {
        unit: "unix-epoch-ms",
        endpoints: {
          inputAt: { at: null, source: null },
          calledAt: { at: null, source: null },
          completedAt: { at: 4000, source: "native-event" },
        },
      },
    })
    expect(report.coverage.workerProgress).toMatchObject({
      commentary: 1,
      automaticFacts: 1,
      recoveryGaps: expect.any(Number),
      facts: expect.any(Number),
    })
    expect(fixture.store.execution(taskID)).toEqual(executionBefore)
  } finally {
    fixture.close()
  }
})

test("native-context timing keeps unknown endpoints null instead of using parent creation time", async () => {
  const fixture = makeFixture()
  try {
    const session = fixture.sessions.get("ses-failed")!
    session.messages = [
      ...(session.messages ?? []),
      {
        id: "msg-timing-context",
        type: "assistant",
        time: { created: 10_000, streamed: 10_500 },
        content: [
          {
            type: "tool",
            id: "call-no-run-time",
            name: "Bash",
            executed: false,
            time: { created: 10_100, completed: 10_300 },
            state: { status: "error", input: {}, error: { message: "not executed" } },
          },
          {
            type: "tool",
            id: "call-ran-only",
            name: "Bash",
            time: { ran: 10_250 },
            state: { status: "running", input: {} },
          },
        ],
      } as never,
    ]
    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 50 }),
      cursorSecret,
    )
    const tool = report.trajectory.events.find(
      (event) => event.id === "msg-timing-context:tool:call-no-run-time",
    )!
    expect(tool.at).toBeNull()
    expect(tool).toMatchObject({
      execution: { status: "not-executed", source: "native-context" },
      timing: {
        unit: "unix-epoch-ms",
        endpoints: {
          inputAt: { at: 10_100, source: "native-context" },
          calledAt: { at: null, source: null },
          completedAt: { at: 10_300, source: "native-context" },
        },
      },
    })
    const ranOnlyTool = report.trajectory.events.find(
      (event) => event.id === "msg-timing-context:tool:call-ran-only",
    )!
    expect(ranOnlyTool).toMatchObject({
      at: 10_250,
      execution: { status: "unknown", source: null },
      timing: {
        endpoints: {
          calledAt: { at: 10_250, source: "native-context" },
          completedAt: { at: null, source: null },
        },
      },
    })
    const step = report.trajectory.events.find(
      (event) => event.id === "msg-timing-context:assistant-step",
    )!
    expect(step).toMatchObject({
      status: "streamed",
      timing: {
        endpoints: {
          startedAt: { at: 10_000 },
          streamedAt: { at: 10_500 },
          completedAt: { at: null, source: null },
        },
      },
    })
  } finally {
    fixture.close()
  }
})

test("read-only trajectory access tolerates a pre-recorded_at progress table without migration", () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) => {
      db.query(
        `INSERT INTO runner_progress
         (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,source,
          sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        fixture.directory,
        "project",
        fixture.attempts[0]!.plan_id,
        taskID,
        firstAttemptID,
        "ses-failed",
        4321,
        "recovery",
        '["recovery"]',
        "commentary",
        "[]",
        null,
        "msg-legacy-readonly",
        "legacy-readonly-row",
        '{"text":"legacy note"}',
      )
      db.exec("ALTER TABLE runner_progress DROP COLUMN recorded_at")
    })

    const connection = openReadOnlyTrajectoryStore(
      fixture.repository.path,
      fixture.repository.projectDirectory,
    )
    try {
      const rows = connection.store.progressFacts([firstAttemptID])
      expect(rows).toHaveLength(1)
      expect(projectProgressFact(rows[0]!)).toMatchObject({
        sequence: rows[0]!.seq,
        at: 4321,
        recordedAt: null,
        text: "legacy note",
      })
    } finally {
      connection.close()
    }
    const columns = fixture.store.atomic((db) =>
      db.query<{ name: string }, []>("PRAGMA table_info(runner_progress)").all(),
    )
    expect(columns.some((column) => column.name === "recorded_at")).toBe(false)
  } finally {
    fixture.close()
  }
})

test("task reports include unsuccessful and accepted attempts, usage categories, checks and unknown cost", async () => {
  const fixture = makeFixture()
  try {
    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID }),
      cursorSecret,
    )
    expect(report.task.id).toBe(taskID)
    expect(report.task.specification.objective).toContain("Inspect a worker attempt")
    expect(report.task.specification).toHaveProperty("guidance")
    expect(JSON.stringify(report.task.specification)).toContain("Reuse src/runner/store.ts")
    expect(JSON.stringify(report.task.specification)).not.toContain("fake-guidance-secret")
    expect(report.plans[0]?.taskState).toBe("accepted")
    expect(report.plans[0]?.baseCommit).toBe("a".repeat(40))
    expect(report.plans[0]?.taskResultCommit).toBe("b".repeat(40))
    expect(report.effort.accepted).toBe(true)
    expect(report.effort.ongoing).toBe(false)
    expect(report.effort.wallClockSpanMs).toBe(3000)
    expect(report.attempts.map((attempt) => attempt.state)).toEqual(["failed", "accepted"])
    expect(report.attempts[0]?.admittedModel).toEqual({
      providerID: "openai",
      id: "gpt-6-luna",
      variant: "max",
    })
    expect(report.attempts[1]?.observedCurrentModel).toEqual({
      providerID: "openai",
      id: "gpt-6.1-sol",
      variant: "high",
    })
    expect(report.effort.tokenUsage.measuredSubtotal).toEqual({
      uncachedInput: 30,
      cacheRead: 12,
      cacheWrite: 1,
      output: 7,
      reasoning: 5,
    })
    expect(report.effort.tokenUsage.total).toEqual(report.effort.tokenUsage.measuredSubtotal)
    expect(report.effort.tokenUsage.legacyAttemptScalarsNotAdded).toHaveLength(2)
    expect(report.effort.toolCalls.count).toBe(5)
    expect(report.effort.providerRetries.count).toBe(1)
    expect(report.effort.recordedCost.workerAttemptSubtotalUsd).toBe(0)
    expect(report.effort.recordedCost.apiEquivalentTotalUsd).toBeNull()
    expect(report.effort.recordedCost.unknownContributions).toHaveLength(2)
    expect(report.plans[0]?.checks.map((check) => check.result)).toContain("failed")
    expect(report.plans[0]?.checks.map((check) => check.result)).toContain("passed")
    const toolEvents = report.trajectory.events.filter((event) => event.kind === "tool")
    expect(
      toolEvents.map((event) => ({
        id: event.id,
        status: event.status,
        completedAt: event.completedAt,
      })),
    ).toEqual([
      { id: "msg-old-tool:tool:call-failed", status: "error", completedAt: 1040 },
      { id: "msg-new-tool:tool:call-success", status: "completed", completedAt: 2030 },
    ])
    expect(report.coverage.transcript).toContain("session.context")
    expect(report.coverage.compacted).toBe(true)
  } finally {
    fixture.close()
  }
})

test("bounded pages preserve exact event order and reject stale or foreign continuations", async () => {
  const fixture = makeFixture()
  try {
    const first = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 2 }),
      cursorSecret,
    )
    expect(first.trajectory.hasMore).toBe(true)
    const paged = [...first.trajectory.events]
    let cursor = first.trajectory.nextCursor
    while (cursor) {
      const page = await inspectTrajectory(
        fixture.store,
        fixture.host,
        "project",
        parse({ taskID, limit: 2, cursor }),
        cursorSecret,
      )
      paged.push(...page.trajectory.events)
      cursor = page.trajectory.nextCursor
    }
    const complete = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 50 }),
      cursorSecret,
    )
    expect(paged).toEqual(complete.trajectory.events)
    expect(new Set(paged.map((event) => event.id)).size).toBe(paged.length)
    expect(paged.map((event) => event.id)).toEqual(
      [...paged]
        .sort((a, b) => {
          const left = typeof a.at === "number" ? a.at : Number.MAX_SAFE_INTEGER
          const right = typeof b.at === "number" ? b.at : Number.MAX_SAFE_INTEGER
          return left - right || String(a.id).localeCompare(String(b.id))
        })
        .map((event) => event.id),
    )

    const cursorFromFirst = first.trajectory.nextCursor!
    await expect(
      inspectTrajectory(
        fixture.store,
        fixture.host,
        "project",
        parse({ attemptID: firstAttemptID, limit: 2, cursor: cursorFromFirst }),
        cursorSecret,
      ),
    ).rejects.toThrow("Stale trajectory cursor")

    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET token_count=100 WHERE id=?").run(firstAttemptID),
    )
    await expect(
      inspectTrajectory(
        fixture.store,
        fixture.host,
        "project",
        parse({ taskID, limit: 2, cursor: cursorFromFirst }),
        cursorSecret,
      ),
    ).rejects.toThrow("Stale trajectory cursor")
  } finally {
    fixture.close()
  }
})

test("visible export redacts nested credentials before truncation and fails closed on private parts", async () => {
  const fixture = makeFixture()
  try {
    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 50 }),
      cursorSecret,
    )
    const serialized = JSON.stringify(report)
    for (const secret of [
      "sk-proj-12345678901234567890",
      "private.invalid/path",
      "never-export-this",
      "sk-secret-key-12345678901234567890",
      "credential-value",
      "serialized-json-secret",
      "RAW RESPONSE BODY MUST NOT EXPORT",
      "PRIVATE REASONING DO NOT EXPORT",
      "Another private chain of thought",
      "PRIVATE COMPACTION SUMMARY",
      "REPLAY DATA",
      "SYSTEM INSTRUCTIONS MUST NOT EXPORT",
      "unknown part should fail closed",
      "unknown message payload must not export",
      "hidden-after-the-boundary",
      "logged-secret",
      "123456789012345678901234567890",
    ])
      expect(serialized).not.toContain(secret)
    expect(serialized).toContain("[REDACTED]")
    expect(serialized).toContain("[path omitted]")
    expect(report.privacy.redactedValues).toBeGreaterThan(0)
    expect(report.privacy.truncatedValues).toBeGreaterThan(0)
    expect(report.privacy.omittedAttachments).toBeGreaterThan(0)
    expect(report.privacy.omittedReasoning).toBeGreaterThan(0)
    expect(report.privacy.omittedSystemOrSkillMessages).toBeGreaterThan(0)
    expect(report.privacy.omittedUnknownParts).toBeGreaterThan(0)
    expect(report.coverage.compacted).toBe(true)
  } finally {
    fixture.close()
  }
})

test("native tool arguments, JSON results and errors omit nested private state", async () => {
  const fixture = makeFixture()
  try {
    const arrayLimit: unknown[] = Array.from({ length: 45 }, (_, index) => ({ index }))
    arrayLimit[39] = { type: "text", text: "safe array summary retained" }
    arrayLimit[40] = { type: "reasoning", text: "ARRAY_LIMIT_PRIVATE_CANARY" }

    let nestingLimit: unknown = { type: "reasoning", text: "NESTING_LIMIT_PRIVATE_CANARY" }
    for (let index = 0; index < 9; index++) nestingLimit = { child: nestingLimit }

    const fieldLimit = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`field${index}`, index]),
    )
    Object.assign(fieldLimit, { late: "FIELD_LIMIT_PRIVATE_CANARY" })

    const session = fixture.sessions.get("ses-failed")!
    session.messages = [
      ...(session.messages ?? []),
      {
        id: "nested-private-tool",
        type: "assistant",
        time: { created: 1150 },
        content: [
          {
            type: "tool",
            id: "nested-private-call",
            name: "Inspect",
            state: {
              status: "error",
              input: {
                command: "bun test src/trajectory",
                source: "src/trajectory/read.ts",
                summary: "safe argument summary retained",
                arguments: JSON.stringify({
                  visible: "safe nested argument retained",
                  context: {
                    messages: [
                      { type: "reasoning", text: "AUDIT_PRIVATE_INPUT_CANARY" },
                      { type: "system", text: "AUDIT_PRIVATE_SYSTEM_CANARY" },
                      { type: "skill", instructions: "AUDIT_PRIVATE_SKILL_CANARY" },
                    ],
                  },
                  native: { replay: "AUDIT_PRIVATE_NATIVE_CANARY" },
                  attachments: [{ type: "file", data: "AUDIT_PRIVATE_ATTACHMENT_CANARY" }],
                  state: { input: "AUDIT_FULL_INPUT_CANARY" },
                }),
                arrayLimit,
                nestingLimit,
                fieldLimit,
                unsupported: new Map([["private", "UNSUPPORTED_STRUCTURE_PRIVATE_CANARY"]]),
              },
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    summary: "safe JSON result retained",
                    details: [
                      { type: "reasoning", text: "AUDIT_PRIVATE_RESULT_CANARY" },
                      { type: "system", text: "JSON_RESULT_SYSTEM_PRIVATE_CANARY" },
                      { type: "skill", instructions: "JSON_RESULT_SKILL_PRIVATE_CANARY" },
                      {
                        type: "tool",
                        name: "nested-tool",
                        state: { input: "AUDIT_FULL_INPUT_CANARY" },
                      },
                    ],
                  }),
                },
              ],
              error: {
                type: "ToolError",
                message: JSON.stringify({
                  summary: "safe JSON error retained",
                  details: [
                    { kind: "reasoning", text: "AUDIT_PRIVATE_ERROR_CANARY" },
                    { type: "skill", instructions: "JSON_ERROR_SKILL_PRIVATE_CANARY" },
                    { arguments: { state: { input: "AUDIT_FULL_INPUT_CANARY" } } },
                  ],
                }),
                response: { body: "AUDIT_PRIVATE_ERROR_BODY_CANARY" },
              },
            },
            time: { ran: 1151, completed: 1160 },
          },
        ],
      } as never,
    ]

    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 50 }),
      cursorSecret,
    )
    const serialized = JSON.stringify(report)
    for (const canary of [
      "AUDIT_PRIVATE_INPUT_CANARY",
      "AUDIT_PRIVATE_RESULT_CANARY",
      "AUDIT_FULL_INPUT_CANARY",
      "AUDIT_PRIVATE_ERROR_CANARY",
      "AUDIT_PRIVATE_SYSTEM_CANARY",
      "AUDIT_PRIVATE_SKILL_CANARY",
      "AUDIT_PRIVATE_NATIVE_CANARY",
      "AUDIT_PRIVATE_ATTACHMENT_CANARY",
      "JSON_RESULT_SYSTEM_PRIVATE_CANARY",
      "JSON_RESULT_SKILL_PRIVATE_CANARY",
      "JSON_ERROR_SKILL_PRIVATE_CANARY",
      "AUDIT_PRIVATE_ERROR_BODY_CANARY",
      "ARRAY_LIMIT_PRIVATE_CANARY",
      "NESTING_LIMIT_PRIVATE_CANARY",
      "FIELD_LIMIT_PRIVATE_CANARY",
      "UNSUPPORTED_STRUCTURE_PRIVATE_CANARY",
    ])
      expect(serialized).not.toContain(canary)

    const toolEvent = report.trajectory.events.find(
      (event) => event.id === "nested-private-tool:tool:nested-private-call",
    )!
    expect(toolEvent).toMatchObject({ tool: "Inspect", status: "error" })
    expect(JSON.stringify(toolEvent.input)).toContain("bun test src/trajectory")
    expect(JSON.stringify(toolEvent.input)).toContain("src/trajectory/read.ts")
    expect(JSON.stringify(toolEvent.input)).toContain("safe argument summary retained")
    expect(JSON.stringify(toolEvent.input)).toContain("safe nested argument retained")
    expect(JSON.stringify(toolEvent.input)).toContain("safe array summary retained")
    expect(toolEvent.result).toContain("safe JSON result retained")
    expect(toolEvent.error).toMatchObject({ type: "ToolError" })
    expect((toolEvent.error as { message?: string }).message).toContain("safe JSON error retained")
    expect(report.plans[0]?.checks.map((check) => check.result)).toContain("passed")
    expect(report.coverage.transcript).toContain("session.context")
    expect(report.privacy.warnings.join(" ")).toContain("System instructions")
    expect(report.privacy.truncatedValues).toBeGreaterThan(0)
    expect(report.privacy.omittedUnknownParts).toBeGreaterThan(0)
  } finally {
    fixture.close()
  }
})

test("tool multipart JSON and nesting-limit strings omit private reasoning while retaining safe siblings", async () => {
  const fixture = makeFixture()
  try {
    const privateJson = JSON.stringify({
      type: "reasoning",
      text: "REVIEW_PRIVATE_MULTIPART_CANARY",
    })
    const encodedPrivateJson = JSON.stringify(privateJson)
    let depthString: unknown = JSON.stringify({
      type: "reasoning",
      text: "REVIEW_DEPTH_STRING_CANARY",
    })
    for (let index = 0; index < 7; index++) depthString = { child: depthString }

    let belowDepthLimit: unknown = JSON.stringify({
      type: "reasoning",
      text: "REVIEW_DEPTH_BELOW_LIMIT_CANARY",
    })
    for (let index = 0; index < 6; index++) belowDepthLimit = { child: belowDepthLimit }

    const session = fixture.sessions.get("ses-failed")!
    session.messages = [
      ...(session.messages ?? []),
      {
        id: "multipart-private-tool",
        type: "assistant",
        time: { created: 1170 },
        content: [
          {
            type: "tool",
            id: "multipart-private-call",
            name: "Inspect",
            state: {
              status: "completed",
              input: {
                command: "bun test src/trajectory/read.test.ts",
                source: "src/trajectory/read.ts",
                summary: "safe argument summary retained",
                depthString,
                belowDepthLimit,
              },
              content: [
                { type: "text", text: "safe multipart prose retained" },
                { type: "text", text: privateJson },
                {
                  type: "text",
                  text: JSON.stringify({
                    summary: "safe multipart JSON summary retained",
                    details: [{ type: "reasoning", text: "REVIEW_PRIVATE_MULTIPART_CANARY" }],
                  }),
                },
                { type: "text", text: encodedPrivateJson },
                { type: "text", text: "Code: bun test src/trajectory/read.test.ts" },
              ],
            },
            time: { ran: 1171, completed: 1180 },
          },
        ],
      } as never,
    ]

    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 50 }),
      cursorSecret,
    )
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain("REVIEW_PRIVATE_MULTIPART_CANARY")
    expect(serialized).not.toContain("REVIEW_DEPTH_STRING_CANARY")
    expect(serialized).not.toContain("REVIEW_DEPTH_BELOW_LIMIT_CANARY")

    const toolEvent = report.trajectory.events.find(
      (event) => event.id === "multipart-private-tool:tool:multipart-private-call",
    )!
    expect(toolEvent).toMatchObject({ tool: "Inspect", status: "completed" })
    expect(JSON.stringify(toolEvent.input)).toContain("bun test src/trajectory/read.test.ts")
    expect(JSON.stringify(toolEvent.input)).toContain("src/trajectory/read.ts")
    expect(JSON.stringify(toolEvent.input)).toContain("safe argument summary retained")
    expect(toolEvent.result).toContain("safe multipart prose retained")
    expect(toolEvent.result).toContain("safe multipart JSON summary retained")
    expect(toolEvent.result).toContain("Code: bun test src/trajectory/read.test.ts")
    expect(report.privacy.omittedReasoning).toBeGreaterThan(0)
  } finally {
    fixture.close()
  }
})

test("attempt lookup rejects foreign IDs and session identity mismatches without exporting data", async () => {
  const fixture = makeFixture()
  try {
    const foreignTask = fixture.repository.insert({
      ...fixture.task,
      id: crypto.randomUUID(),
      provenance: { ...fixture.task.provenance, projectID: "foreign-project" },
    })
    await expect(
      inspectTrajectory(
        fixture.store,
        fixture.host,
        "project",
        parse({ taskID: foreignTask.id }),
        cursorSecret,
      ),
    ).rejects.toThrow("Task is not owned by this project")

    let sessionReads = 0
    const countingHost = {
      session: async (id: string) => {
        sessionReads++
        return fixture.host.session(id)
      },
    }
    await expect(
      inspectTrajectory(
        fixture.store,
        countingHost,
        "project",
        parse({ attemptID: crypto.randomUUID() }),
        cursorSecret,
      ),
    ).rejects.toThrow("No project-owned attempt")
    expect(sessionReads).toBe(0)

    const foreignHost = {
      session: async (id: string) => {
        const session = await fixture.host.session(id)
        return session ? { ...session, projectID: "foreign-project" } : null
      },
    }
    await expect(
      inspectTrajectory(fixture.store, foreignHost, "project", parse({ taskID }), cursorSecret),
    ).rejects.toThrow("outside this project")
  } finally {
    fixture.close()
  }
})

test("continuation cursors are bound to the project-owned source snapshot", async () => {
  const fixture = makeFixture()
  const otherProject = makeFixture()
  try {
    const first = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      parse({ taskID, limit: 2 }),
      cursorSecret,
    )
    expect(first.trajectory.nextCursor).not.toBeNull()

    await expect(
      inspectTrajectory(
        otherProject.store,
        otherProject.host,
        "project",
        parse({ taskID, limit: 2, cursor: first.trajectory.nextCursor! }),
        cursorSecret,
      ),
    ).rejects.toThrow("Stale trajectory cursor")
  } finally {
    fixture.close()
    otherProject.close()
  }
})

test("native session errors are redacted before appearing in the report", async () => {
  const fixture = makeFixture()
  try {
    const host = {
      session: async () => {
        throw new Error(JSON.stringify({ authorization: "error-secret-value", visible: true }))
      },
    }
    const report = await inspectTrajectory(
      fixture.store,
      host,
      "project",
      parse({ taskID }),
      cursorSecret,
    )
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain("error-secret-value")
    expect(serialized).toContain("[REDACTED]")
    expect(report.effort.tokenUsage.total).toBeNull()
    expect(report.effort.tokenUsage.unknownAttempts).toHaveLength(2)
  } finally {
    fixture.close()
  }
})

test("trajectory reads do not create audits or change tasks, attempts, transitions, or watermarks", async () => {
  const fixture = makeFixture()
  try {
    const before = fixture.repository.atomic((db) => ({
      taskChanges: fixture.repository.version(),
      tasks: db.query<{ count: number }, []>("SELECT count(*) AS count FROM tasks").get()!.count,
      attempts: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_attempts")
        .get()!.count,
      transitions: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_transitions")
        .get()!.count,
      effects: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_effects")
        .get()!.count,
      audits: db.query<{ count: number }, []>("SELECT count(*) AS count FROM runner_audits").get()!
        .count,
    }))
    const oldAudit = fixture.store.audit.bind(fixture.store)
    fixture.store.audit = () => {
      throw new Error("audit must not run during a trajectory read")
    }
    await inspectTrajectory(fixture.store, fixture.host, "project", parse({ taskID }), cursorSecret)
    fixture.store.audit = oldAudit
    const after = fixture.repository.atomic((db) => ({
      taskChanges: fixture.repository.version(),
      tasks: db.query<{ count: number }, []>("SELECT count(*) AS count FROM tasks").get()!.count,
      attempts: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_attempts")
        .get()!.count,
      transitions: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_transitions")
        .get()!.count,
      effects: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_effects")
        .get()!.count,
      audits: db.query<{ count: number }, []>("SELECT count(*) AS count FROM runner_audits").get()!
        .count,
    }))
    expect(after).toEqual(before)
  } finally {
    fixture.close()
  }
})
