import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { TaskRepository } from "../../../src/storage.ts"
import { RunnerStore } from "../../../src/runner/store.ts"
import type { AttemptRow } from "../../../src/runner/store.ts"
import type { TaskKindV1 } from "../../../src/task-classification.ts"
import type { TaskSpec } from "../../../src/task.ts"
import { validProposal } from "../../proposal.ts"

const BASE_COMMIT = "a".repeat(40)
const PROJECT_ID = "observation-ledger-project"
const CURSOR_SECRET = new Uint8Array(32).fill(47)

export type LedgerFixtureTask = {
  id: string
  kind: TaskKindV1 | null
  createdAt: string
}

function taskSpec(projectDirectory: string, task: LedgerFixtureTask): TaskSpec {
  const proposal = validProposal()
  proposal.objective = `Private task objective ${task.id}`
  if (task.kind) proposal.classification = { taxonomy: "task-kind/v1", primaryKind: task.kind }
  else delete proposal.classification
  return {
    schemaVersion: 1,
    id: task.id,
    revision: 1,
    status: "submitted",
    createdAt: task.createdAt,
    provenance: {
      projectID: PROJECT_ID,
      projectDirectory,
      workspaceDirectory: projectDirectory,
      sessionID: "ses-ledger-owner",
      startingRevision: { kind: "git", commit: BASE_COMMIT },
    },
    proposal,
  }
}

function planFor(store: RunnerStore, task: TaskSpec, suffix: string, persona: "ui" | "systems") {
  return store.submit(
    {
      requestID: `ledger-plan-${suffix}`,
      objective: `Private plan objective ${suffix}`,
      baseCommit: BASE_COMMIT,
      workspaceMode: "isolated",
      workerModel: { providerID: "openai", id: "requested-model", variant: "high" },
      nodes: [{ taskID: task.id, revision: 1, persona }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: task.proposal.verification,
      acceptance: task.proposal.acceptance,
      dispositions: [],
    },
    "ses-ledger-owner",
  )
}

function attemptRow(
  planID: string,
  taskID: string,
  number: number,
  sessionID: string,
  state: string,
  startedAt: number,
  tokenCount: number,
  artifact: string | null = null,
): AttemptRow {
  return {
    id: randomUUID(),
    plan_id: planID,
    task_id: taskID,
    number,
    session_id: sessionID,
    message_id: `msg-${randomUUID()}`,
    workspace: "/private/worker/worktree",
    base_commit: BASE_COMMIT,
    artifact,
    policy: JSON.stringify({
      model: { providerID: "anthropic", id: "frozen-model", variant: "max" },
      persona: "ui",
    }),
    state,
    started_at: startedAt,
    token_count: tokenCount,
    tool_count: 2,
    retry_count: Math.max(0, number - 1),
    cost: null,
  }
}

function insertAttempt(db: Database, attempt: AttemptRow) {
  db.query(
    `INSERT INTO runner_attempts
     (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,
      state,started_at,token_count,tool_count,retry_count,cost)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    attempt.id,
    attempt.plan_id,
    attempt.task_id,
    attempt.number,
    attempt.session_id,
    attempt.message_id,
    attempt.workspace,
    attempt.base_commit,
    attempt.artifact,
    attempt.policy,
    attempt.state,
    attempt.started_at,
    attempt.token_count,
    attempt.tool_count,
    attempt.retry_count,
    attempt.cost,
  )
}

function progressFact(
  db: Database,
  input: {
    taskID: string
    planID: string
    attemptID: string
    sessionID: string
    at: number
    kind: "usage-snapshot" | "step"
    measurementBasis: string | null
    usage: Record<string, unknown> | null
    observations?: Array<Record<string, unknown>>
    route?: { providerID: string; modelID: string; variant: string | null }
    secret?: string
  },
) {
  const payload: Record<string, unknown> = {
    measurementBasis: input.measurementBasis,
    usage: input.usage,
  }
  if (input.kind === "usage-snapshot") payload.additive = false
  if (input.observations) payload.observations = input.observations
  if (input.route) payload.route = input.route
  if (input.secret) payload.privatePrompt = input.secret
  db.query(
    `INSERT INTO runner_progress
     (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
      source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    db
      .query<{ project_directory: string }, [string]>(
        "SELECT project_directory FROM runner_plans WHERE id=?",
      )
      .get(input.planID)!.project_directory,
    PROJECT_ID,
    input.planID,
    input.taskID,
    input.attemptID,
    input.sessionID,
    input.at,
    input.at + 11,
    "runtime",
    JSON.stringify(["runtime"]),
    input.kind,
    JSON.stringify([]),
    null,
    null,
    `ledger-fact-${randomUUID()}`,
    JSON.stringify(payload),
  )
}

function transition(
  db: Database,
  planID: string,
  taskID: string,
  event: string,
  payload: unknown,
  at: number,
) {
  db.query(
    `INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at)
     VALUES(?,?,1,?,?,?)`,
  ).run(planID, taskID, event, JSON.stringify(payload), at)
}

function permitSharedAttemptSession(path: string, sharedAttemptID: string, sessionID: string) {
  const db = new Database(path)
  try {
    db.exec("PRAGMA foreign_keys=OFF")
    db.exec(`
      ALTER TABLE runner_attempts RENAME TO runner_attempts_unique_session;
      CREATE TABLE runner_attempts (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, task_id TEXT NOT NULL, number INTEGER NOT NULL,
        session_id TEXT NOT NULL, message_id TEXT NOT NULL, workspace TEXT NOT NULL,
        base_commit TEXT NOT NULL, artifact TEXT, policy TEXT NOT NULL, state TEXT NOT NULL,
        started_at INTEGER NOT NULL, token_count INTEGER, tool_count INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0, cost REAL, UNIQUE(task_id,number)
      );
      INSERT INTO runner_attempts SELECT * FROM runner_attempts_unique_session;
      DROP TABLE runner_attempts_unique_session;
    `)
    db.query("UPDATE runner_attempts SET session_id=? WHERE id=?").run(sessionID, sharedAttemptID)
    db.query("UPDATE runner_progress SET session_id=? WHERE attempt_id=?").run(
      sessionID,
      sharedAttemptID,
    )
  } finally {
    db.close()
  }
}

function addLegacyClassification(
  path: string,
  projectDirectory: string,
  taskID: string,
  expectedRevision: number,
  kind: TaskKindV1,
) {
  const db = new Database(path)
  try {
    const classification = { taxonomy: "task-kind/v1", primaryKind: kind }
    const reason = "Correct the retained task-kind label"
    const requestID = `ledger-classification-${randomUUID()}`
    const createdAt = new Date(1_800_000_000_000 + expectedRevision).toISOString()
    db.query(
      `INSERT INTO task_classifications
       (project_directory,task_id,request_id,payload,revision,classification,reason,session_id,agent,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      projectDirectory,
      taskID,
      requestID,
      JSON.stringify({ taskID, expectedRevision, classification, reason }),
      expectedRevision + 1,
      JSON.stringify(classification),
      reason,
      "ses-ledger-owner",
      "lazers-architect",
      createdAt,
    )
  } finally {
    db.close()
  }
}

export function makeLedgerFixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-observation-ledger-"))
  const path = join(directory, "tasks.sqlite")
  const repository = new TaskRepository(path, directory)
  const store = new RunnerStore(repository)
  const tasks: Record<string, LedgerFixtureTask> = {
    retry: {
      id: randomUUID(),
      kind: "feature-implementation",
      createdAt: "2026-10-31T12:00:01.000Z",
    },
    adoption: { id: randomUUID(), kind: "bug-repair", createdAt: "2026-10-31T12:00:02.000Z" },
    incorporated: { id: randomUUID(), kind: "testing", createdAt: "2026-10-31T12:00:03.000Z" },
    legacy: { id: randomUUID(), kind: null, createdAt: "2026-10-31T12:00:04.000Z" },
    sharedFeature: {
      id: randomUUID(),
      kind: "feature-implementation",
      createdAt: "2026-10-31T12:00:05.000Z",
    },
    sharedTesting: { id: randomUUID(), kind: "testing", createdAt: "2026-10-31T12:00:06.000Z" },
  }
  const taskSpecs = new Map<string, TaskSpec>()
  for (const [key, task] of Object.entries(tasks)) {
    const spec = taskSpec(directory, task)
    taskSpecs.set(key, repository.insert(spec))
  }

  const plans: Record<string, string> = {}
  for (const [key, persona] of [
    ["retry", "systems"],
    ["adoption", "systems"],
    ["incorporated", "systems"],
    ["sharedFeature", "systems"],
    ["sharedTesting", "ui"],
  ] as const) {
    const plan = planFor(store, taskSpecs.get(key)!, key, persona)
    plans[key] = plan.planID
  }

  const retryArtifact = "b".repeat(40)
  const adoptedArtifact = "c".repeat(40)
  const failedAttempt = attemptRow(
    plans.retry!,
    tasks.retry!.id,
    1,
    "ses-retry-failed",
    "failed",
    100,
    999,
  )
  const acceptedAttempt = attemptRow(
    plans.retry!,
    tasks.retry!.id,
    2,
    "ses-retry-accepted",
    "accepted",
    200,
    888,
    retryArtifact,
  )
  const adoptionAttempt = attemptRow(
    plans.adoption!,
    tasks.adoption!.id,
    1,
    "ses-adoption-failed",
    "failed",
    300,
    777,
    "d".repeat(40),
  )
  const sharedFeatureAttempt = attemptRow(
    plans.sharedFeature!,
    tasks.sharedFeature!.id,
    1,
    "ses-shared-session",
    "running",
    400,
    444,
  )
  const sharedTestingAttempt = attemptRow(
    plans.sharedTesting!,
    tasks.sharedTesting!.id,
    1,
    "ses-shared-temporary",
    "running",
    500,
    333,
  )

  store.atomic((db) => {
    for (const attempt of [
      failedAttempt,
      acceptedAttempt,
      adoptionAttempt,
      sharedFeatureAttempt,
      sharedTestingAttempt,
    ])
      insertAttempt(db, attempt)

    db.query(
      "UPDATE runner_plans SET state='accepted',artifact=?,version=version+1 WHERE id=?",
    ).run(retryArtifact, plans.retry!)
    db.query(
      "UPDATE runner_nodes SET state='accepted',artifact=?,version=version+1 WHERE plan_id=? AND task_id=?",
    ).run(retryArtifact, plans.retry!, tasks.retry!.id)
    transition(
      db,
      plans.retry!,
      tasks.retry!.id,
      "RETRY_REQUESTED",
      { attemptID: failedAttempt.id },
      150,
    )
    transition(
      db,
      plans.retry!,
      tasks.retry!.id,
      "ACCEPT",
      { from: "verifying", to: "accepted" },
      400,
    )
    transition(
      db,
      plans.retry!,
      tasks.retry!.id,
      "ARTIFACT_ACCEPTED",
      { commit: retryArtifact },
      401,
    )

    db.query(
      "UPDATE runner_plans SET state='accepted',artifact=?,version=version+1 WHERE id=?",
    ).run(adoptedArtifact, plans.adoption!)
    db.query(
      "UPDATE runner_nodes SET state='accepted',artifact=?,version=version+1 WHERE plan_id=? AND task_id=?",
    ).run(adoptedArtifact, plans.adoption!, tasks.adoption!.id)
    db.query(
      `INSERT INTO runner_adoptions
       (id,plan_id,task_id,request_id,owner,plan_version,task_revision,attempt_id,node_state,attempt_state,
        old_artifact,descendant_commit,target_branch,landing_head,reviewed_baseline,candidate_tree,
        input_fingerprint,environment_identity,reason,combined_artifact,task_workspace,combined_workspace,
        state,hold_reason,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "adoption-ledger-record",
      plans.adoption!,
      tasks.adoption!.id,
      "adoption-ledger-request",
      "ses-ledger-owner",
      2,
      1,
      adoptionAttempt.id,
      "failed",
      "failed",
      "d".repeat(40),
      adoptedArtifact,
      "main",
      "e".repeat(40),
      "f".repeat(40),
      "1".repeat(40),
      "input-fingerprint",
      "environment",
      "Adopt a descendant built from the failed attempt",
      "2".repeat(40),
      directory,
      directory,
      "accepted",
      null,
      600,
      601,
    )
    transition(
      db,
      plans.adoption!,
      tasks.adoption!.id,
      "ADOPT_ACCEPT",
      {
        from: "failed",
        to: "accepted",
        reason: "descendant adopted",
      },
      700,
    )
    transition(
      db,
      plans.adoption!,
      tasks.adoption!.id,
      "DESCENDANT_ADOPTED",
      {
        adoptionID: "adoption-ledger-record",
        attemptID: adoptionAttempt.id,
        descendantCommit: adoptedArtifact,
        oldArtifact: "d".repeat(40),
      },
      701,
    )

    db.query(
      "UPDATE runner_plans SET state='integrated',artifact=?,version=version+1 WHERE id=?",
    ).run("3".repeat(40), plans.incorporated!)
    db.query(
      "UPDATE runner_nodes SET state='incorporated',artifact=?,version=version+1 WHERE plan_id=? AND task_id=?",
    ).run("3".repeat(40), plans.incorporated!, tasks.incorporated!.id)

    progressFact(db, {
      taskID: tasks.retry!.id,
      planID: plans.retry!,
      attemptID: failedAttempt.id,
      sessionID: failedAttempt.session_id,
      at: 1_000,
      kind: "usage-snapshot",
      measurementBasis: "cumulative-session-snapshot",
      usage: { input: 100, output: 0, reasoning: null, cacheRead: 0, cacheWrite: 0 },
      secret: "PRIVATE PROMPT MUST NOT LEAVE THE DATABASE",
    })
    progressFact(db, {
      taskID: tasks.retry!.id,
      planID: plans.retry!,
      attemptID: acceptedAttempt.id,
      sessionID: acceptedAttempt.session_id,
      at: 2_000,
      kind: "step",
      measurementBasis: "additive-step-measurement",
      usage: { input: 20, output: null, reasoning: null, cacheRead: null, cacheWrite: null },
      route: { providerID: "openrouter", modelID: "observed-model", variant: "medium" },
    })
    progressFact(db, {
      taskID: tasks.retry!.id,
      planID: plans.retry!,
      attemptID: acceptedAttempt.id,
      sessionID: acceptedAttempt.session_id,
      at: 2_100,
      kind: "step",
      measurementBasis: "additive-step-measurement",
      usage: { input: 30, output: null, reasoning: null, cacheRead: null, cacheWrite: null },
      route: { providerID: "openrouter", modelID: "observed-model", variant: "medium" },
    })

    progressFact(db, {
      taskID: tasks.sharedFeature!.id,
      planID: plans.sharedFeature!,
      attemptID: sharedFeatureAttempt.id,
      sessionID: sharedFeatureAttempt.session_id,
      at: 3_000,
      kind: "usage-snapshot",
      measurementBasis: "cumulative-session-snapshot",
      usage: { input: 70, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })
    const displayedRoute = {
      providerID: "openai",
      modelID: "same-truncated-display-".repeat(20),
      variant: null,
    }
    const observations = Array.from({ length: 27 }, (_, index) => ({
      source: "native-event",
      eventType: "session.step.started",
      at: null,
      messageID: null,
      callID: null,
      route:
        index === 2 || index === 3
          ? displayedRoute
          : {
              providerID: "openai",
              modelID: index === 24 ? "shared-observed-model-b" : "shared-observed-model-a",
              variant: null,
            },
    }))
    progressFact(db, {
      taskID: tasks.sharedFeature!.id,
      planID: plans.sharedFeature!,
      attemptID: sharedFeatureAttempt.id,
      sessionID: sharedFeatureAttempt.session_id,
      at: 3_100,
      kind: "step",
      measurementBasis: null,
      usage: null,
      observations,
    })
    progressFact(db, {
      taskID: tasks.sharedTesting!.id,
      planID: plans.sharedTesting!,
      attemptID: sharedTestingAttempt.id,
      sessionID: sharedTestingAttempt.session_id,
      at: 3_200,
      kind: "step",
      measurementBasis: null,
      usage: null,
      observations: [
        {
          source: "native-event",
          eventType: "session.step.started",
          at: null,
          messageID: null,
          callID: null,
          route: { providerID: "openai", modelID: "shared-observed-model-c", variant: null },
        },
      ],
    })
  })

  repository.recordDisposition(
    {
      taskID: tasks.incorporated!.id,
      requestID: "ledger-disposition-incorporated",
      disposition: "fulfilled",
      reason: "Keep disposition history visible independently of execution acceptance.",
      evidence: [{ kind: "human", reference: "ledger fixture review" }],
      relatedTaskIDs: [],
    },
    { sessionID: "ses-ledger-owner", agent: "lazers-architect" },
  )

  repository.close()
  permitSharedAttemptSession(path, sharedTestingAttempt.id, "ses-shared-session")

  return {
    directory,
    path,
    projectDirectory: directory,
    projectID: PROJECT_ID,
    cursorSecret: CURSOR_SECRET,
    tasks,
    plans,
    attempts: {
      failed: failedAttempt,
      accepted: acceptedAttempt,
      adoption: adoptionAttempt,
      sharedFeature: { ...sharedFeatureAttempt, session_id: "ses-shared-session" },
      sharedTesting: { ...sharedTestingAttempt, session_id: "ses-shared-session" },
    },
    addClassification(taskID: string, expectedRevision: number, kind: TaskKindV1) {
      addLegacyClassification(path, directory, taskID, expectedRevision, kind)
    },
    close() {
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

export function makeLegacyTask(projectDirectory: string, kind: TaskKindV1 | null = null): TaskSpec {
  const task = { id: randomUUID(), kind, createdAt: "2026-10-31T15:00:00.000Z" }
  return taskSpec(projectDirectory, task)
}
