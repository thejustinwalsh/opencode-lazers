import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { type CompactInspectionSummary, type CompactPlanDetail, inspectPlan } from "./inspection.ts"
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
