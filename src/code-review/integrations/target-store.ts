import { randomUUID } from "node:crypto"
import type { Database } from "bun:sqlite"
import type { TaskRepository } from "../../storage.ts"
import { CodeReviewStore } from "../comparisons/store.ts"
import {
  CodeReviewIntegrationPullRequestSchema,
  CodeReviewIntegrationTargetSchema,
  type CodeReviewIntegrationPullRequest,
  type CodeReviewIntegrationTarget,
} from "./contract.ts"

type IntegrationTargetRow = {
  target_id: string
  project_id: string
  branch: string
  base_branch: string
  base_revision: string
  pull_request_json: string | null
  observed_head: string
  created_at: number
  updated_at: number
}

export type StoredIntegrationTarget = {
  target: CodeReviewIntegrationTarget
  observedHead: string
}

type IntegrationTargetWrite = {
  projectID: string
  taskIDs: string[]
  branch: string
  baseBranch: string
  baseRevision: string
  expectedHead: string
  currentHead: string
  pullRequest?: CodeReviewIntegrationPullRequest | null
  now?: number
}

type IntegrationTargetReconciliation = {
  targetID: string
  projectID: string
  branch: string
  baseBranch: string
  baseRevision: string
  taskIDs: string[]
  expectedHead: string
  nextHead: string
  now?: number
}

function assertReconciliationIdentity(
  existing: StoredIntegrationTarget | undefined,
  input: IntegrationTargetReconciliation,
): asserts existing is StoredIntegrationTarget {
  if (!existing)
    throw new Error("Integration target identity changed; re-inspect before reconciliation")
  const identity = existing.target
  const expected = [
    [identity.projectID, input.projectID],
    [identity.branch, input.branch],
    [identity.baseBranch, input.baseBranch],
    [identity.baseRevision, input.baseRevision],
  ] as const
  if (expected.some(([actual, wanted]) => actual !== wanted))
    throw new Error("Integration target identity changed; re-inspect before reconciliation")
}

function assertReconciliationMembership(
  existing: StoredIntegrationTarget,
  taskIDs: string[],
): void {
  const selected = new Set(taskIDs)
  if (
    existing.target.taskIDs.length !== taskIDs.length ||
    existing.target.taskIDs.some((taskID) => !selected.has(taskID))
  )
    throw new Error("Target reconciliation cannot change selected task membership")
}

function assertReconciliationHeads(
  existing: StoredIntegrationTarget,
  input: IntegrationTargetReconciliation,
): void {
  if (existing.observedHead !== input.expectedHead)
    throw new Error("Integration target observed head changed; re-inspect before reconciliation")
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.nextHead))
    throw new Error("Reconciled integration target head must be a full commit ID")
  if (input.expectedHead === input.nextHead)
    throw new Error("Integration target head is already observed; there is no rewrite to reconcile")
}

function taskIDsFor(db: Database, projectDirectory: string, targetID: string): string[] {
  const rows = db
    .query<{ task_id: string }, [string, string]>(
      `SELECT task_id FROM code_review_integration_target_tasks
        WHERE project_directory=? AND target_id=? ORDER BY ordinal,task_id LIMIT 101`,
    )
    .all(projectDirectory, targetID)
  if (rows.length > 100) throw new Error("Integration target exceeds the retained task limit")
  return rows.map((row) => row.task_id)
}

function assertTaskIDsAvailable(
  db: Database,
  projectDirectory: string,
  targetID: string | undefined,
  taskIDs: string[],
): void {
  for (const taskID of taskIDs) {
    const owner = db
      .query<{ target_id: string }, [string, string]>(
        `SELECT target_id FROM code_review_integration_target_tasks
         WHERE project_directory=? AND task_id=?`,
      )
      .get(projectDirectory, taskID)
    if (owner && owner.target_id !== targetID)
      throw new Error(`Task ${taskID} is already bound to another integration target`)
  }
}

function insertTargetTasks(
  db: Database,
  projectDirectory: string,
  targetID: string,
  taskIDs: string[],
  ordinalStart = 0,
): void {
  const insert = db.query(
    `INSERT INTO code_review_integration_target_tasks(project_directory,target_id,task_id,ordinal)
     VALUES(?,?,?,?)`,
  )
  taskIDs.forEach((taskID, index) =>
    insert.run(projectDirectory, targetID, taskID, ordinalStart + index),
  )
}

function assertTargetCanExtend(
  existing: StoredIntegrationTarget,
  input: IntegrationTargetWrite,
): void {
  if (
    existing.target.projectID !== input.projectID ||
    existing.target.baseBranch !== input.baseBranch ||
    existing.target.baseRevision !== input.baseRevision
  )
    throw new Error("Integration branch is already bound to a different project or base")
  if (existing.observedHead !== input.expectedHead)
    throw new Error("Integration target is stale; record the intervening landing first")
}

function addTargetTasks(
  db: Database,
  repository: TaskRepository,
  target: CodeReviewIntegrationTarget,
  taskIDs: string[],
): string[] {
  const newTaskIDs = taskIDs.filter((taskID) => !target.taskIDs.includes(taskID))
  assertTaskIDsAvailable(db, repository.projectDirectory, target.id, newTaskIDs)
  insertTargetTasks(db, repository.projectDirectory, target.id, newTaskIDs, target.taskIDs.length)
  return newTaskIDs
}

function updateTargetPullRequest(
  db: Database,
  repository: TaskRepository,
  target: CodeReviewIntegrationTarget,
  input: IntegrationTargetWrite,
  newTaskIDs: string[],
  now: number,
): void {
  const nextPullRequest = input.pullRequest === undefined ? target.pullRequest : input.pullRequest
  if (nextPullRequest)
    assertPullRequestAvailable(db, repository.projectDirectory, target.id, nextPullRequest)
  const changed =
    newTaskIDs.length > 0 || JSON.stringify(nextPullRequest) !== JSON.stringify(target.pullRequest)
  if (!changed) return
  db.query(
    `UPDATE code_review_integration_targets SET pull_request_json=?,updated_at=?
     WHERE project_directory=? AND target_id=? AND observed_head=?`,
  ).run(
    nextPullRequest ? JSON.stringify(nextPullRequest) : null,
    now,
    repository.projectDirectory,
    target.id,
    input.expectedHead,
  )
}

function extendTargetIn(
  db: Database,
  repository: TaskRepository,
  existing: StoredIntegrationTarget,
  input: IntegrationTargetWrite,
  now: number,
): { target: CodeReviewIntegrationTarget; created: false } {
  assertTargetCanExtend(existing, input)
  const newTaskIDs = addTargetTasks(db, repository, existing.target, input.taskIDs)
  updateTargetPullRequest(db, repository, existing.target, input, newTaskIDs, now)
  return {
    target: targetByIDIn(db, repository, existing.target.id)!.target,
    created: false,
  }
}

function createTargetIn(
  db: Database,
  repository: TaskRepository,
  input: IntegrationTargetWrite,
  now: number,
): { target: CodeReviewIntegrationTarget; created: true } {
  assertTaskIDsAvailable(db, repository.projectDirectory, undefined, input.taskIDs)
  const targetID = randomUUID()
  const pullRequest =
    input.pullRequest === undefined
      ? null
      : CodeReviewIntegrationPullRequestSchema.parse(input.pullRequest)
  if (pullRequest)
    assertPullRequestAvailable(db, repository.projectDirectory, targetID, pullRequest)
  db.query(
    `INSERT INTO code_review_integration_targets(
       project_directory,target_id,project_id,branch,base_branch,base_revision,
       pull_request_json,observed_head,created_at,updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    repository.projectDirectory,
    targetID,
    input.projectID,
    input.branch,
    input.baseBranch,
    input.baseRevision,
    pullRequest ? JSON.stringify(pullRequest) : null,
    input.currentHead,
    now,
    now,
  )
  insertTargetTasks(db, repository.projectDirectory, targetID, input.taskIDs)
  return { target: targetByIDIn(db, repository, targetID)!.target, created: true }
}

function targetByIDIn(
  db: Database,
  repository: TaskRepository,
  targetID: string,
): StoredIntegrationTarget | undefined {
  const row = db
    .query<IntegrationTargetRow, [string, string]>(
      `SELECT target_id,project_id,branch,base_branch,base_revision,pull_request_json,
              observed_head,created_at,updated_at
       FROM code_review_integration_targets WHERE project_directory=? AND target_id=?`,
    )
    .get(repository.projectDirectory, targetID)
  if (!row) return undefined
  return {
    target: CodeReviewIntegrationTargetSchema.parse({
      id: row.target_id,
      projectID: row.project_id,
      taskIDs: taskIDsFor(db, repository.projectDirectory, targetID),
      branch: row.branch,
      baseBranch: row.base_branch,
      baseRevision: row.base_revision,
      pullRequest: row.pull_request_json ? JSON.parse(row.pull_request_json) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
    observedHead: row.observed_head,
  }
}

function targetByBranchIn(
  db: Database,
  repository: TaskRepository,
  branch: string,
): StoredIntegrationTarget | undefined {
  const row = db
    .query<{ target_id: string }, [string, string]>(
      `SELECT target_id FROM code_review_integration_targets
       WHERE project_directory=? AND branch=?`,
    )
    .get(repository.projectDirectory, branch)
  return row ? targetByIDIn(db, repository, row.target_id) : undefined
}

export class CodeReviewIntegrationTargetStore {
  constructor(readonly repository: TaskRepository) {
    new CodeReviewStore(repository)
  }

  target(targetID: string): StoredIntegrationTarget | undefined {
    return this.repository.read((db) => targetByIDIn(db, this.repository, targetID))
  }

  targetIn(db: Database, targetID: string): StoredIntegrationTarget | undefined {
    return targetByIDIn(db, this.repository, targetID)
  }

  targetForTask(taskID: string): StoredIntegrationTarget | undefined {
    return this.repository.read((db) => {
      const row = db
        .query<{ target_id: string }, [string, string]>(
          `SELECT target_id FROM code_review_integration_target_tasks
           WHERE project_directory=? AND task_id=?`,
        )
        .get(this.repository.projectDirectory, taskID)
      return row ? targetByIDIn(db, this.repository, row.target_id) : undefined
    })
  }

  targetByBranch(branch: string): StoredIntegrationTarget | undefined {
    return this.repository.read((db) => targetByBranchIn(db, this.repository, branch))
  }

  createOrExtendIn(
    db: Database,
    input: IntegrationTargetWrite,
  ): { target: CodeReviewIntegrationTarget; created: boolean } {
    if (input.expectedHead !== input.currentHead)
      throw new Error("Integration target head changed; re-inspect before updating it")
    const existing = targetByBranchIn(db, this.repository, input.branch)
    const now = input.now ?? Date.now()
    return existing
      ? extendTargetIn(db, this.repository, existing, input, now)
      : createTargetIn(db, this.repository, input, now)
  }

  advanceObservedHeadIn(
    db: Database,
    targetID: string,
    expectedHead: string,
    nextHead: string,
    now = Date.now(),
  ): CodeReviewIntegrationTarget {
    const result = db
      .query(
        `UPDATE code_review_integration_targets SET observed_head=?,updated_at=?
         WHERE project_directory=? AND target_id=? AND observed_head=?`,
      )
      .run(nextHead, now, this.repository.projectDirectory, targetID, expectedHead)
    if (result.changes !== 1)
      throw new Error("Integration target observed head changed; re-inspect before recording")
    return targetByIDIn(db, this.repository, targetID)!.target
  }

  reconcileObservedHeadIn(
    db: Database,
    input: IntegrationTargetReconciliation,
  ): CodeReviewIntegrationTarget {
    const existing = targetByIDIn(db, this.repository, input.targetID)
    assertReconciliationIdentity(existing, input)
    assertReconciliationMembership(existing, input.taskIDs)
    assertReconciliationHeads(existing, input)
    const updated = db
      .query(
        `UPDATE code_review_integration_targets SET observed_head=?,updated_at=?
         WHERE project_directory=? AND target_id=? AND observed_head=?`,
      )
      .run(
        input.nextHead,
        input.now ?? Date.now(),
        this.repository.projectDirectory,
        input.targetID,
        input.expectedHead,
      )
    if (updated.changes !== 1)
      throw new Error("Integration target observed head changed; re-inspect before reconciliation")
    return targetByIDIn(db, this.repository, input.targetID)!.target
  }
}

function assertPullRequestAvailable(
  db: Database,
  projectDirectory: string,
  targetID: string,
  pullRequest: CodeReviewIntegrationPullRequest,
) {
  const duplicate = db
    .query<{ target_id: string }, [string, string, string, string]>(
      `SELECT target_id FROM code_review_integration_targets
       WHERE project_directory=? AND target_id<>? AND pull_request_json IS NOT NULL
         AND (json_extract(pull_request_json,'$.url')=? OR
              json_extract(pull_request_json,'$.id')=?)`,
    )
    .get(projectDirectory, targetID, pullRequest.url, pullRequest.id)
  if (duplicate)
    throw new Error("Pull request is already associated with another integration target")
}
