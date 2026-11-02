import type { Database } from "bun:sqlite"
import { canonical, fingerprint } from "../../identity.ts"
import type { TaskRepository } from "../../storage.ts"
import { PlanInput } from "../../runner/schema.ts"
import {
  ProbeActorSchema,
  ProbeDefinitionInputSchema,
  ProbeDefinitionSchema,
  ProbeEligibilityInputSchema,
  ProbeRunSchema,
  ProbeRunStartInputSchema,
  ProbeRunUpdateInputSchema,
} from "./schema.ts"
import type {
  ProbeActor,
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
      this.assertActorOwnsAttempt(actor, attempt)
      if (definition.target.kind === "task" && definition.target.taskID !== attempt.task_id)
        throw new Error("Probe task does not match the original attempt")
      if (definition.target.kind === "task" && parsed.candidate.workspace !== attempt.workspace)
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
      this.assertActorOwnsAttempt(actor, attempt)
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
        satisfied:
          eligible &&
          run.lifecycle === "completed" &&
          run.verdict === "passed" &&
          (run.cleanupState === "complete" || run.cleanupState === "not-required"),
        reasons: uniqueReasons,
        lifecycle: run.lifecycle,
        verdict: run.verdict,
        cleanupState: run.cleanupState,
      }
    })
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
