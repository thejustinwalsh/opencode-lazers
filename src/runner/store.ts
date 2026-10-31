import type { Database } from "bun:sqlite"
import { fingerprint } from "../identity.ts"
import type { TaskRepository } from "../storage.ts"
import { scopePatternsConflict } from "./artifacts.ts"
import { initialSnapshot, machineVersion, transition } from "./machine.ts"
import { PlanInput } from "./schema.ts"
import type { Execution, Finding, TaskState } from "./schema.ts"

export type PlanRow = {
  id: string
  owner: string
  revision: number
  version: number
  state: string
  body: string
  model: string | null
  reason: string | null
  artifact: string | null
}
export type NodeRow = {
  plan_id: string
  task_id: string
  ordinal: number
  state: TaskState
  version: number
  reason: string | null
  artifact: string | null
  snapshot: string
  machine_version: string
}
export type AttemptRow = {
  id: string
  plan_id: string
  task_id: string
  number: number
  session_id: string
  message_id: string
  workspace: string
  base_commit: string
  artifact: string | null
  policy: string
  state: string
  started_at: number
  token_count: number | null
  tool_count: number
  retry_count: number
  cost: number | null
}
export type EffectRow = {
  id: string
  plan_id: string
  task_id: string | null
  attempt_id: string | null
  kind: string
  state: string
  payload: string
  receipt: string | null
  fence: number
}

export class RunnerStore {
  constructor(readonly repository: TaskRepository) {
    repository.atomic((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS runner_plans (
        id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, owner TEXT NOT NULL,
        revision INTEGER NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL,
        body TEXT NOT NULL, model TEXT, reason TEXT, artifact TEXT
      );
      CREATE INDEX IF NOT EXISTS runner_plans_project ON runner_plans(project_directory, state);
      CREATE TABLE IF NOT EXISTS runner_plan_revisions (
        plan_id TEXT NOT NULL REFERENCES runner_plans(id), revision INTEGER NOT NULL,
        body TEXT NOT NULL, owner TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(plan_id,revision)
      );
      CREATE TABLE IF NOT EXISTS runner_nodes (
        plan_id TEXT NOT NULL REFERENCES runner_plans(id), task_id TEXT NOT NULL REFERENCES tasks(id),
        spec_revision INTEGER NOT NULL, ordinal INTEGER NOT NULL, state TEXT NOT NULL,
        version INTEGER NOT NULL, reason TEXT, artifact TEXT, snapshot TEXT NOT NULL, machine_version TEXT NOT NULL,
        PRIMARY KEY(plan_id,task_id), UNIQUE(task_id,spec_revision)
      );
      CREATE TABLE IF NOT EXISTS runner_dependencies (
        plan_id TEXT NOT NULL, prerequisite TEXT NOT NULL, successor TEXT NOT NULL,
        PRIMARY KEY(plan_id, prerequisite, successor),
        FOREIGN KEY(plan_id,prerequisite) REFERENCES runner_nodes(plan_id,task_id),
        FOREIGN KEY(plan_id,successor) REFERENCES runner_nodes(plan_id,task_id)
      );
      CREATE TABLE IF NOT EXISTS runner_relations (
        project_directory TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), other_task_id TEXT NOT NULL REFERENCES tasks(id),
        relation TEXT NOT NULL, rationale TEXT NOT NULL, owner TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(project_directory,task_id,other_task_id)
      );
      CREATE TABLE IF NOT EXISTS runner_commands (
        project_directory TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        receipt TEXT NOT NULL, PRIMARY KEY(project_directory,request_id)
      );
      CREATE TABLE IF NOT EXISTS runner_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL REFERENCES runner_plans(id), task_id TEXT,
        version INTEGER NOT NULL, event TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_leases (
        project_directory TEXT PRIMARY KEY, owner TEXT NOT NULL, fence INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_attempts (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, task_id TEXT NOT NULL, number INTEGER NOT NULL,
        session_id TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL UNIQUE, workspace TEXT NOT NULL, base_commit TEXT NOT NULL,
        artifact TEXT, policy TEXT NOT NULL, state TEXT NOT NULL, started_at INTEGER NOT NULL,
        token_count INTEGER, tool_count INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0, cost REAL,
        UNIQUE(task_id,number), FOREIGN KEY(plan_id,task_id) REFERENCES runner_nodes(plan_id,task_id)
      );
      CREATE TABLE IF NOT EXISTS runner_effects (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES runner_plans(id), task_id TEXT, attempt_id TEXT REFERENCES runner_attempts(id),
        kind TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT, fence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_evidence (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES runner_plans(id), task_id TEXT, attempt_id TEXT REFERENCES runner_attempts(id),
        assertion_id TEXT, kind TEXT NOT NULL, artifact TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_outbox (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES runner_plans(id), session_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, state TEXT NOT NULL, resume INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_audits (
        id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, watermark INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `),
    )
  }
  atomic<T>(run: (db: Database) => T): T {
    return this.repository.atomic(run)
  }
  plan(id: string) {
    return this.atomic((db) =>
      db
        .query<PlanRow, [string, string]>(
          "SELECT * FROM runner_plans WHERE id=? AND project_directory=?",
        )
        .get(id, this.repository.projectDirectory),
    )
  }
  nodes(planID: string) {
    if (!this.plan(planID)) throw new Error("Plan not found")
    return this.atomic((db) =>
      db
        .query<NodeRow, [string]>("SELECT * FROM runner_nodes WHERE plan_id=? ORDER BY ordinal")
        .all(planID),
    )
  }
  plans() {
    return this.atomic((db) =>
      db
        .query<PlanRow, [string]>(
          "SELECT * FROM runner_plans WHERE project_directory=? ORDER BY rowid LIMIT 1000",
        )
        .all(this.repository.projectDirectory),
    )
  }
  execution(taskID: string): Execution | undefined {
    const node = this.atomic((db) =>
      db
        .query<NodeRow, [string, string]>(
          "SELECT n.* FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id WHERE p.project_directory=? AND n.task_id=?",
        )
        .get(this.repository.projectDirectory, taskID),
    )
    if (!node) return undefined
    const waitingOn = this.atomic((db) =>
      db
        .query<{ prerequisite: string }, [string, string]>(
          "SELECT d.prerequisite FROM runner_dependencies d JOIN runner_nodes n ON n.plan_id=d.plan_id AND n.task_id=d.prerequisite WHERE d.plan_id=? AND d.successor=? AND n.state!='accepted'",
        )
        .all(node.plan_id, taskID)
        .map((r) => r.prerequisite),
    )
    return {
      planID: node.plan_id,
      taskID,
      state: node.state,
      version: node.version,
      reason: node.reason,
      waitingOn,
    }
  }
  command<T>(requestID: string, input: unknown, run: (db: Database) => T): T {
    return this.atomic((db) => {
      const hash = fingerprint(input)
      const previous = db
        .query<{ fingerprint: string; receipt: string }, [string, string]>(
          "SELECT * FROM runner_commands WHERE project_directory=? AND request_id=?",
        )
        .get(this.repository.projectDirectory, requestID)
      if (previous) {
        if (previous.fingerprint !== hash) throw new Error("Request identity conflict")
        return JSON.parse(previous.receipt) as T
      }
      const result = run(db)
      db.query("INSERT INTO runner_commands VALUES(?,?,?,?)").run(
        this.repository.projectDirectory,
        requestID,
        hash,
        JSON.stringify(result),
      )
      this.repository.changed()
      return result
    })
  }

  priorCommand<T>(requestID: string, input: unknown): T | undefined {
    return this.atomic((db) => {
      const previous = db
        .query<{ fingerprint: string; receipt: string }, [string, string]>(
          "SELECT fingerprint,receipt FROM runner_commands WHERE project_directory=? AND request_id=?",
        )
        .get(this.repository.projectDirectory, requestID)
      if (!previous) return undefined
      if (previous.fingerprint !== fingerprint(input)) throw new Error("Request identity conflict")
      return JSON.parse(previous.receipt) as T
    })
  }

  renew(owner: string, fence: number, now = Date.now()) {
    return this.atomic(
      (db) =>
        db
          .query(
            "UPDATE runner_leases SET expires_at=? WHERE project_directory=? AND owner=? AND fence=?",
          )
          .run(now + 30000, this.repository.projectDirectory, owner, fence).changes === 1,
    )
  }
  submit(input: unknown, owner: string) {
    const plan = PlanInput.parse(input)
    return this.command(plan.requestID, { plan, owner }, (db) => {
      for (const node of plan.nodes) {
        const task = this.repository.get(node.taskID)
        if (!task || task.revision !== node.revision)
          throw new Error(`Missing, foreign, or stale task ${node.taskID}`)
      }
      for (const relation of plan.dispositions)
        if (!this.repository.get(relation.otherTaskID)) throw new Error("Foreign relation target")
      const id = crypto.randomUUID()
      db.query("INSERT INTO runner_plans VALUES(?,?,?,1,1,'draft',?,NULL,NULL,NULL)").run(
        id,
        this.repository.projectDirectory,
        owner,
        JSON.stringify(plan),
      )
      db.query("INSERT INTO runner_plan_revisions VALUES(?,1,?,?,?)").run(
        id,
        JSON.stringify(plan),
        owner,
        Date.now(),
      )
      for (const taskID of plan.integrationOrder)
        db.query("INSERT INTO runner_nodes VALUES(?,?,1,?,'queued',1,NULL,NULL,?,?)").run(
          id,
          taskID,
          plan.integrationOrder.indexOf(taskID),
          JSON.stringify(initialSnapshot()),
          machineVersion,
        )
      for (const edge of plan.dependencies)
        db.query("INSERT INTO runner_dependencies VALUES(?,?,?)").run(
          id,
          edge.prerequisite,
          edge.successor,
        )
      for (const relation of plan.dispositions) {
        db.query("INSERT INTO runner_relations VALUES(?,?,?,?,?,?,?)").run(
          this.repository.projectDirectory,
          relation.taskID,
          relation.otherTaskID,
          relation.relation,
          relation.rationale,
          owner,
          Date.now(),
        )
      }
      this.record(id, null, "PLAN_SUBMITTED", { owner, revision: 1 })
      return { status: "submitted", planID: id, version: 1 }
    })
  }
  record(planID: string, taskID: string | null, event: string, payload: unknown) {
    const plan = this.plan(planID)
    if (!plan) throw new Error("Plan not found")
    this.atomic((db) => {
      db.query(
        "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
      ).run(planID, taskID, plan.version, event, JSON.stringify(payload), Date.now())
      this.repository.changed()
    })
  }
  latestTransition<T>(planID: string, taskID: string, event: string): T | undefined {
    if (!this.plan(planID)) throw new Error("Plan not found")
    const row = this.atomic((db) =>
      db
        .query<{ payload: string }, [string, string, string]>(
          "SELECT payload FROM runner_transitions WHERE plan_id=? AND task_id=? AND event=? ORDER BY id DESC LIMIT 1",
        )
        .get(planID, taskID, event),
    )
    return row ? (JSON.parse(row.payload) as T) : undefined
  }
  move(planID: string, taskID: string, event: string, reason: string | null = null) {
    return this.atomic((db) => {
      const node = this.nodes(planID).find((n) => n.task_id === taskID)
      if (!node) throw new Error("Task not in plan")
      if (node.machine_version !== machineVersion)
        throw new Error("Unsupported task machine version")
      const next = transition(node.state, event)
      db.query(
        "UPDATE runner_nodes SET state=?,version=version+1,reason=?,snapshot=? WHERE plan_id=? AND task_id=? AND version=?",
      ).run(next.state, reason, JSON.stringify(next.snapshot), planID, taskID, node.version)
      db.query("UPDATE runner_plans SET version=version+1 WHERE id=?").run(planID)
      this.record(planID, taskID, event, { from: node.state, to: next.state, reason })
      return next.state
    })
  }
  claim(owner: string, now = Date.now()) {
    return this.atomic((db) => {
      const old = db
        .query<{ owner: string; fence: number; expires_at: number }, [string]>(
          "SELECT * FROM runner_leases WHERE project_directory=?",
        )
        .get(this.repository.projectDirectory)
      if (old && old.owner !== owner && old.expires_at > now) return null
      const fence = old?.owner === owner ? old.fence : (old?.fence ?? 0) + 1
      db.query(
        "INSERT INTO runner_leases VALUES(?,?,?,?) ON CONFLICT(project_directory) DO UPDATE SET owner=excluded.owner,fence=excluded.fence,expires_at=excluded.expires_at",
      ).run(this.repository.projectDirectory, owner, fence, now + 30000)
      return fence
    })
  }
  fenced<T>(owner: string, fence: number, run: (db: Database) => T): T {
    return this.atomic((db) => {
      const lease = db
        .query<{ owner: string; fence: number }, [string]>(
          "SELECT owner,fence FROM runner_leases WHERE project_directory=?",
        )
        .get(this.repository.projectDirectory)
      if (lease?.owner !== owner || lease.fence !== fence) throw new Error("Stale scheduler fence")
      return run(db)
    })
  }
  audit(): { watermark: number; findings: Finding[] } {
    return this.atomic((db) => {
      const tasks = db
        .query<{ id: string; body: string }, [string]>(
          "SELECT id,body FROM tasks WHERE project_directory=? ORDER BY rowid",
        )
        .all(this.repository.projectDirectory)
      const relations = db
        .query<{ task_id: string; other_task_id: string }, [string]>(
          "SELECT task_id,other_task_id FROM runner_relations WHERE project_directory=?",
        )
        .all(this.repository.projectDirectory)
      const findings: Finding[] = []
      const add = (code: string, taskIDs: string[], evidence: string, actions: string[]) =>
        findings.push({
          id: fingerprint({ code, taskIDs }).slice(0, 24),
          code,
          taskIDs,
          evidence,
          actions,
        })
      for (const task of tasks)
        if (!this.execution(task.id))
          add("unplanned", [task.id], "Specification has no admitted execution plan", [
            "plan",
            "reuse",
          ])
      for (let i = 0; i < tasks.length; i++)
        for (let j = i + 1; j < tasks.length; j++) {
          const a = tasks[i]!,
            b = tasks[j]!
          if (
            relations.some(
              (r) =>
                (r.task_id === a.id && r.other_task_id === b.id) ||
                (r.task_id === b.id && r.other_task_id === a.id),
            )
          )
            continue
          const aa = this.repository.get(a.id)!,
            bb = this.repository.get(b.id)!
          const exact = fingerprint(aa.proposal) === fingerprint(bb.proposal)
          const overlap = scopePatternsConflict(aa.proposal.writeScope, bb.proposal.writeScope)
          if (exact || overlap)
            add(
              exact ? "exact-content" : "scope-overlap",
              [a.id, b.id],
              exact
                ? "Validated proposal fingerprints match"
                : `Conflicting path scopes: ${aa.proposal.writeScope.join(", ")} ↔ ${bb.proposal.writeScope.join(", ")}`,
              ["distinct", "duplicate", "supplements"],
            )
        }
      const watermark = this.repository.version()
      const id = fingerprint({ watermark, findings })
      db.query("INSERT OR IGNORE INTO runner_audits VALUES(?,?,?,?,?)").run(
        id,
        this.repository.projectDirectory,
        watermark,
        JSON.stringify(findings),
        Date.now(),
      )
      return { watermark, findings }
    })
  }
  attempts(planID: string) {
    if (!this.plan(planID)) throw new Error("Plan not found")
    return this.atomic((db) =>
      db
        .query<AttemptRow, [string]>(
          "SELECT * FROM runner_attempts WHERE plan_id=? ORDER BY started_at,number",
        )
        .all(planID),
    )
  }
  effects(planID: string) {
    if (!this.plan(planID)) throw new Error("Plan not found")
    return this.atomic((db) =>
      db
        .query<EffectRow, [string]>("SELECT * FROM runner_effects WHERE plan_id=? ORDER BY rowid")
        .all(planID),
    )
  }
  detail(planID: string) {
    const plan = this.plan(planID)
    if (!plan) throw new Error("Plan not found")
    return this.atomic((db) => ({
      plan,
      nodes: this.nodes(planID),
      attempts: this.attempts(planID),
      effects: this.effects(planID),
      evidence: db
        .query("SELECT * FROM runner_evidence WHERE plan_id=? ORDER BY created_at")
        .all(planID),
      activity: db
        .query("SELECT * FROM runner_transitions WHERE plan_id=? ORDER BY id")
        .all(planID),
      delivery: db.query("SELECT * FROM runner_outbox WHERE plan_id=? ORDER BY rowid").all(planID),
      audit: this.audit(),
    }))
  }
}
