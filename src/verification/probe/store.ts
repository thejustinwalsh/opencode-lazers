import type { Database } from "bun:sqlite"
import { execFileSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import { canonical, fingerprint } from "../../identity.ts"
import type { TaskRepository } from "../../storage.ts"
import { PlanInput } from "../../runner/schema.ts"
import { RetainedVerificationSchema } from "../../runner/retained-verification/schema.ts"
import type { RetainedVerification } from "../../runner/retained-verification/schema.ts"
import { retainedVerificationProbeBasis } from "../../runner/retained-verification/probe.ts"
import {
  ProbeActorSchema,
  ProbeDefinitionInputSchema,
  ProbeDefinitionSchema,
  ProbeEligibilityInputSchema,
  ProbeRunSchema,
  ProbeRunStartInputSchema,
  ProbeRunUpdateInputSchema,
  ProbeTargetSchema,
} from "./schema.ts"
import type {
  ProbeActor,
  ProbeBasis,
  ProbeCandidate,
  ProbeDefinition,
  ProbeDefinitionInput,
  ProbeRun,
  ProbeRunStartInput,
  ProbeRunUpdateInput,
  ProbeTarget,
} from "./schema.ts"

type DefinitionRow = {
  payload: string
  fingerprint: string
}

type RunRow = {
  payload: string
  fingerprint: string
  request_id: string
  version: number
}

type AttemptIdentity = {
  id: string
  plan_id: string
  task_id: string
  session_id: string
  workspace: string
}

function ensureTables(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS probe_definition_heads (
      project_directory TEXT NOT NULL,
      target_key TEXT NOT NULL,
      definition_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      PRIMARY KEY(project_directory,target_key),
      UNIQUE(project_directory,definition_id)
    );
    CREATE TABLE IF NOT EXISTS probe_definitions (
      project_directory TEXT NOT NULL,
      target_key TEXT NOT NULL,
      definition_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(project_directory,definition_id,revision),
      UNIQUE(project_directory,request_id)
    );
    CREATE TABLE IF NOT EXISTS probe_runs (
      project_directory TEXT NOT NULL,
      run_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      definition_id TEXT NOT NULL,
      definition_revision INTEGER NOT NULL,
      target_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      producer_agent TEXT NOT NULL,
      payload TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_directory,run_id),
      UNIQUE(project_directory,request_id)
    );
    CREATE INDEX IF NOT EXISTS probe_runs_attempt
      ON probe_runs(project_directory,attempt_id,created_at);
    CREATE TABLE IF NOT EXISTS probe_run_updates (
      project_directory TEXT NOT NULL,
      request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      run_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      receipt TEXT NOT NULL,
      PRIMARY KEY(project_directory,request_id)
    );
  `)
}

function targetKey(target: ProbeTarget): string {
  return target.kind === "task" ? `task:${target.taskID}` : `combined:${target.planID}`
}

function decodeDefinition(payload: string): ProbeDefinition {
  return ProbeDefinitionSchema.parse(JSON.parse(payload))
}

function decodeRun(payload: string): ProbeRun {
  return ProbeRunSchema.parse(JSON.parse(payload))
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right)
}

function pathsOverlap(left: string, right: string): boolean {
  const first = resolve(left)
  const second = resolve(right)
  const contains = (parent: string, child: string) => {
    const rel = relative(parent, child)
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))
  }
  return contains(first, second) || contains(second, first)
}

function assertArchitect(actor: ProbeActor): void {
  if (actor.agent !== "architect")
    throw new Error("Only the authenticated Architect can author probe definitions")
}

function validateObservationProvenance(
  observations: ProbeRunStartInput["observations"] | ProbeRunUpdateInput["observations"],
  actor: ProbeActor,
): void {
  for (const observation of observations) {
    if (observation.source === "architect-judgment" && actor.agent !== "architect")
      throw new Error("Worker observations cannot claim Architect judgment provenance")
    if (observation.source === "worker-commentary" && actor.agent === "architect")
      throw new Error("Architect observations cannot claim worker commentary provenance")
  }
}

export type ProbeDefinitionWrite =
  | { status: "created" | "revised" | "replayed"; definition: ProbeDefinition }
  | { status: "conflict"; definitionID: string | null; message: string }

export type ProbeRunWrite =
  | { status: "started" | "replayed"; run: ProbeRun }
  | { status: "conflict"; runID: string | null; message: string }

export type ProbeRunUpdate =
  | { status: "updated" | "replayed"; run: ProbeRun }
  | { status: "conflict"; runID: string; message: string }

export type ProbeEligibility = {
  runID: string
  eligible: boolean
  /** Current completed product pass; cleanup is an independent obligation. */
  satisfied: boolean
  reasons: string[]
  lifecycle: ProbeRun["lifecycle"]
  verdict: ProbeRun["verdict"]
  cleanupState: ProbeRun["cleanupState"]
}

/** Durable policy and receipts only; this repository never schedules or dispatches probes. */
export class ProbeRepository {
  constructor(readonly repository: TaskRepository) {}

  define(input: unknown, actorInput: unknown): ProbeDefinitionWrite {
    const parsed = ProbeDefinitionInputSchema.parse(input)
    const actor = ProbeActorSchema.parse(actorInput)
    assertArchitect(actor)
    const payloadFingerprint = fingerprint({ input: parsed, actor })
    const key = targetKey(parsed.target)

    return this.repository.atomic((db) => {
      ensureTables(db)
      const previous = db
        .query<DefinitionRow, [string, string]>(
          "SELECT payload,fingerprint FROM probe_definitions WHERE project_directory=? AND request_id=?",
        )
        .get(this.repository.projectDirectory, parsed.requestID)
      if (previous) {
        if (previous.fingerprint !== payloadFingerprint)
          return {
            status: "conflict" as const,
            definitionID: parsed.definitionID ?? null,
            message: "requestID already identifies different probe definition content",
          }
        return { status: "replayed" as const, definition: decodeDefinition(previous.payload) }
      }

      const acceptance = this.acceptanceForTarget(db, parsed.target)
      this.validateCoverage(
        parsed,
        acceptance.items.map((item) => item.id),
      )
      const head = db
        .query<{ definition_id: string; revision: number }, [string, string]>(
          "SELECT definition_id,revision FROM probe_definition_heads WHERE project_directory=? AND target_key=?",
        )
        .get(this.repository.projectDirectory, key)

      let definitionID: string
      let revision: number
      let status: "created" | "revised"
      if (parsed.definitionID === undefined) {
        if (head)
          throw new Error(
            "Probe definition already exists; revise it with its ID and expected revision",
          )
        definitionID = crypto.randomUUID()
        revision = 1
        status = "created"
      } else {
        if (!head || head.definition_id !== parsed.definitionID)
          throw new Error("Probe definition does not own this task or plan target")
        if (head.revision !== parsed.expectedRevision)
          throw new Error("Probe definition revision is stale")
        definitionID = head.definition_id
        revision = head.revision + 1
        status = "revised"
      }

      const createdAt = Date.now()
      const definition = ProbeDefinitionSchema.parse({
        schemaVersion: 1,
        definitionID,
        revision,
        target: parsed.target,
        acceptanceBasis: {
          revision: acceptance.revision,
        },
        scenarios: parsed.scenarios,
        notApplicable: parsed.notApplicable,
        authoredBy: actor,
        createdAt,
      })
      const payload = JSON.stringify(definition)

      if (!head) {
        db.query(
          "INSERT INTO probe_definition_heads(project_directory,target_key,definition_id,revision) VALUES(?,?,?,?)",
        ).run(this.repository.projectDirectory, key, definitionID, revision)
      } else {
        db.query(
          "UPDATE probe_definition_heads SET revision=? WHERE project_directory=? AND target_key=? AND definition_id=? AND revision=?",
        ).run(revision, this.repository.projectDirectory, key, definitionID, head.revision)
      }
      db.query(
        `INSERT INTO probe_definitions
         (project_directory,target_key,definition_id,revision,request_id,fingerprint,payload,created_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        key,
        definitionID,
        revision,
        parsed.requestID,
        payloadFingerprint,
        payload,
        createdAt,
      )
      return { status, definition }
    })
  }

  definition(definitionID: string, revision?: number): ProbeDefinition | undefined {
    return this.repository.atomic((db) => {
      ensureTables(db)
      const row =
        revision === undefined
          ? db
              .query<{ payload: string }, [string, string]>(
                `SELECT d.payload FROM probe_definitions d
                 JOIN probe_definition_heads h ON h.project_directory=d.project_directory
                   AND h.target_key=d.target_key AND h.definition_id=d.definition_id AND h.revision=d.revision
                 WHERE d.project_directory=? AND d.definition_id=?`,
              )
              .get(this.repository.projectDirectory, definitionID)
          : db
              .query<{ payload: string }, [string, string, number]>(
                "SELECT payload FROM probe_definitions WHERE project_directory=? AND definition_id=? AND revision=?",
              )
              .get(this.repository.projectDirectory, definitionID, revision)
      return row ? decodeDefinition(row.payload) : undefined
    })
  }

  /** Read the current project-owned definition for an exact task or plan target. */
  definitionForTarget(targetInput: unknown): ProbeDefinition | undefined {
    const target = ProbeTargetSchema.parse(targetInput)
    return this.repository.atomic((db) => {
      ensureTables(db)
      const head = db
        .query<{ definition_id: string; revision: number }, [string, string]>(
          "SELECT definition_id,revision FROM probe_definition_heads WHERE project_directory=? AND target_key=?",
        )
        .get(this.repository.projectDirectory, targetKey(target))
      return head ? this.definitionIn(db, head.definition_id, head.revision) : undefined
    })
  }

  startRun(input: unknown, actorInput: unknown): ProbeRunWrite {
    const parsed = ProbeRunStartInputSchema.parse(input)
    const actor = ProbeActorSchema.parse(actorInput)
    validateObservationProvenance(parsed.observations, actor)
    const payloadFingerprint = fingerprint({ input: parsed, actor })

    return this.repository.atomic((db) => {
      ensureTables(db)
      const previous = db
        .query<RunRow, [string, string]>(
          "SELECT payload,fingerprint,request_id,version FROM probe_runs WHERE project_directory=? AND request_id=?",
        )
        .get(this.repository.projectDirectory, parsed.requestID)
      if (previous) {
        if (previous.fingerprint !== payloadFingerprint)
          return {
            status: "conflict" as const,
            runID: null,
            message: "requestID already identifies different probe run content",
          }
        return { status: "replayed" as const, run: decodeRun(previous.payload) }
      }

      const definition = this.definitionIn(db, parsed.definitionID, parsed.definitionRevision)
      if (!definition) throw new Error("Probe definition revision not found in this project")
      const key = targetKey(definition.target)
      const head = db
        .query<{ definition_id: string; revision: number }, [string, string]>(
          "SELECT definition_id,revision FROM probe_definition_heads WHERE project_directory=? AND target_key=?",
        )
        .get(this.repository.projectDirectory, key)
      if (head?.definition_id !== definition.definitionID || head.revision !== definition.revision)
        throw new Error("Probe definition is no longer current")
      const currentAcceptance = this.acceptanceForTarget(db, definition.target)
      if (definition.acceptanceBasis.revision !== currentAcceptance.revision)
        throw new Error("Acceptance changed; revise the probe definition before recording a run")
      const scenario = definition.scenarios.find((item) => item.id === parsed.scenarioID)
      if (!scenario)
        throw new Error("Run references no required scenario; not-applicable policy is not a run")

      const attempt = this.attemptIn(db, parsed.attemptID)
      if (definition.target.kind === "task" && definition.target.taskID !== attempt.task_id)
        throw new Error("Probe task does not match the original attempt")
      const retainedOperation = this.retainedOperationForBasis(
        db,
        definition.target,
        attempt,
        parsed,
      )
      if (retainedOperation) {
        this.assertRetainedProbeBinding(db, retainedOperation, definition.target, parsed, attempt)
        if (actor.sessionID !== retainedOperation.owner || actor.agent !== "architect")
          throw new Error("Retained probes must be recorded by the current Architect owner")
      } else {
        this.assertActorOwnsAttempt(actor, attempt)
      }
      if (
        !retainedOperation &&
        definition.target.kind === "task" &&
        parsed.candidate.workspace !== attempt.workspace
      )
        throw new Error("Task probe candidate workspace must match the original attempt")
      if (
        definition.target.kind === "combined-candidate" &&
        definition.target.planID !== attempt.plan_id
      )
        throw new Error("Combined candidate plan does not own the original attempt")

      const now = Date.now()
      const run = ProbeRunSchema.parse({
        schemaVersion: 1,
        runID: crypto.randomUUID(),
        requestID: parsed.requestID,
        version: 1,
        definitionID: definition.definitionID,
        definitionRevision: definition.revision,
        scenarioID: scenario.id,
        acceptanceIDs: scenario.acceptanceIDs,
        target: definition.target,
        taskID: attempt.task_id,
        planID: attempt.plan_id,
        attemptID: attempt.id,
        sessionID: attempt.session_id,
        producer: actor,
        candidate: parsed.candidate,
        procedure: scenario.procedure,
        inputs: parsed.inputs,
        environment: parsed.environment,
        capabilities: parsed.capabilities,
        setupReferences: parsed.setupReferences,
        fixtureReferences: parsed.fixtureReferences,
        actions: parsed.actions,
        observations: parsed.observations,
        evidenceReferences: parsed.evidenceReferences,
        timing: parsed.timing,
        usage: parsed.usage,
        lifecycle: "pending",
        verdict: null,
        cleanupState: parsed.cleanupState,
        createdAt: now,
        updatedAt: now,
      })
      const payload = JSON.stringify(run)
      db.query(
        `INSERT INTO probe_runs
         (project_directory,run_id,request_id,fingerprint,definition_id,definition_revision,target_key,
          task_id,plan_id,attempt_id,session_id,producer_agent,payload,version,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        run.runID,
        parsed.requestID,
        payloadFingerprint,
        run.definitionID,
        run.definitionRevision,
        key,
        run.taskID,
        run.planID,
        run.attemptID,
        run.sessionID,
        actor.agent,
        payload,
        run.version,
        now,
        now,
      )
      return { status: "started" as const, run }
    })
  }

  updateRun(input: unknown, actorInput: unknown): ProbeRunUpdate {
    const parsed = ProbeRunUpdateInputSchema.parse(input)
    const actor = ProbeActorSchema.parse(actorInput)
    validateObservationProvenance(parsed.observations, actor)
    const payloadFingerprint = fingerprint({ input: parsed, actor })

    return this.repository.atomic((db) => {
      ensureTables(db)
      const previous = db
        .query<{ fingerprint: string; receipt: string }, [string, string]>(
          "SELECT fingerprint,receipt FROM probe_run_updates WHERE project_directory=? AND request_id=?",
        )
        .get(this.repository.projectDirectory, parsed.requestID)
      if (previous) {
        if (previous.fingerprint !== payloadFingerprint)
          return {
            status: "conflict" as const,
            runID: parsed.runID,
            message: "requestID already identifies different probe run update content",
          }
        return { status: "replayed" as const, run: decodeRun(previous.receipt) }
      }

      const row = db
        .query<RunRow, [string, string]>(
          "SELECT payload,fingerprint,request_id,version FROM probe_runs WHERE project_directory=? AND run_id=?",
        )
        .get(this.repository.projectDirectory, parsed.runID)
      if (!row) throw new Error("Probe run not found in this project")
      const current = decodeRun(row.payload)
      this.assertRunOwner(actor, current)
      const attempt = this.attemptIn(db, current.attemptID)
      this.assertRunActorIn(db, current, actor, attempt)
      if (
        attempt.task_id !== current.taskID ||
        attempt.plan_id !== current.planID ||
        attempt.session_id !== current.sessionID
      )
        throw new Error("Probe run no longer matches its original attempt")
      if (current.version !== parsed.expectedVersion) throw new Error("Probe run version is stale")
      this.validateTransition(current, parsed)

      const updated = ProbeRunSchema.parse({
        ...current,
        version: current.version + 1,
        lifecycle: parsed.lifecycle,
        verdict: parsed.verdict,
        actions: parsed.actions,
        observations: parsed.observations,
        evidenceReferences: parsed.evidenceReferences,
        timing: parsed.timing,
        usage: parsed.usage,
        cleanupState: parsed.cleanupState,
        updatedAt: Math.max(Date.now(), current.updatedAt),
      })
      const receipt = JSON.stringify(updated)
      const changed = db
        .query(
          `UPDATE probe_runs SET payload=?,version=?,updated_at=?
           WHERE project_directory=? AND run_id=? AND version=?`,
        )
        .run(
          receipt,
          updated.version,
          updated.updatedAt,
          this.repository.projectDirectory,
          current.runID,
          current.version,
        ).changes
      if (changed !== 1) throw new Error("Probe run changed concurrently")
      db.query(
        `INSERT INTO probe_run_updates(project_directory,request_id,fingerprint,run_id,version,receipt)
         VALUES(?,?,?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        parsed.requestID,
        payloadFingerprint,
        updated.runID,
        updated.version,
        receipt,
      )
      return { status: "updated" as const, run: updated }
    })
  }

  run(runID: string): ProbeRun | undefined {
    return this.repository.atomic((db) => {
      ensureTables(db)
      const row = db
        .query<{ payload: string }, [string, string]>(
          "SELECT payload FROM probe_runs WHERE project_directory=? AND run_id=?",
        )
        .get(this.repository.projectDirectory, runID)
      return row ? decodeRun(row.payload) : undefined
    })
  }

  runsForAttempt(attemptID: string): ProbeRun[] {
    return this.repository.atomic((db) => {
      ensureTables(db)
      return db
        .query<{ payload: string }, [string, string]>(
          `SELECT payload FROM probe_runs WHERE project_directory=? AND attempt_id=?
           ORDER BY created_at,run_id`,
        )
        .all(this.repository.projectDirectory, attemptID)
        .map((row) => decodeRun(row.payload))
    })
  }

  /** Compare against current identities resolved by the trusted runtime, not content digests. */
  eligibility(runID: string, currentInput: unknown): ProbeEligibility {
    const current = ProbeEligibilityInputSchema.parse(currentInput)
    return this.repository.atomic((db) => {
      ensureTables(db)
      const row = db
        .query<{ payload: string }, [string, string]>(
          "SELECT payload FROM probe_runs WHERE project_directory=? AND run_id=?",
        )
        .get(this.repository.projectDirectory, runID)
      if (!row) throw new Error("Probe run not found in this project")
      const run = decodeRun(row.payload)
      const reasons: string[] = []
      if (!same(run.candidate, current.candidate)) reasons.push("candidate-changed")
      if (!same(run.procedure, current.procedure)) reasons.push("procedure-changed")
      if (!same(run.inputs, current.inputs)) reasons.push("inputs-changed")
      if (!same(run.environment, current.environment)) reasons.push("environment-changed")

      const key = targetKey(run.target)
      const head = db
        .query<{ definition_id: string; revision: number }, [string, string]>(
          "SELECT definition_id,revision FROM probe_definition_heads WHERE project_directory=? AND target_key=?",
        )
        .get(this.repository.projectDirectory, key)
      const latest = head ? this.definitionIn(db, head.definition_id, head.revision) : undefined
      if (
        !latest ||
        latest.definitionID !== run.definitionID ||
        latest.revision !== run.definitionRevision
      )
        reasons.push("definition-changed")
      if (latest) {
        const scenario = latest.scenarios.find((item) => item.id === run.scenarioID)
        if (!scenario || !same(scenario.procedure, current.procedure))
          reasons.push("procedure-definition-changed")
      }
      if (run.inputs.recordID.startsWith("retained-verification:")) {
        try {
          const attempt = this.attemptIn(db, run.attemptID)
          const operation = this.retainedOperationForBasis(db, run.target, attempt, run)
          if (!operation) reasons.push("retained-verification-changed")
          else this.assertRetainedProbeBinding(db, operation, run.target, run, attempt)
        } catch {
          reasons.push("retained-verification-changed")
        }
      }
      try {
        const acceptance = this.acceptanceForTarget(db, run.target)
        if (!latest || latest.acceptanceBasis.revision !== acceptance.revision)
          reasons.push("acceptance-changed")
      } catch {
        reasons.push("acceptance-changed")
      }

      const uniqueReasons = [...new Set(reasons)]
      const eligible = uniqueReasons.length === 0
      return {
        runID: run.runID,
        eligible,
        satisfied: eligible && run.lifecycle === "completed" && run.verdict === "passed",
        reasons: uniqueReasons,
        lifecycle: run.lifecycle,
        verdict: run.verdict,
        cleanupState: run.cleanupState,
      }
    })
  }

  private retainedOperationIn(db: Database, operationID: string): RetainedVerification | undefined {
    const row = db
      .query<{ payload: string }, [string, string]>(
        "SELECT payload FROM runner_retained_verifications WHERE project_directory=? AND id=?",
      )
      .get(this.repository.projectDirectory, operationID)
    return row ? RetainedVerificationSchema.parse(JSON.parse(row.payload)) : undefined
  }

  private retainedOperationForBasis(
    db: Database,
    target: ProbeTarget,
    attempt: AttemptIdentity,
    input: { inputs: ProbeBasis },
  ): RetainedVerification | undefined {
    const marker = input.inputs.recordID
    if (!marker.startsWith("retained-verification:")) return undefined
    const match = /^retained-verification:([0-9a-f-]{36}):inputs$/.exec(marker)
    if (!match) throw new Error("Malformed retained verification probe basis")
    const operation = this.retainedOperationIn(db, match[1]!)
    if (!operation) throw new Error("Retained verification operation is unavailable")
    if (
      operation.attemptID !== attempt.id ||
      operation.taskID !== attempt.task_id ||
      operation.planID !== attempt.plan_id
    )
      throw new Error("Retained verification operation does not own this original attempt")
    if (
      target.kind === "task"
        ? target.taskID !== operation.taskID
        : target.planID !== operation.planID
    )
      throw new Error("Retained verification target does not match its operation")
    return operation
  }

  private assertRunActorIn(
    db: Database,
    run: ProbeRun,
    actor: ProbeActor,
    attempt: AttemptIdentity,
  ): void {
    if (
      run.taskID !== attempt.task_id ||
      run.planID !== attempt.plan_id ||
      run.attemptID !== attempt.id ||
      run.sessionID !== attempt.session_id
    )
      throw new Error("Probe run no longer matches its original attempt")
    const operation = this.retainedOperationForBasis(db, run.target, attempt, run)
    if (!operation) {
      this.assertActorOwnsAttempt(actor, attempt)
      return
    }
    this.assertRetainedProbeBinding(db, operation, run.target, run, attempt)
    if (actor.sessionID !== operation.owner || actor.agent !== "architect")
      throw new Error("Retained probe updates must come from the current Architect owner")
  }

  /** Resource lifecycle shares probe authorization rather than trusting caller-supplied ownership. */
  assertResourceActor(runID: string, actorInput: unknown): ProbeRun {
    const actor = ProbeActorSchema.parse(actorInput)
    return this.repository.atomic((db) => {
      ensureTables(db)
      const row = db
        .query<{ payload: string }, [string, string]>(
          "SELECT payload FROM probe_runs WHERE project_directory=? AND run_id=?",
        )
        .get(this.repository.projectDirectory, runID)
      if (!row) throw new Error("Probe run not found in this project")
      const run = decodeRun(row.payload)
      const attempt = this.attemptIn(db, run.attemptID)
      this.assertRunOwner(actor, run)
      this.assertRunActorIn(db, run, actor, attempt)
      if (
        attempt.task_id !== run.taskID ||
        attempt.plan_id !== run.planID ||
        attempt.session_id !== run.sessionID
      )
        throw new Error("Probe run no longer matches its original attempt")
      return run
    })
  }

  private assertRetainedProbeBinding(
    db: Database,
    operation: RetainedVerification,
    target: ProbeTarget,
    input: { candidate: ProbeCandidate; inputs: ProbeBasis; environment: ProbeBasis },
    attempt: AttemptIdentity,
  ): void {
    const phase = target.kind === "task" ? "task" : "combined"
    const workspace = phase === "task" ? operation.taskWorkspace : operation.combinedWorkspace
    const workspaceState =
      phase === "task" ? operation.taskWorkspaceState : operation.combinedWorkspaceState
    const activeStates = [
      "pending",
      "task-checks",
      "combined-checks",
      "waiting-human",
      "waiting-human-combined",
    ]
    if (
      input.inputs.recordID !== `retained-verification:${operation.id}:inputs` ||
      !activeStates.includes(operation.state) ||
      workspaceState !== "owned" ||
      !workspace ||
      operation.projectDirectory !== this.repository.projectDirectory ||
      operation.taskID !== attempt.task_id ||
      operation.planID !== attempt.plan_id ||
      operation.attemptID !== attempt.id ||
      operation.originalSessionID !== attempt.session_id ||
      (target.kind === "task" && target.taskID !== operation.taskID) ||
      (target.kind === "combined-candidate" && target.planID !== operation.planID)
    )
      throw new Error("Retained probe is not bound to the current owned verification generation")
    const basis = retainedVerificationProbeBasis(operation, phase)
    if (
      !same(input.candidate, basis.candidate) ||
      !same(input.inputs, basis.inputs) ||
      !same(input.environment, basis.environment)
    )
      throw new Error("Retained probe candidate, inputs or environment are stale")
    const plan = db
      .query<
        { owner: string; revision: number; version: number; state: string; body: string },
        [string, string]
      >(
        "SELECT owner,revision,version,state,body FROM runner_plans WHERE id=? AND project_directory=?",
      )
      .get(operation.planID, this.repository.projectDirectory)
    const controlEpoch = db
      .query<{ epoch: number }, [string]>(
        `SELECT COALESCE(MAX(id),0) AS epoch FROM runner_transitions
         WHERE plan_id=? AND task_id IS NULL AND event IN (
           'OWNER_REASSIGNED','OWNER_CONTINUED','OWNER_CONTINUATION_ROLLED_BACK','CANCEL_REQUESTED'
         )`,
      )
      .get(operation.planID)!.epoch
    const latestAttempt = db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM runner_attempts WHERE plan_id=? AND task_id=? ORDER BY number DESC LIMIT 1",
      )
      .get(operation.planID, operation.taskID)
    const task = this.repository.get(operation.taskID)
    if (
      !plan ||
      plan.owner !== operation.owner ||
      plan.version !== operation.planVersion ||
      plan.revision !== operation.planRevision ||
      !["blocked", "accepted", "cleanup-blocked"].includes(plan.state) ||
      controlEpoch !== operation.ownerEpoch ||
      !task ||
      task.revision !== operation.taskRevision ||
      task.provenance.projectDirectory !== operation.projectDirectory ||
      latestAttempt?.id !== operation.attemptID
    )
      throw new Error("Retained probe owner, plan, task or latest attempt changed")
    const planInput = PlanInput.parse(JSON.parse(plan.body))
    if (
      planInput.nodes.find((node) => node.taskID === operation.taskID)?.revision !==
      operation.taskRevision
    )
      throw new Error("Retained probe task revision changed in the current plan")
    const latestGeneration = db
      .query<{ generation: number | null }, [string, string, string]>(
        "SELECT MAX(generation) AS generation FROM runner_retained_verifications WHERE project_directory=? AND plan_id=? AND task_id=?",
      )
      .get(operation.projectDirectory, operation.planID, operation.taskID)?.generation
    if (latestGeneration !== operation.generation)
      throw new Error("Retained verification generation is no longer current")
    const canonicalCandidate = realpathSync(workspace)
    const canonicalOriginal = realpathSync(attempt.workspace)
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: canonicalCandidate,
      encoding: "utf8",
    }).trim()
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: canonicalCandidate,
      encoding: "utf8",
    }).trim()
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: canonicalCandidate,
      encoding: "utf8",
    })
    const conflicts = execFileSync("git", ["ls-files", "-u", "-z"], {
      cwd: canonicalCandidate,
      encoding: "utf8",
    })
    if (
      !existsSync(canonicalCandidate) ||
      canonicalCandidate !== workspace ||
      canonicalCandidate === canonicalOriginal ||
      pathsOverlap(canonicalCandidate, canonicalOriginal) ||
      top !== canonicalCandidate ||
      head !== basis.candidate.revision ||
      status ||
      conflicts
    )
      throw new Error("Retained probe checkout is not the exact distinct clean candidate")
  }

  private validateCoverage(input: ProbeDefinitionInput, acceptanceIDs: string[]): void {
    const declared = new Set(acceptanceIDs)
    const required = new Set<string>()
    for (const scenario of input.scenarios) {
      for (const id of scenario.acceptanceIDs) {
        if (!declared.has(id)) throw new Error(`Unknown acceptance assertion ${id}`)
        required.add(id)
      }
    }
    const notApplicable = new Set<string>()
    for (const item of input.notApplicable) {
      if (!declared.has(item.acceptanceID))
        throw new Error(`Unknown acceptance assertion ${item.acceptanceID}`)
      if (required.has(item.acceptanceID))
        throw new Error(
          `Acceptance assertion ${item.acceptanceID} cannot be probed and not applicable`,
        )
      notApplicable.add(item.acceptanceID)
    }
    const uncovered = acceptanceIDs.filter((id) => !required.has(id) && !notApplicable.has(id))
    if (uncovered.length)
      throw new Error(
        `Every acceptance assertion needs a probe scenario or Architect rationale: ${uncovered.join(", ")}`,
      )
  }

  private acceptanceForTarget(
    db: Database,
    target: ProbeTarget,
  ): { revision: number; items: Array<{ id: string; assertion: string; evidence: unknown[] }> } {
    if (target.kind === "task") {
      const task = this.repository.get(target.taskID)
      if (!task) throw new Error("Task not found in this project")
      return { revision: task.revision, items: task.proposal.acceptance }
    }

    const row = db
      .query<{ revision: number; body: string }, [string, string]>(
        "SELECT revision,body FROM runner_plans WHERE id=? AND project_directory=?",
      )
      .get(target.planID, this.repository.projectDirectory)
    if (!row) throw new Error("Plan not found in this project")
    const plan = PlanInput.parse(JSON.parse(row.body))
    const nodes = db
      .query<{ count: number; owned: number }, [string, string]>(
        `SELECT COUNT(n.task_id) AS count,COUNT(t.id) AS owned
         FROM runner_nodes n LEFT JOIN tasks t
           ON t.id=n.task_id AND t.project_directory=?
         WHERE n.plan_id=?`,
      )
      .get(this.repository.projectDirectory, target.planID)!
    if (nodes.count !== nodes.owned || nodes.count !== plan.nodes.length)
      throw new Error("Plan contains a task outside this repository")
    return { revision: row.revision, items: plan.acceptance }
  }

  private definitionIn(
    db: Database,
    definitionID: string,
    revision: number,
  ): ProbeDefinition | undefined {
    const row = db
      .query<{ payload: string }, [string, string, number]>(
        "SELECT payload FROM probe_definitions WHERE project_directory=? AND definition_id=? AND revision=?",
      )
      .get(this.repository.projectDirectory, definitionID, revision)
    return row ? decodeDefinition(row.payload) : undefined
  }

  private attemptIn(db: Database, attemptID: string): AttemptIdentity {
    const attempt = db
      .query<AttemptIdentity, [string, string]>(
        `SELECT a.id,a.plan_id,a.task_id,a.session_id,a.workspace
         FROM runner_attempts a
         JOIN runner_plans p ON p.id=a.plan_id AND p.project_directory=?
         JOIN runner_nodes n ON n.plan_id=a.plan_id AND n.task_id=a.task_id
         JOIN tasks t ON t.id=a.task_id AND t.project_directory=p.project_directory
         WHERE a.id=?`,
      )
      .get(this.repository.projectDirectory, attemptID)
    if (!attempt) throw new Error("Attempt not found in this project or lacks task ownership")
    return attempt
  }

  private assertActorOwnsAttempt(actor: ProbeActor, attempt: AttemptIdentity): void {
    if (actor.sessionID !== attempt.session_id)
      throw new Error("Probe writes must come from the original attempt session")
  }

  private assertRunOwner(actor: ProbeActor, run: ProbeRun): void {
    if (actor.sessionID !== run.producer.sessionID || actor.agent !== run.producer.agent)
      throw new Error("Probe run belongs to another actor")
  }

  private validateTransition(current: ProbeRun, update: ProbeRunUpdateInput): void {
    const allowed: Record<ProbeRun["lifecycle"], ProbeRun["lifecycle"][]> = {
      pending: ["pending", "interrupted", "cancelled", "completed"],
      interrupted: ["pending", "interrupted", "cancelled", "completed"],
      cancelled: ["cancelled"],
      completed: ["completed"],
    }
    if (!allowed[current.lifecycle].includes(update.lifecycle))
      throw new Error(
        `Invalid probe lifecycle transition ${current.lifecycle} -> ${update.lifecycle}`,
      )
    if (current.lifecycle === "completed" && update.verdict !== current.verdict)
      throw new Error("A completed probe verdict is immutable")
  }
}
