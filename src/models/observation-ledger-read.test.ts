import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { openReadOnlyObservationLedger } from "./observation-ledger-read.ts"
import type { ObservationLedgerOutput } from "./observation-ledger-schema.ts"
import {
  makeLedgerFixture,
  makeLegacyTask,
} from "../../test/models-observation-ledger/fixtures/ledger.ts"

const CAPTURE_TABLES = [
  "tasks",
  "task_references",
  "task_classifications",
  "task_dispositions",
  "runner_plans",
  "runner_nodes",
  "runner_attempts",
  "runner_transitions",
  "runner_adoptions",
  "runner_progress",
]

function databaseFingerprint(path: string) {
  const db = new Database(path, { readonly: true, strict: true })
  try {
    const schema = db
      .query<{ type: string; name: string; sql: string | null }, []>(
        "SELECT type,name,sql FROM sqlite_master ORDER BY type,name",
      )
      .all()
    const existingTables = new Set(
      schema.filter((item) => item.type === "table").map((item) => item.name),
    )
    const data = CAPTURE_TABLES.map((table) =>
      existingTables.has(table)
        ? db.query<Record<string, unknown>, []>(`SELECT * FROM ${table} ORDER BY rowid`).all()
        : null,
    )
    return createHash("sha256").update(JSON.stringify({ schema, data })).digest("hex")
  } finally {
    db.close()
  }
}

function task(output: ObservationLedgerOutput, taskID: string) {
  const found = output.tasks.find((candidate) => candidate.taskID === taskID)
  assert.ok(found, `Task ${taskID} is present in the observation ledger`)
  return found
}

test("read-only ledger retains failed/retried work, genuine artifact acceptance, and explicit classification", () => {
  const fixture = makeLedgerFixture()
  const before = databaseFingerprint(fixture.path)
  const reader = openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory, {
    cursorSecret: fixture.cursorSecret,
  })
  try {
    const output = reader.read({ limit: 100 })
    const retry = task(output, fixture.tasks.retry!.id)
    expect(output.status).toBe("partial")
    expect(output.completeness.status).toBe("partial")
    expect(output.pin?.completeness).toBe("partial")
    expect(retry).toMatchObject({
      submittedStatus: "submitted",
      classification: {
        catalog: "task-kind/v1",
        kind: "feature-implementation",
        revision: 1,
        status: "available",
        provenance: { kind: "embedded", sessionID: "ses-ledger-owner" },
      },
      logicalOutcome: {
        accepted: true,
        acceptedAt: 400,
        acceptedTaskCount: 1,
        evidence: [
          {
            kind: "accept",
            transitionID: expect.any(Number),
            artifactEventID: expect.any(Number),
            attemptID: fixture.attempts.accepted.id,
            artifact: "b".repeat(40),
            acceptedAt: 400,
          },
        ],
      },
      attempts: [
        { id: fixture.attempts.failed.id, state: "failed", legacyTokenCount: 999 },
        { id: fixture.attempts.accepted.id, state: "accepted", legacyTokenCount: 888 },
      ],
    })
    expect(retry.attempts[0]?.persona).toEqual({
      requested: "systems",
      frozen: "ui",
      status: "mismatch",
    })
    expect(retry.attempts[1]?.requestedRoute).toMatchObject({
      route: { providerID: "openai", modelID: "requested-model", variant: "high" },
      status: "explicit",
    })
    expect(retry.attempts[1]?.frozenRoute).toMatchObject({
      route: { providerID: "anthropic", modelID: "frozen-model", variant: "max" },
      status: "recorded",
    })
    expect(retry.attempts[1]?.observedRoutes).toMatchObject({
      status: "single-route",
      route: { providerID: "openrouter", modelID: "observed-model", variant: "medium" },
    })
    expect(retry.usage.categories.uncachedInput).toMatchObject({
      value: 150,
      status: "partial",
      basis: "mixed",
      valueScope: "observed-subtotal",
    })
    expect(retry.usage.categories.output).toMatchObject({ value: 0, status: "partial" })
    expect(retry.usage.categories.reasoning).toMatchObject({ value: null, status: "missing" })
    expect(retry.usage.totalTokens).toMatchObject({
      value: 150,
      observedSubtotal: 150,
      status: "partial",
      basis: "sum-of-categorized-session-usage; legacy attempt scalars are not added",
    })
    expect(retry.usage.totalTokens.value).not.toBe(999 + 888 + 150)

    const adopted = task(output, fixture.tasks.adoption!.id)
    expect(adopted.attempts[0]?.state).toBe("failed")
    expect(adopted.logicalOutcome).toMatchObject({
      accepted: true,
      acceptedAt: 700,
      acceptedTaskCount: 1,
      evidence: [
        {
          kind: "adopt-accept",
          adoptionID: "adoption-ledger-record",
          attemptID: fixture.attempts.adoption.id,
          artifact: "c".repeat(40),
          acceptedAt: 700,
        },
      ],
    })
    expect(adopted.adoptions).toMatchObject([
      {
        id: "adoption-ledger-record",
        attemptID: fixture.attempts.adoption.id,
        state: "accepted",
        attemptState: "failed",
      },
    ])

    const incorporated = task(output, fixture.tasks.incorporated!.id)
    expect(incorporated.executions[0]?.planState).toBe("integrated")
    expect(incorporated.logicalOutcome).toMatchObject({
      accepted: false,
      acceptedAt: null,
      acceptedTaskCount: 0,
      evidence: [],
    })
    expect(incorporated.dispositions).toMatchObject([
      { disposition: "fulfilled", reason: expect.stringContaining("independently") },
    ])

    const legacy = task(output, fixture.tasks.legacy!.id)
    expect(legacy.classification).toMatchObject({
      catalog: "task-kind/v1",
      kind: null,
      revision: 0,
      provenance: { kind: "legacy" },
      status: "available",
    })
    expect(output.classificationCoverage).toMatchObject({
      classifiedTaskCount: 5,
      unclassifiedTaskCount: 1,
      unavailableTaskCount: 0,
      totalTaskCount: 6,
    })

    const serialized = JSON.stringify(output)
    expect(serialized).not.toContain("PRIVATE PROMPT MUST NOT LEAVE THE DATABASE")
    expect(serialized).not.toContain("Private task objective")
    expect(serialized).not.toContain("Private plan objective")
    expect(databaseFingerprint(fixture.path)).toBe(before)
  } finally {
    reader.close()
    fixture.close()
  }
})

test("shared sessions are captured once, never allocated to tasks, and route occurrences retain identity and omissions", () => {
  const fixture = makeLedgerFixture()
  const reader = openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory, {
    cursorSecret: fixture.cursorSecret,
  })
  try {
    const output = reader.read({ limit: 100 })
    const first = task(output, fixture.tasks.sharedFeature!.id)
    const second = task(output, fixture.tasks.sharedTesting!.id)
    const session = output.sessionContributions.find(
      (item) => item.sessionID === "ses-shared-session",
    )
    assert.ok(session)

    expect(first.usage.totalTokens).toMatchObject({
      value: null,
      status: "ambiguous",
      unallocatedSessionIDs: ["ses-shared-session"],
    })
    expect(second.usage.totalTokens).toMatchObject({
      value: null,
      status: "ambiguous",
      unallocatedSessionIDs: ["ses-shared-session"],
    })
    expect([...session.taskIDs].sort()).toEqual(
      [fixture.tasks.sharedFeature!.id, fixture.tasks.sharedTesting!.id].sort(),
    )
    expect(session).toMatchObject({
      attemptIDs: [fixture.attempts.sharedFeature.id, fixture.attempts.sharedTesting.id],
      allocation: "ambiguous-shared-logical-tasks",
      categories: { uncachedInput: { value: 70 } },
      totalTokens: { value: 70, status: "observed" },
    })

    const fact = first.progressFacts.find((item) => item.observationCoverage === "truncated")
    assert.ok(fact)
    expect(fact).toMatchObject({ observationCoverage: "truncated", omittedObservationCount: 2 })
    expect(fact.observations[0]).toMatchObject({ routeStatus: "unavailable", route: null })
    expect(fact.observations).toHaveLength(25)
    expect(new Set(fact.observations.map((item) => item.occurrenceID)).size).toBe(25)
    expect(fact.observations.every((item) => item.observedAt === null)).toBe(true)
    expect(fact.observations.every((item) => item.eventID === null)).toBe(true)

    const attempt = first.attempts.find((item) => item.id === fixture.attempts.sharedFeature.id)
    assert.ok(attempt)
    expect(attempt.observedRoutes).toMatchObject({
      status: "mixed-routes",
      route: null,
      coverage: "truncated",
      omittedOccurrenceCount: 2,
      attribution: "incomplete-truncated-route-observations",
    })
    expect(new Set(attempt.observedRoutes.occurrences.map((item) => item.occurrenceID)).size).toBe(
      attempt.observedRoutes.occurrences.length,
    )
    const indistinguishable = attempt.observedRoutes.occurrences.filter(
      (item) => item.identityStatus === "unavailable",
    )
    expect(indistinguishable).toHaveLength(2)
    expect(indistinguishable[0]?.occurrenceID).not.toBe(indistinguishable[1]?.occurrenceID)
    expect(indistinguishable.every((item) => item.route === null)).toBe(true)

    const featureOnly = reader.read({ taskKind: "feature-implementation", limit: 100 })
    const sharedInFeatureOnly = featureOnly.sessionContributions.find(
      (item) => item.sessionID === "ses-shared-session",
    )
    expect([...sharedInFeatureOnly!.taskIDs].sort()).toEqual(
      [fixture.tasks.sharedFeature!.id, fixture.tasks.sharedTesting!.id].sort(),
    )
    expect(featureOnly.tasks.some((item) => item.taskID === fixture.tasks.sharedTesting!.id)).toBe(
      false,
    )
  } finally {
    reader.close()
    fixture.close()
  }
})

test("all pages share one complete capture pin and reject tampered, foreign, mismatched, and stale cursors", () => {
  const fixture = makeLedgerFixture()
  const reader = openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory, {
    cursorSecret: fixture.cursorSecret,
  })
  try {
    const pages: ObservationLedgerOutput[] = []
    let page = reader.read({ limit: 1 })
    pages.push(page)
    const firstCursor = page.nextCursor
    assert.ok(firstCursor)
    while (page.nextCursor) {
      page = reader.read({ limit: 1, cursor: page.nextCursor })
      pages.push(page)
    }
    expect(pages).toHaveLength(6)
    expect(new Set(pages.map((item) => item.pin?.snapshotID)).size).toBe(1)
    expect(new Set(pages.map((item) => item.pin?.sourceFingerprint)).size).toBe(1)
    expect(new Set(pages.map((item) => item.pin?.capturedAt)).size).toBe(1)
    expect(pages.every((item) => item.completeness.status === "partial")).toBe(true)
    expect(
      pages
        .flatMap((item) => item.sessionContributions)
        .filter((item) => item.sessionID === "ses-shared-session"),
    ).toHaveLength(1)

    const first = pages[0]!
    const token = first.nextCursor!
    const changedLast = token.endsWith("A") ? "B" : "A"
    expect(() => reader.read({ limit: 1, cursor: `${token.slice(0, -1)}${changedLast}` })).toThrow(
      /cursor is invalid or tampered/,
    )
    expect(() => reader.read({ taskKind: "testing", limit: 1, cursor: token })).toThrow(
      /task-kind filter does not match/,
    )

    const foreign = openReadOnlyObservationLedger(
      fixture.path,
      `${fixture.projectDirectory}-foreign`,
      {
        cursorSecret: fixture.cursorSecret,
      },
    )
    try {
      expect(() => foreign.read({ limit: 1, cursor: token })).toThrow(/scope does not match/)
    } finally {
      foreign.close()
    }

    const beforeCorrection = pages[0]!.tasks[0]
    const sharedTestingBefore = reader
      .read({ limit: 100 })
      .tasks.find((item) => item.taskID === fixture.tasks.sharedTesting!.id)
    assert.ok(sharedTestingBefore)
    fixture.addClassification(fixture.tasks.sharedTesting!.id, 1, "documentation")
    expect(() => reader.read({ limit: 1, cursor: token })).toThrow(/cursor is stale/)

    const oldTestingCohort = reader.read({ taskKind: "testing", limit: 100 })
    const newDocumentationCohort = reader.read({ taskKind: "documentation", limit: 100 })
    expect(
      oldTestingCohort.tasks.some((item) => item.taskID === fixture.tasks.sharedTesting!.id),
    ).toBe(false)
    const corrected = task(newDocumentationCohort, fixture.tasks.sharedTesting!.id)
    expect(corrected.classification).toMatchObject({
      kind: "documentation",
      revision: 2,
      provenance: {
        kind: "annotation",
        requestID: expect.stringContaining("ledger-classification"),
      },
    })
    expect(corrected.attempts.map((item) => item.id)).toEqual(
      sharedTestingBefore.attempts.map((item) => item.id),
    )
    expect(corrected.usage).toEqual(sharedTestingBefore.usage)
    expect(corrected.taskID).toBe(fixture.tasks.sharedTesting!.id)
    expect(newDocumentationCohort.pin?.snapshotID).not.toBe(pages[0]?.pin?.snapshotID)
    expect(newDocumentationCohort.pin?.sourceFingerprint).not.toBe(pages[0]?.pin?.sourceFingerprint)
    expect(beforeCorrection?.taskID).toBe(fixture.tasks.retry!.id)
  } finally {
    reader.close()
    fixture.close()
  }
})

test("missing and legacy databases are reported read-only without creating or migrating schema", () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-observation-ledger-legacy-"))
  const missingPath = join(directory, "missing.sqlite")
  const missing = openReadOnlyObservationLedger(missingPath, directory)
  try {
    expect(missing.read()).toMatchObject({
      status: "unavailable",
      unavailableReason: "database-missing",
      pin: null,
    })
    expect(existsSync(missingPath)).toBe(false)
  } finally {
    missing.close()
  }

  const legacyPath = join(directory, "legacy.sqlite")
  const legacyTask = makeLegacyTask(directory)
  const legacyDB = new Database(legacyPath)
  legacyDB.exec(
    "CREATE TABLE tasks(id TEXT PRIMARY KEY,project_directory TEXT NOT NULL,created_at TEXT NOT NULL,body TEXT NOT NULL)",
  )
  legacyDB
    .query("INSERT INTO tasks(id,project_directory,created_at,body) VALUES(?,?,?,?)")
    .run(legacyTask.id, directory, legacyTask.createdAt, JSON.stringify(legacyTask))
  legacyDB.close()
  const legacySchemaBefore = databaseFingerprint(legacyPath)
  const legacyReader = openReadOnlyObservationLedger(legacyPath, directory)
  try {
    const output = legacyReader.read()
    expect(output.status).toBe("partial")
    expect(output.unavailableReason).toBeNull()
    expect(output.classificationCoverage).toMatchObject({
      classifiedTaskCount: 0,
      unclassifiedTaskCount: 1,
      unavailableTaskCount: 0,
      totalTaskCount: 1,
    })
    expect(output.tasks[0]?.classification).toMatchObject({
      kind: null,
      revision: 0,
      provenance: { kind: "legacy" },
      status: "available",
    })
    expect(output.completeness.sources).toContainEqual({
      name: "task_references",
      status: "legacy-absent",
      missingColumns: ["project_directory", "task_id", "reference"],
    })
    expect(databaseFingerprint(legacyPath)).toBe(legacySchemaBefore)
  } finally {
    legacyReader.close()
  }

  const emptyPath = join(directory, "empty.sqlite")
  const empty = new Database(emptyPath)
  empty.exec("CREATE TABLE unrelated(value TEXT)")
  empty.close()
  const emptyBefore = databaseFingerprint(emptyPath)
  const emptyReader = openReadOnlyObservationLedger(emptyPath, directory)
  try {
    expect(emptyReader.read()).toMatchObject({
      status: "unavailable",
      unavailableReason: "task-table-missing",
      pin: null,
    })
    expect(databaseFingerprint(emptyPath)).toBe(emptyBefore)
  } finally {
    emptyReader.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
