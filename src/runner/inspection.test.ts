import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { fingerprint } from "../identity.ts"
import { TaskRepository } from "../storage.ts"
import type { RetainedVerification } from "./retained-verification/schema.ts"
import {
  createRetainedVerification,
  ensureRetainedVerificationTables,
} from "./retained-verification/store.ts"
import {
  InspectPlanInput,
  type CompactInspectionSummary,
  type CompactPlanDetail,
  inspectPlan,
} from "./inspection.ts"
import { RunnerStore } from "./store.ts"

const directories: string[] = []
const repositories: TaskRepository[] = []

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-inspection-"))
  directories.push(directory)
  const projectDirectory = join(directory, "project")
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), projectDirectory)
  repositories.push(repository)
  const first = repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "project",
      projectDirectory,
      workspaceDirectory: projectDirectory,
      sessionID: "owner",
      startingRevision: { kind: "unborn" },
    },
    proposal: validProposal(),
  })
  const second = repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "project",
      projectDirectory,
      workspaceDirectory: projectDirectory,
      sessionID: "owner",
      startingRevision: { kind: "unborn" },
    },
    proposal: validProposal(),
  })
  const prerequisite = repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "project",
      projectDirectory,
      workspaceDirectory: projectDirectory,
      sessionID: "owner",
      startingRevision: { kind: "unborn" },
    },
    proposal: validProposal(),
  })
  const store = new RunnerStore(repository)
  const input = {
    requestID: "compact-inspection",
    title: "Compact runner view",
    objective: "Show scheduling state without replaying logs",
    priority: 4,
    baseCommit: "b".repeat(40),
    workspaceMode: "isolated" as const,
    nodes: [
      { taskID: first.id, revision: 1 as const },
      { taskID: second.id, revision: 1 as const },
    ],
    dependencies: [{ prerequisite: first.id, successor: second.id }],
    integrationOrder: [first.id, second.id],
    verification: first.proposal.verification,
    acceptance: first.proposal.acceptance,
  }
  return { projectDirectory, repository, store, input, first, second, prerequisite }
}

function retainedOperation(
  projectDirectory: string,
  planID: string,
  taskID: string,
  sequence: number,
  state: RetainedVerification["state"],
  overrides: Partial<RetainedVerification> = {},
): RetainedVerification {
  const now = 1_700_000_000_000 + sequence
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    projectID: "project",
    projectDirectory,
    planID,
    planRevision: 1,
    owner: "owner",
    taskID,
    taskRevision: 1,
    attemptID: crypto.randomUUID(),
    originalSessionID: "ses_private_canary",
    originalMessageID: "msg_private_canary",
    originalWorkspace: "/private/retained-verification-workspace-canary",
    artifact: "a".repeat(40),
    taskWorkspace: null,
    taskWorkspaceState: null,
    environmentIdentity: JSON.stringify({ PATH: "/private/ENVIRONMENT_CANARY" }),
    reason: "PRIVATE_REASON_CANARY",
    state,
    failureReason: "PRIVATE_HOLD_REASON_CANARY",
    cleanupState: "complete",
    createdAt: now,
    updatedAt: now + 100,
    ...overrides,
  }
}

function insertCheck(
  f: ReturnType<typeof fixture>,
  operation: RetainedVerification,
  input: {
    exitCode: number | null
    stdout: string
    stderr?: string
    timedOut?: boolean
    stopCause?: "inactivity" | "hard-backstop" | "cancelled" | null
    verificationDeadline?: Record<string, unknown>
  },
) {
  const environmentIdentity = JSON.stringify({ PATH: "/private/CHECK_ENVIRONMENT_CANARY" })
  f.store.atomic((db) => {
    db.query(
      `INSERT INTO runner_retained_verification_checks(
        operation_id,phase,check_id,check_json,workspace,artifact,input_fingerprint,
        environment_identity,receipt_path,state,receipt,context_path,cleanup_state,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'completed',?,?,?,?)`,
    ).run(
      operation.id,
      "task",
      "tests",
      JSON.stringify({ id: "tests", command: "PRIVATE_COMMAND_CANARY" }),
      "/private/check-workspace-canary",
      operation.artifact,
      fingerprint("check-input"),
      environmentIdentity,
      "/private/receipt-path-canary",
      JSON.stringify({
        id: "tests",
        command: "PRIVATE_COMMAND_CANARY",
        cwd: "/private/check-workspace-canary",
        artifact: operation.artifact,
        inputIdentity: operation.artifact,
        environmentIdentity,
        startedAt: 1_700_000_001_000,
        endedAt: 1_700_000_002_000,
        exitCode: input.exitCode,
        timedOut: input.timedOut ?? false,
        stopCause: input.stopCause ?? null,
        ...(input.verificationDeadline === undefined
          ? {}
          : { verificationDeadline: input.verificationDeadline }),
        stdout: input.stdout,
        stderr: input.stderr ?? "PRIVATE_STDERR_CANARY",
      }),
      "/private/check-context-canary",
      "failed",
      1_700_000_000_500,
    )
  })
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test("compact inspection keeps scheduling signal without serializing logs", () => {
  const f = fixture()
  const prerequisite = f.store.submit(
    {
      ...f.input,
      requestID: "compact-inspection-prerequisite",
      nodes: [{ taskID: f.prerequisite.id, revision: 1 as const }],
      dependencies: [],
      integrationOrder: [f.prerequisite.id],
    },
    "owner",
  )
  const receipt = f.store.submit({ ...f.input, afterPlans: [prerequisite.planID] }, "owner")
  f.store.move(receipt.planID, f.first.id, "READY")
  f.store.move(receipt.planID, f.first.id, "DISPATCH")
  f.store.atomic((db) => {
    db.query("UPDATE runner_plans SET state='running',model=? WHERE id=?").run(
      JSON.stringify({ providerID: "openai", id: "luna" }),
      receipt.planID,
    )
    db.query(
      "INSERT INTO runner_attempts(id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at,tool_count,retry_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "attempt-1",
      receipt.planID,
      f.first.id,
      1,
      "session-1",
      "message-1",
      f.projectDirectory,
      "b".repeat(40),
      JSON.stringify({ canary: "FULL_POLICY_CANARY" }),
      "running",
      Date.now(),
      3,
      1,
    )
    db.query(
      "INSERT INTO runner_effects(id,plan_id,task_id,attempt_id,kind,state,payload,receipt,fence) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      "effect-1",
      receipt.planID,
      f.first.id,
      "attempt-1",
      "verify:tests",
      "completed",
      JSON.stringify({ canary: "FULL_EFFECT_PAYLOAD_CANARY" }),
      JSON.stringify({
        check: { exitCode: 1, timedOut: false, unchanged: true, stdout: "FULL_STDOUT_CANARY" },
      }),
      1,
    )
    db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      receipt.planID,
      f.first.id,
      3,
      "FAIL",
      JSON.stringify({
        outcome: "failed",
        reason: "visible reason",
        canary: "FULL_TRANSITION_CANARY",
      }),
      Date.now(),
    )
  })

  const compact = inspectPlan(f.store, { planID: receipt.planID, full: false }) as CompactPlanDetail
  const compactText = JSON.stringify(compact)
  expect(compact.plan.title).toBe(f.input.title)
  expect(compact.plan.objective).toBe(f.input.objective)
  expect(compact.plan.state).toBe("running")
  expect(compact.plan.schedule.priority).toBe(4)
  expect(compact.plan.schedule.workspaceMode).toBe("isolated")
  expect(compact.waitingOnPlans).toEqual([
    {
      planID: prerequisite.planID,
      state: "draft",
      version: 1,
      reason: null,
    },
  ])
  const secondNode = compact.nodes.find((node) => node.taskID === f.second.id)
  const firstNode = compact.nodes.find((node) => node.taskID === f.first.id)
  expect(secondNode?.waitingOn).toEqual([f.first.id])
  expect(firstNode?.latestAttempt).toMatchObject({
    id: "attempt-1",
    toolCount: 3,
    retryCount: 1,
  })
  expect(compact.latestOutcomes).toContainEqual(
    expect.objectContaining({ taskID: f.first.id, outcome: "failed", reason: "visible reason" }),
  )
  expect(compact.checks).toContainEqual(
    expect.objectContaining({
      kind: "verify:tests",
      exitCode: 1,
      timedOut: false,
      unchanged: true,
    }),
  )
  expect(compactText).not.toContain("FULL_POLICY_CANARY")
  expect(compactText).not.toContain("FULL_EFFECT_PAYLOAD_CANARY")
  expect(compactText).not.toContain("FULL_STDOUT_CANARY")
  expect(compactText).not.toContain("FULL_TRANSITION_CANARY")

  const all = inspectPlan(f.store, { full: false }) as CompactInspectionSummary
  expect(all.mode).toBe("compact")
  expect(all.plans).toHaveLength(2)
  expect(all.plans.find((plan) => plan.id === receipt.planID)?.waitingOnPlans).toEqual([
    {
      planID: prerequisite.planID,
      state: "draft",
      version: 1,
      reason: null,
    },
  ])
  expect(JSON.stringify(all)).not.toContain("FULL_POLICY_CANARY")

  const full = inspectPlan(f.store, { planID: receipt.planID, full: true })
  expect(JSON.stringify(full)).toContain("FULL_POLICY_CANARY")
  expect(JSON.stringify(full)).toContain("FULL_STDOUT_CANARY")
})

test("selected full detail does not run the project audit; explicit project inspection retains it", () => {
  const f = fixture()
  const receipt = f.store.submit(f.input, "owner")
  let audits = 0
  const audit = f.store.audit.bind(f.store)
  f.store.audit = () => {
    audits++
    return audit()
  }
  const detail = inspectPlan(f.store, { planID: receipt.planID, full: true })
  expect(detail).toHaveProperty("plan.id", receipt.planID)
  expect(detail).not.toHaveProperty("audit")
  expect(audits).toBe(0)
  const project = inspectPlan(f.store, { full: true })
  expect(project).toHaveProperty("audit.findings")
  expect(audits).toBe(1)
})

test("journal is an explicitly selected bounded view and leaves compact/full inputs compatible", () => {
  const planID = crypto.randomUUID()
  const parsed = InspectPlanInput.parse({ planID, view: "journal" })
  expect(parsed).toEqual({ planID, view: "journal", limit: 50 })
  // The paged retained-history view went with retained generations.
  expect(() => InspectPlanInput.parse({ planID, view: "retained-verifications" })).toThrow()
  expect(InspectPlanInput.parse({ planID, full: true })).toEqual({ planID, full: true })
  expect(InspectPlanInput.parse({ planID })).toEqual({ planID, full: false })
  expect(() => InspectPlanInput.parse({ view: "journal" })).toThrow()
  expect(() => InspectPlanInput.parse({ planID, view: "journal", limit: 0 })).toThrow()
  expect(() => InspectPlanInput.parse({ planID, view: "journal", limit: 1.5 })).toThrow()
  expect(() => InspectPlanInput.parse({ planID, cursor: "x" })).toThrow()
  expect(() => InspectPlanInput.parse({ planID, view: "journal", full: true })).toThrow()
  expect(() =>
    InspectPlanInput.parse({
      planID,
      view: "retained-verifications",
      taskIDs: [planID, planID],
    }),
  ).toThrow()

  const calls: unknown[][] = []
  const store = {
    architectSourceJournalPage: (...args: unknown[]) => {
      calls.push(args)
      return { mode: "journal", planID, records: [] }
    },
  } as unknown as RunnerStore
  expect(inspectPlan(store, parsed)).toMatchObject({ mode: "journal", planID })
  expect(calls).toEqual([[planID, 50, undefined]])
})

test("selected full inspection projects the latest retained call per task without private check data", () => {
  const f = fixture()
  const fourth = f.repository.insert({ ...f.first, id: crypto.randomUUID() })
  const plan = f.store.submit(
    {
      ...f.input,
      requestID: "retained-inspection",
      nodes: [
        { taskID: f.first.id, revision: 1 as const },
        { taskID: f.second.id, revision: 1 as const },
        { taskID: f.prerequisite.id, revision: 1 as const },
        { taskID: fourth.id, revision: 1 as const },
      ],
      dependencies: [],
      integrationOrder: [f.first.id, f.second.id, f.prerequisite.id, fourth.id],
    },
    "owner",
  )
  f.store.atomic(ensureRetainedVerificationTables)
  f.store.atomic((db) =>
    createRetainedVerification(
      db,
      f.projectDirectory,
      retainedOperation(f.projectDirectory, plan.planID, f.first.id, 1, "failed"),
    ),
  )
  const accepted = f.store.atomic((db) =>
    createRetainedVerification(
      db,
      f.projectDirectory,
      retainedOperation(f.projectDirectory, plan.planID, f.first.id, 2, "accepted", {
        cleanupState: "failed",
        taskWorkspace: "/private/TASK_WORKSPACE_CANARY",
        taskWorkspaceState: "uncertain",
      }),
    ),
  )
  const queued = retainedOperation(f.projectDirectory, plan.planID, f.second.id, 1, "pending")
  const failed = retainedOperation(f.projectDirectory, plan.planID, f.prerequisite.id, 1, "failed")
  const cancelled = retainedOperation(f.projectDirectory, plan.planID, fourth.id, 1, "cancelled")
  for (const operation of [queued, failed, cancelled])
    f.store.atomic((db) => createRetainedVerification(db, f.projectDirectory, operation))
  insertCheck(f, failed, {
    exitCode: 1,
    timedOut: true,
    stopCause: "hard-backstop",
    stdout: "PRIVATE_STDOUT_CANARY\n[output truncated]",
    verificationDeadline: {
      timingPolicyVersion: 2,
      authoredTimeoutMs: null,
      authoredInactivityTimeoutMs: 2_000,
      authoredHardTimeoutMs: 5_000,
      defaultInactivityTimeoutMs: 900_000,
      defaultHardTimeoutMs: 3_600_000,
      effectiveInactivityTimeoutMs: 2_000,
      effectiveHardTimeoutMs: 5_000,
      effectiveTimeoutMs: 5_000,
      amendmentID: null,
      policyRevision: 0,
      inactivityProvenance: "per-check",
      hardTimeoutProvenance: "per-check",
      historicalAmendmentIDs: ["old-amendment"],
    },
  })
  f.store.atomic((db) => {
    db.query(
      `INSERT INTO runner_retained_verification_resources(
        project_directory,operation_id,phase,check_id,resource_name,canonical_path,
        device,inode,state,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,'uncertain',?,?)`,
    ).run(
      f.projectDirectory,
      accepted.id,
      "task",
      "tests",
      "PRIVATE_RESOURCE_NAME_CANARY",
      "/private/RESOURCE_PATH_CANARY",
      1,
      2,
      1_700_000_003_000,
      1_700_000_004_000,
    )
  })

  const detail = inspectPlan(f.store, { planID: plan.planID, full: true }) as {
    retainedVerifications: {
      latest: Array<{
        taskID: string
        attemptID: string | null
        candidateArtifact: string | null
        state: string
        nextSteps: Array<Record<string, unknown>>
        checks: Array<{
          phase: string | null
          result: {
            status: string
            exitCode: number | null
            startedAt: number | null
            endedAt: number | null
            output: string
          }
          cleanupState: string
        }>
        cleanup: {
          state: string
          completedAt: number | null
          resourcesByState: { uncertain: number }
        }
      }>
    }
  }
  const latest = detail.retainedVerifications.latest
  expect(latest.map((operation) => operation.state).sort()).toEqual(
    ["accepted", "cancelled", "failed", "pending"].sort(),
  )
  expect(latest.find((operation) => operation.taskID === f.first.id)).toMatchObject({
    attemptID: accepted.attemptID,
    candidateArtifact: accepted.artifact,
    state: "accepted",
    cleanup: {
      state: "failed",
      workspaceStates: { task: "uncertain" },
      completedAt: null,
      resourcesByState: { uncertain: 1 },
    },
  })
  expect(latest.find((operation) => operation.taskID === f.second.id)?.checks).toEqual([])
  expect(latest.find((operation) => operation.taskID === f.second.id)?.nextSteps).toEqual([
    expect.objectContaining({ action: "wait", owner: "runtime", operationID: queued.id }),
  ])
  const serialized = JSON.stringify(detail.retainedVerifications)
  for (const canary of [
    "PRIVATE_REASON_CANARY",
    "PRIVATE_HOLD_REASON_CANARY",
    "PRIVATE_COMMAND_CANARY",
    "PRIVATE_STDOUT_CANARY",
    "PRIVATE_STDERR_CANARY",
    "PRIVATE_CHECK_ENVIRONMENT_CANARY",
    "PRIVATE_RESOURCE_NAME_CANARY",
    "RESOURCE_PATH_CANARY",
    "TASK_WORKSPACE_CANARY",
    "receipt-path-canary",
    "check-context-canary",
    "retained-verification-workspace-canary",
  ])
    expect(serialized).not.toContain(canary)
  expect(detail.retainedVerifications).not.toHaveProperty("history")
  expect(latest.find((operation) => operation.taskID === f.prerequisite.id)).toEqual(
    expect.objectContaining({
      operationID: failed.id,
      checks: [
        expect.objectContaining({
          phase: "task",
          result: expect.objectContaining({
            status: "failed",
            exitCode: 1,
            timedOut: true,
            stopCause: "hard-backstop",
            startedAt: 1_700_000_001_000,
            endedAt: 1_700_000_002_000,
            output: "truncated",
          }),
          verificationDeadline: expect.objectContaining({
            timingPolicyVersion: 2,
            authoredTimeoutMs: null,
            authoredInactivityTimeoutMs: 2_000,
            authoredHardTimeoutMs: 5_000,
            defaultInactivityTimeoutMs: 900_000,
            defaultHardTimeoutMs: 3_600_000,
            effectiveInactivityTimeoutMs: 2_000,
            effectiveHardTimeoutMs: 5_000,
            inactivityProvenance: "per-check",
            hardTimeoutProvenance: "per-check",
            historicalAmendmentIDs: ["old-amendment"],
          }),
          cleanupState: "failed",
        }),
      ],
    }),
  )
})

test("in-progress retained checks keep progress runtime-owned", () => {
  const f = fixture()
  const plan = f.store.submit(f.input, "owner")
  const operation = retainedOperation(f.projectDirectory, plan.planID, f.first.id, 1, "task-checks")
  f.store.atomic((db) => createRetainedVerification(db, f.projectDirectory, operation))
  const projection = (
    inspectPlan(f.store, { planID: plan.planID, full: true }) as {
      retainedVerifications: { latest: Array<{ nextSteps: Array<Record<string, unknown>> }> }
    }
  ).retainedVerifications
  expect(projection.latest[0]!.nextSteps.map((step) => step.action)).toEqual(["wait"])
  expect(projection.latest[0]!.nextSteps[0]).toMatchObject({
    owner: "runtime",
    operationID: operation.id,
  })
})

test("terminal operation hints offer a new retained verification, never a retry", () => {
  const f = fixture()
  const plan = f.store.submit(f.input, "owner")
  const operation = retainedOperation(f.projectDirectory, plan.planID, f.first.id, 1, "accepted", {
    cleanupState: "failed",
  })
  f.store.atomic((db) => {
    createRetainedVerification(db, f.projectDirectory, operation)
    db.query("UPDATE runner_plans SET state='accepted' WHERE id=?").run(plan.planID)
    db.query(
      "UPDATE runner_nodes SET state='accepted',artifact=? WHERE plan_id=? AND task_id=?",
    ).run(operation.artifact, plan.planID, f.first.id)
  })
  const projection = (
    inspectPlan(f.store, { planID: plan.planID, full: true }) as {
      retainedVerifications: {
        latest: Array<{
          state: string
          cleanup: { state: string }
          nextSteps: Array<Record<string, unknown>>
        }>
      }
    }
  ).retainedVerifications
  expect(projection.latest[0]).toMatchObject({ state: "accepted", cleanup: { state: "failed" } })
  expect(projection.latest[0]!.nextSteps).toContainEqual(
    expect.objectContaining({
      action: "verify-retained",
      basedOn: { operationID: operation.id },
      taskID: f.first.id,
      taskRevision: 1,
      attemptID: operation.attemptID,
      candidateArtifact: operation.artifact,
    }),
  )
  expect(projection.latest[0]!.nextSteps.map((step) => step.action)).not.toContain("cleanup")
  expect(projection.latest[0]!.nextSteps.map((step) => step.action)).not.toContain("resume")
  expect(projection.latest[0]!.nextSteps.map((step) => step.action)).not.toContain("retry")
})

test("missing retained tables are reported without creating schema or writing rows", () => {
  const f = fixture()
  const plan = f.store.submit(f.input, "owner")
  const tables = () =>
    f.store.atomic((db) =>
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'runner_retained_verification_%' ORDER BY name",
        )
        .all(),
    )
  const beforeTables = tables()
  const beforeChanges = f.store.atomic(
    (db) => db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()!.changes,
  )
  const projection = inspectPlan(f.store, { planID: plan.planID, full: true }) as {
    retainedVerifications: {
      status: string
      availability: { operations: boolean }
      latest: unknown[]
    }
  }
  const afterChanges = f.store.atomic(
    (db) => db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()!.changes,
  )
  expect(projection.retainedVerifications).toMatchObject({
    status: "unavailable",
    availability: { operations: false },
    latest: [],
  })
  expect(tables()).toEqual(beforeTables)
  expect(afterChanges).toBe(beforeChanges)
})

function seedTransitions(f: ReturnType<typeof fixture>, planID: string, count: number) {
  f.store.atomic((db) => {
    const insert = db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
    )
    for (let index = 0; index < count; index++)
      insert.run(
        planID,
        null,
        1,
        index % 2 ? "NOISE_A" : "NOISE_B",
        JSON.stringify({ index }),
        index,
      )
  })
}

function transitionTotal(f: ReturnType<typeof fixture>, planID: string) {
  return f.store.read(
    (db) =>
      (
        db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM runner_transitions WHERE plan_id=?",
          )
          .get(planID) as { n: number }
      ).n,
  )
}

test("full plan detail reads a bounded page of an enormous history and pages older rows", () => {
  const f = fixture()
  const receipt = f.store.submit(f.input, "owner")
  seedTransitions(f, receipt.planID, 20_000)
  const total = transitionTotal(f, receipt.planID)
  const detail = inspectPlan(f.store, { planID: receipt.planID, full: true }) as unknown as {
    activity: { id: number }[]
    paging: { limit: number; activity: { next: number | null; returned: number } }
  }
  expect(detail.activity).toHaveLength(200)
  expect(detail.paging.activity.returned).toBe(200)
  expect(detail.paging.activity.next).toBe(detail.activity[0]!.id)
  const ids = detail.activity.map((row) => row.id)
  expect(ids).toEqual([...ids].sort((a, b) => a - b))

  const seen = new Set(ids)
  let next = detail.paging.activity.next
  let pages = 1
  while (next !== null) {
    const page = inspectPlan(f.store, {
      planID: receipt.planID,
      full: true,
      activityBefore: next,
    }) as unknown as typeof detail
    for (const row of page.activity) {
      expect(row.id).toBeLessThan(next)
      expect(seen.has(row.id)).toBe(false)
      seen.add(row.id)
    }
    next = page.paging.activity.next
    pages++
  }
  expect(seen.size).toBe(total)
  expect(pages).toBe(Math.ceil(total / 200))
})

test("detail materializes at most limit rows per list regardless of history size", () => {
  const f = fixture()
  const receipt = f.store.submit(f.input, "owner")
  seedTransitions(f, receipt.planID, 20_000)
  const small = f.store.detail(receipt.planID, { limit: 5 })
  expect(small.activity).toHaveLength(5)
  expect(small.paging.limit).toBe(5)
  expect(small.paging.activity.next).not.toBeNull()
})

test("compact inspection aggregates history in SQL so totals still cover everything", () => {
  const f = fixture()
  const receipt = f.store.submit(f.input, "owner")
  seedTransitions(f, receipt.planID, 20_000)
  const compact = inspectPlan(f.store, {
    planID: receipt.planID,
    full: false,
  }) as unknown as CompactPlanDetail & {
    counts: { transitionsByEvent: Record<string, number> }
  }
  expect(compact.counts.transitionsByEvent.NOISE_A).toBe(10_000)
  expect(compact.counts.transitionsByEvent.NOISE_B).toBe(10_000)
})

test("history queries are served by plan-scoped indexes", () => {
  const f = fixture()
  const explain = (sql: string) =>
    f.store.read((db) =>
      db
        .query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN ${sql}`)
        .all("p")
        .map((row) => row.detail)
        .join(" "),
    )
  expect(
    explain("SELECT * FROM runner_transitions WHERE plan_id=? AND id<9 ORDER BY id DESC LIMIT 201"),
  ).toContain("runner_transitions_plan_id")
  expect(
    explain("SELECT event,COUNT(*) FROM runner_transitions WHERE plan_id=? GROUP BY event"),
  ).toContain("runner_transitions_plan_event")
})
