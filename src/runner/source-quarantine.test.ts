import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { RunnerStore } from "./store.ts"
import {
  beginSourceGuard,
  registerSourceGuard,
  samePhysicalWorkspace,
  sourceGuardInstalled,
  sourceGuardMatches,
  sourceQuarantineVerificationBinding,
  sourceQuarantineVerificationBindingMatches,
} from "./source-quarantine.ts"

test("a failed replacement restores the surviving installed source guard", () => {
  const root = mkdtempSync(join(tmpdir(), "lz-guard-survivor-"))
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  const store = { repository }
  const a = beginSourceGuard({ directory: root, projectDirectory: root })
  a.install(store)
  expect(sourceGuardMatches(store, root, a.registrationID)).toBe(true)
  const b = beginSourceGuard({ directory: root, projectDirectory: root })
  try {
    expect(sourceGuardInstalled(store, root)).toBe(false)
    expect(sourceGuardMatches(store, root, a.registrationID)).toBe(false)
    b.dispose()
    // S1-1: a failed replacement must restore the surviving installed hook scope.
    expect(sourceGuardInstalled(store, root)).toBe(true)
    expect(sourceGuardMatches(store, root, a.registrationID)).toBe(true)
    expect(sourceGuardMatches(store, root, b.registrationID)).toBe(false)
  } finally {
    b.dispose()
    a.dispose()
    repository.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("source guard disposal selects the latest installed survivor without reviving disposed scopes", () => {
  const root = mkdtempSync(join(tmpdir(), "lz-guard-order-"))
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  const store = { repository }
  const a = beginSourceGuard({ directory: root, projectDirectory: root })
  a.install(store)
  const b = beginSourceGuard({ directory: root, projectDirectory: root })
  b.install(store)
  const c = beginSourceGuard({ directory: root, projectDirectory: root })
  c.install(store)
  try {
    c.dispose()
    // S1-1: restoring the newest installed survivor keeps older scopes fenced.
    expect(sourceGuardMatches(store, root, b.registrationID)).toBe(true)
    expect(sourceGuardMatches(store, root, a.registrationID)).toBe(false)
    c.dispose()
    expect(sourceGuardMatches(store, root, b.registrationID)).toBe(true)
    a.dispose()
    expect(sourceGuardMatches(store, root, b.registrationID)).toBe(true)
    b.dispose()
    expect(sourceGuardInstalled(store, root)).toBe(false)
  } finally {
    c.dispose()
    b.dispose()
    a.dispose()
    repository.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("missing reserved workspaces remain distinct from existing retained worktrees", () => {
  const root = mkdtempSync(join(tmpdir(), "lz-workspace-identity-"))
  try {
    const retained = join(root, "retained")
    const reserved = join(root, "new", "reserved")
    mkdirSync(retained)
    expect(samePhysicalWorkspace(reserved, retained)).toBe(false)
    expect(samePhysicalWorkspace(retained, reserved)).toBe(false)
    expect(samePhysicalWorkspace(reserved, reserved)).toBe(true)
    expect(samePhysicalWorkspace(reserved, join(root, "new", "other"))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("existing symlink ancestors preserve identity for absent children", () => {
  const root = mkdtempSync(join(tmpdir(), "lz-workspace-alias-"))
  try {
    const real = join(root, "real")
    const alias = join(root, "alias")
    mkdirSync(real)
    symlinkSync(real, alias)
    expect(samePhysicalWorkspace(real, alias)).toBe(true)
    expect(samePhysicalWorkspace(join(real, "future", "task"), join(alias, "future", "task"))).toBe(
      true,
    )
    expect(
      samePhysicalWorkspace(join(real, "future", "task"), join(alias, "future", "other")),
    ).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("unresolvable symlinks and filesystem errors remain conservative", () => {
  const root = mkdtempSync(join(tmpdir(), "lz-workspace-unknown-"))
  try {
    const dangling = join(root, "dangling")
    symlinkSync(join(root, "missing-target"), dangling)
    expect(samePhysicalWorkspace(dangling, root)).toBe(true)
    expect(samePhysicalWorkspace(join(root, "invalid\0path"), root)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("retained verification binding requires the exact sealed guarded source and review input", () => {
  const root = mkdtempSync(join(tmpdir(), "lz-source-verification-binding-"))
  const workspace = join(root, "source")
  mkdirSync(workspace)
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  const store = new RunnerStore(repository)
  const task = repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "project",
      projectDirectory: root,
      workspaceDirectory: root,
      sessionID: "owner",
      startingRevision: { kind: "unborn" },
    },
    proposal: validProposal(),
  })
  const planID = crypto.randomUUID()
  const attemptID = crypto.randomUUID()
  const startedAt = Date.now()
  store.atomic((db) => {
    db.query(
      "INSERT INTO runner_plans(id,project_directory,owner,revision,version,state,body) VALUES(?,?,?,1,1,'running','{}')",
    ).run(planID, root, "owner")
    db.query(
      "INSERT INTO runner_nodes(plan_id,task_id,spec_revision,ordinal,state,version,snapshot,machine_version) VALUES(?,?,1,0,'verifying',1,'{}','1')",
    ).run(planID, task.id)
    db.query(
      `INSERT INTO runner_attempts(
         id,plan_id,project_directory,task_id,number,session_id,message_id,workspace,
         base_commit,artifact,policy,state,started_at
       ) VALUES(?,?,?, ?,1,?,?,?, ?,?, '{}','verifying',?)`,
    ).run(
      attemptID,
      planID,
      root,
      task.id,
      "worker",
      "assigned-input",
      workspace,
      "a".repeat(40),
      "a".repeat(40),
      startedAt,
    )
  })
  const attempt = {
    id: attemptID,
    plan_id: planID,
    task_id: task.id,
    state: "verifying" as const,
    artifact: "a".repeat(40),
    session_id: "worker",
    message_id: "assigned-input",
    workspace,
    started_at: startedAt,
  }
  const reviewInput = { inputID: "review-input", requestID: "review-request" }
  const now = Date.now()
  store.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_source_quarantines(
           attempt_id,plan_id,session_id,assigned_message_id,requested_owner,workspace,
           request_id,reason,phase,hold_reason,review_input_json,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,?, 'pending',NULL,?,?,?)`,
      )
      .run(
        attempt.id,
        attempt.plan_id,
        attempt.session_id,
        attempt.message_id,
        "owner",
        workspace,
        "quarantine-request",
        "Keep the exact source assignment guarded",
        JSON.stringify(reviewInput),
        now,
        now,
      ),
  )
  const disposeGuard = registerSourceGuard(store, workspace)
  try {
    expect(
      sourceQuarantineVerificationBinding(store, {
        planID: attempt.plan_id,
        owner: "owner",
        attempt,
        artifact: attempt.artifact,
      }),
    ).toBeUndefined()
    store.atomic((db) =>
      db
        .query("UPDATE runner_source_quarantines SET phase='sealed' WHERE attempt_id=?")
        .run(attempt.id),
    )
    const binding = sourceQuarantineVerificationBinding(store, {
      planID: attempt.plan_id,
      owner: "owner",
      attempt,
      artifact: attempt.artifact,
    })
    expect(binding).toEqual({
      requestID: "quarantine-request",
      requestedOwner: "owner",
      reviewInput,
    })
    expect(
      sourceQuarantineVerificationBindingMatches(store, {
        planID: attempt.plan_id,
        owner: "owner",
        attempt,
        artifact: attempt.artifact,
        expected: binding!,
      }),
    ).toBe(true)
    const legacyBinding = { requestID: binding!.requestID, reviewInput: binding!.reviewInput }
    expect(
      sourceQuarantineVerificationBindingMatches(store, {
        planID: attempt.plan_id,
        owner: "owner",
        attempt,
        artifact: attempt.artifact,
        expected: legacyBinding,
      }),
    ).toBe(true)
    expect(store.updatePlanOwner(planID, "owner", "continued-owner")).toBe(true)
    expect(
      sourceQuarantineVerificationBinding(store, {
        planID: attempt.plan_id,
        owner: "continued-owner",
        attempt,
        artifact: attempt.artifact,
      }),
    ).toEqual(binding)
    expect(
      sourceQuarantineVerificationBinding(store, {
        planID: attempt.plan_id,
        owner: "continued-owner",
        attempt: { ...attempt, message_id: "foreign-input" },
        artifact: attempt.artifact,
      }),
    ).toBeUndefined()
    store.atomic((db) =>
      db
        .query("UPDATE runner_source_quarantines SET review_input_json=? WHERE attempt_id=?")
        .run(JSON.stringify({ ...reviewInput, inputID: "stale-input" }), attempt.id),
    )
    expect(
      sourceQuarantineVerificationBindingMatches(store, {
        planID: attempt.plan_id,
        owner: "continued-owner",
        attempt,
        artifact: attempt.artifact,
        expected: binding!,
      }),
    ).toBe(false)
    store.atomic((db) =>
      db
        .query("UPDATE runner_source_quarantines SET hold_reason='unresolved' WHERE attempt_id=?")
        .run(attempt.id),
    )
    expect(
      sourceQuarantineVerificationBinding(store, {
        planID: attempt.plan_id,
        owner: "continued-owner",
        attempt,
        artifact: attempt.artifact,
      }),
    ).toBeUndefined()
    disposeGuard()
    expect(
      sourceQuarantineVerificationBinding(store, {
        planID: attempt.plan_id,
        owner: "continued-owner",
        attempt,
        artifact: attempt.artifact,
      }),
    ).toBeUndefined()
  } finally {
    disposeGuard()
    repository.close()
    rmSync(root, { recursive: true, force: true })
  }
})
