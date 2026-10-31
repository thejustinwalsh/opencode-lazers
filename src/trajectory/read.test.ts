import { expect, test } from "bun:test"
import { inspectTrajectory } from "./read.ts"
import { InspectTrajectoryInput } from "./schema.ts"
import { makeFixture, cursorSecret, taskID, firstAttemptID } from "../../test/trajectory/fixture.ts"

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
