import { canonical } from "../identity.ts"
import { realpathSync } from "node:fs"
import type { TaskRepository } from "../storage.ts"
import { mkdir, writeFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"

export type AuditActor = { sessionID: string; agent: string }
export type { AuditRun, AuditDecision } from "./contract.ts"
import type { AuditRun, AuditDecision } from "./contract.ts"
export type AuditFinding = {
  findingID: string
  analysis: string
  category: string
  path: string | null
  line: number | null
  details: unknown
}
type Section = { analysis: string; report: unknown; error: string | null; capturedAt: number }
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
export function auditFindings(runID: string, analysis: string, report: unknown): AuditFinding[] {
  const result: AuditFinding[] = []
  for (const [category, items] of Object.entries(object(report) ?? {})) {
    if (!Array.isArray(items)) continue
    items.forEach((details, index) => {
      const item = object(details)
      if (!item) return
      const instance = Array.isArray(item.instances) ? object(item.instances[0]) : undefined
      const path = item.path ?? item.file ?? instance?.file
      const line = item.line ?? item.start_line ?? instance?.start_line
      result.push({
        findingID: `${runID}/${analysis}/${category}/${index}`,
        analysis,
        category,
        path: typeof path === "string" ? path : null,
        line: typeof line === "number" ? line : null,
        details,
      })
    })
  }
  return result
}

/** The task database is authoritative. JSON files are replaceable exports. */
export class AuditHistory {
  constructor(readonly repository: TaskRepository) {
    repository.atomic((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS audit_runs (
        id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, task_id TEXT,
        attempt_id TEXT, session_id TEXT NOT NULL, request_id TEXT NOT NULL,
        started_at INTEGER NOT NULL, payload TEXT NOT NULL,
        UNIQUE(project_directory,session_id,request_id)
      );
      CREATE INDEX IF NOT EXISTS audit_runs_task ON audit_runs(project_directory,task_id,started_at);
      CREATE INDEX IF NOT EXISTS audit_runs_attempt ON audit_runs(project_directory,attempt_id,started_at);
      CREATE TABLE IF NOT EXISTS audit_sections (
        run_id TEXT NOT NULL REFERENCES audit_runs(id), analysis TEXT NOT NULL,
        payload TEXT NOT NULL, summary TEXT, error TEXT, captured_at INTEGER NOT NULL,
        finding_count INTEGER NOT NULL, PRIMARY KEY(run_id,analysis)
      );
      CREATE TABLE IF NOT EXISTS audit_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_directory TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES audit_runs(id), finding_id TEXT NOT NULL,
        session_id TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL,
        created_at INTEGER NOT NULL, UNIQUE(project_directory,session_id,request_id)
      );
      CREATE INDEX IF NOT EXISTS audit_decisions_finding ON audit_decisions(run_id,finding_id,id);
    `),
    )
  }
  get(runID: string): AuditRun {
    const row = this.repository.atomic((db) =>
      db
        .query<{ payload: string }, [string, string]>(
          "SELECT payload FROM audit_runs WHERE id=? AND project_directory=?",
        )
        .get(runID, this.repository.projectDirectory),
    )
    if (!row) throw new Error("Audit run not found in this project")
    return JSON.parse(row.payload) as AuditRun
  }
  start(
    input: {
      requestID: string
      workspace: string
      phase?: AuditRun["phase"]
      baselineRunID?: string
      taskID?: string
      sourcePath?: string
      threads?: number
    },
    actor: AuditActor,
  ) {
    return this.repository.atomic((db) => {
      const previous = db
        .query<{ payload: string }, [string, string, string]>(
          "SELECT payload FROM audit_runs WHERE project_directory=? AND session_id=? AND request_id=?",
        )
        .get(this.repository.projectDirectory, actor.sessionID, input.requestID)
      if (previous) {
        const run = JSON.parse(previous.payload) as AuditRun
        if (run.requestInput !== canonical(JSON.parse(JSON.stringify(input))))
          throw new Error("Request ID already identifies a different audit request")
        return { created: false, run }
      }
      const runnerExists = db
        .query("SELECT name FROM sqlite_master WHERE name='runner_attempts'")
        .get()
      const assignment = runnerExists
        ? db
            .query<
              { task_id: string; plan_id: string; id: string; workspace: string },
              [string, string]
            >(
              `SELECT a.task_id,a.plan_id,a.id,a.workspace FROM runner_attempts a
         JOIN runner_plans p ON p.id=a.plan_id WHERE a.session_id=? AND p.project_directory=?`,
            )
            .get(actor.sessionID, this.repository.projectDirectory)
        : null
      if (assignment && realpathSync(assignment.workspace) !== realpathSync(input.workspace))
        throw new Error("Audit workspace differs from its assigned attempt")
      const taskID =
        assignment?.task_id ?? (input.taskID ? this.repository.resolveTaskID(input.taskID) : null)
      if (
        input.taskID &&
        (!taskID || (assignment && this.repository.resolveTaskID(input.taskID) !== taskID))
      )
        throw new Error("Audit task does not match this project or worker assignment")
      if (taskID && !this.repository.get(taskID))
        throw new Error("Audit task not found in this project")
      const scope = taskID ? "task_id=?" : "task_id IS NULL AND session_id=?"
      const baseline = input.baselineRunID
        ? this.get(input.baselineRunID)
        : (() => {
            const row = db
              .query<{ payload: string }, [string, string]>(
                `SELECT payload FROM audit_runs WHERE project_directory=? AND ${scope} AND json_extract(payload,'$.phase')='baseline' ORDER BY started_at,rowid LIMIT 1`,
              )
              .get(this.repository.projectDirectory, taskID ?? actor.sessionID)
            return row ? (JSON.parse(row.payload) as AuditRun) : undefined
          })()
      if (baseline?.taskID && baseline.taskID !== taskID)
        throw new Error("Baseline belongs to a different task")
      const run: AuditRun = {
        schemaVersion: 1,
        runID: crypto.randomUUID(),
        projectDirectory: this.repository.projectDirectory,
        workspace: input.workspace,
        taskID: taskID ?? null,
        planID: assignment?.plan_id ?? null,
        attemptID: assignment?.id ?? null,
        sessionID: actor.sessionID,
        agent: actor.agent,
        requestID: input.requestID,
        phase: input.phase ?? (baseline ? "follow-up" : "baseline"),
        baselineRunID: input.phase === "baseline" ? null : (baseline?.runID ?? null),
        startedAt: Date.now(),
        finishedAt: null,
        state: "collecting",
        source: input.sourcePath ? "legacy-file" : "fallow",
        sourcePath: input.sourcePath ?? null,
        error: null,
        requestInput: canonical(JSON.parse(JSON.stringify(input))),
      }
      db.query("INSERT INTO audit_runs VALUES(?,?,?,?,?,?,?,?)").run(
        run.runID,
        run.projectDirectory,
        run.taskID,
        run.attemptID,
        run.sessionID,
        run.requestID,
        run.startedAt,
        JSON.stringify(run),
      )
      this.repository.changed()
      return { created: true, run }
    })
  }
  importedMetadata(runID: string, metadata: unknown) {
    const run = this.get(runID)
    if (run.state !== "collecting") throw new Error("Audit run is already finished")
    this.repository.atomic((db) =>
      db
        .query("UPDATE audit_runs SET payload=? WHERE id=?")
        .run(JSON.stringify({ ...run, importedMetadata: metadata }), runID),
    )
  }
  section(runID: string, analysis: string, report: unknown, error?: string) {
    const run = this.get(runID)
    if (run.state !== "collecting") throw new Error("Audit run is already finished")
    const data = object(report)
    const summary = data?.summary ?? data?.stats ?? { totalFlags: data?.total_flags ?? null }
    this.repository.atomic((db) =>
      db
        .query("INSERT INTO audit_sections VALUES(?,?,?,?,?,?,?)")
        .run(
          runID,
          analysis,
          JSON.stringify(report ?? null),
          JSON.stringify(summary),
          error ?? null,
          Date.now(),
          auditFindings(runID, analysis, report).length,
        ),
    )
  }
  finish(runID: string, interrupted?: string, finishedAt = Date.now()) {
    const run = this.get(runID)
    if (run.state !== "collecting") return run
    const sections = this.sections(runID)
    run.finishedAt = finishedAt
    run.error = interrupted ?? null
    run.state = interrupted
      ? "interrupted"
      : sections.some((s) => s.error)
        ? "partial"
        : "completed"
    this.repository.atomic((db) => {
      db.query("UPDATE audit_runs SET payload=? WHERE id=? AND project_directory=?").run(
        JSON.stringify(run),
        runID,
        this.repository.projectDirectory,
      )
      this.repository.changed()
    })
    return run
  }
  sections(runID: string): Section[] {
    this.get(runID)
    return this.repository.atomic((db) =>
      db
        .query<
          { analysis: string; payload: string; error: string | null; captured_at: number },
          [string]
        >(
          "SELECT analysis,payload,error,captured_at FROM audit_sections WHERE run_id=? ORDER BY captured_at,analysis",
        )
        .all(runID)
        .map((s) => ({
          analysis: s.analysis,
          report: JSON.parse(s.payload),
          error: s.error,
          capturedAt: s.captured_at,
        })),
    )
  }
  list(
    input: {
      taskID?: string
      attemptID?: string
      planID?: string
      offset?: number
      limit?: number
    } = {},
  ) {
    const taskID = input.taskID ? this.repository.resolveTaskID(input.taskID) : undefined
    if (input.taskID && !taskID) return { runs: [], nextOffset: null }
    const offset = input.offset ?? 0,
      limit = input.limit ?? 50
    const rows = this.repository.atomic((db) =>
      db
        .query<{ payload: string }, (string | number)[]>(
          `SELECT payload FROM audit_runs WHERE project_directory=? ${taskID ? "AND task_id=?" : ""}
       ${input.attemptID ? "AND attempt_id=?" : ""} ${input.planID ? "AND json_extract(payload,'$.planID')=?" : ""}
       ORDER BY started_at DESC,rowid DESC LIMIT ? OFFSET ?`,
        )
        .all(
          this.repository.projectDirectory,
          ...(taskID ? [taskID] : []),
          ...(input.attemptID ? [input.attemptID] : []),
          ...(input.planID ? [input.planID] : []),
          limit + 1,
          offset,
        ),
    )
    return {
      runs: rows.slice(0, limit).map((r) => this.summary(JSON.parse(r.payload) as AuditRun)),
      nextOffset: rows.length > limit ? offset + limit : null,
    }
  }
  summary(run: AuditRun) {
    const analyses = this.repository.atomic((db) =>
      db
        .query<
          {
            analysis: string
            summary: string
            error: string | null
            finding_count: number
            captured_at: number
          },
          [string]
        >(
          "SELECT analysis,summary,error,finding_count,captured_at FROM audit_sections WHERE run_id=? ORDER BY captured_at,analysis",
        )
        .all(run.runID)
        .map((s) => ({
          name: s.analysis,
          summary: JSON.parse(s.summary),
          error: s.error,
          findingCount: s.finding_count,
          capturedAt: s.captured_at,
        })),
    )
    const { requestInput: _requestInput, ...metadata } = run
    return { ...metadata, reportPath: this.reportPath(run.runID), analyses }
  }
  detail(
    runID: string,
    input: {
      analysis?: string
      path?: string
      offset?: number
      limit?: number
      includeReports?: boolean
    } = {},
  ) {
    const run = this.get(runID),
      sections = this.sections(runID)
    const findings = sections
      .filter((s) => !input.analysis || s.analysis === input.analysis)
      .flatMap((s) =>
        auditFindings(runID, s.analysis, s.report).map((f) => ({ ...f, observedAt: s.capturedAt })),
      )
      .filter((f) => !input.path || JSON.stringify(f.details).includes(input.path))
    const offset = input.offset ?? 0,
      limit = input.limit ?? 50
    const decisions = this.repository.atomic((db) =>
      db
        .query<{ payload: string; created_at: number; session_id: string }, [string]>(
          "SELECT payload,created_at,session_id FROM audit_decisions WHERE run_id=? ORDER BY id",
        )
        .all(runID)
        .map((r) => ({
          ...JSON.parse(r.payload),
          createdAt: r.created_at,
          sessionID: r.session_id,
        })),
    )
    return {
      run: this.summary(run),
      findings: findings
        .slice(offset, offset + limit)
        .map((f) => ({ ...f, decisions: decisions.filter((d) => d.findingID === f.findingID) })),
      totalFindings: findings.length,
      nextOffset: offset + limit < findings.length ? offset + limit : null,
      ...(input.includeReports
        ? { reports: Object.fromEntries(sections.map((s) => [s.analysis, s.report])) }
        : {}),
    }
  }
  decide(input: AuditDecision, actor: AuditActor) {
    const run = this.get(input.runID)
    if (
      !this.sections(run.runID).some((s) =>
        auditFindings(run.runID, s.analysis, s.report).some((f) => f.findingID === input.findingID),
      )
    )
      throw new Error("Finding not found in this audit run")
    if (input.followupRunID) {
      const followup = this.get(input.followupRunID)
      if (followup.taskID !== run.taskID) throw new Error("Follow-up belongs to a different task")
    }
    const payload = canonical(JSON.parse(JSON.stringify({ ...input, agent: actor.agent })))
    return this.repository.atomic((db) => {
      const existing = db
        .query<{ payload: string; created_at: number }, [string, string, string]>(
          "SELECT payload,created_at FROM audit_decisions WHERE project_directory=? AND session_id=? AND request_id=?",
        )
        .get(run.projectDirectory, actor.sessionID, input.requestID)
      if (existing) {
        if (existing.payload !== payload)
          throw new Error("Request ID already records a different finding decision")
        return {
          ...JSON.parse(existing.payload),
          sessionID: actor.sessionID,
          createdAt: existing.created_at,
        }
      }
      const createdAt = Date.now()
      db.query(
        "INSERT INTO audit_decisions(project_directory,run_id,finding_id,session_id,request_id,payload,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        run.projectDirectory,
        run.runID,
        input.findingID,
        actor.sessionID,
        input.requestID,
        payload,
        createdAt,
      )
      return { ...JSON.parse(payload), sessionID: actor.sessionID, createdAt }
    })
  }
  reportPath(runID: string) {
    return join(dirname(this.repository.path), "audits", `${runID}.json`)
  }
  async export(runID: string) {
    const run = this.summary(this.get(runID))
    const reports = Object.fromEntries(this.sections(runID).map((s) => [s.analysis, s.report]))
    const path = this.reportPath(runID),
      temporary = `${path}.${crypto.randomUUID()}.tmp`
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(
      temporary,
      JSON.stringify({ ...run, schemaVersion: 2, reports }, null, 2) + "\n",
      { mode: 0o600 },
    )
    await rename(temporary, path)
    return path
  }
}

export function taskAuditHistory(repository: TaskRepository, taskID: string) {
  return repository.atomic((db) => {
    if (!db.query("SELECT name FROM sqlite_master WHERE name='audit_runs'").get()) return undefined
    const row = db
      .query<{ count: number; latestRunID: string | null }, [string, string, string, string]>(
        `SELECT COUNT(*) AS count,(SELECT id FROM audit_runs WHERE project_directory=? AND task_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1) AS latestRunID FROM audit_runs WHERE project_directory=? AND task_id=?`,
      )
      .get(repository.projectDirectory, taskID, repository.projectDirectory, taskID)
    return row?.count ? { runCount: row.count, latestRunID: row.latestRunID } : undefined
  })
}
