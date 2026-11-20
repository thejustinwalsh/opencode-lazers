import { canonical } from "../identity.ts"
import { realpathSync } from "node:fs"
import type { Database } from "bun:sqlite"
import type { TaskRepository } from "../storage.ts"
import { chmod, mkdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

export type AuditActor = { sessionID: string; agent: string }
export type { AuditRun, AuditDecision } from "./contract.ts"
import type { AuditRun, AuditDecision } from "./contract.ts"
type AuditFinding = {
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
function auditFindings(runID: string, analysis: string, report: unknown): AuditFinding[] {
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

type AuditStartInput = {
  requestID: string
  workspace: string
  phase?: AuditRun["phase"]
  baselineRunID?: string
  taskID?: string
  sourcePath?: string
  threads?: number
}

type AuditStartAssignment = {
  task_id: string
  plan_id: string
  id: string
  workspace: string
}

function canonicalStartInput(input: AuditStartInput): string {
  return canonical(JSON.parse(JSON.stringify(input)))
}

function findPreviousAuditRun(
  db: Database,
  projectDirectory: string,
  sessionID: string,
  requestID: string,
): AuditRun | undefined {
  const row = db
    .query<{ payload: string }, [string, string, string]>(
      "SELECT payload FROM audit_runs WHERE project_directory=? AND session_id=? AND request_id=?",
    )
    .get(projectDirectory, sessionID, requestID)
  if (!row) return undefined
  return JSON.parse(row.payload) as AuditRun
}

function matchPreviousAuditRun(
  previous: AuditRun | undefined,
  canonicalInput: string,
): { created: false; run: AuditRun } | undefined {
  if (!previous) return undefined
  if (previous.requestInput !== canonicalInput)
    throw new Error("Request ID already identifies a different audit request")
  return { created: false, run: previous }
}

function findStartAssignment(
  db: Database,
  projectDirectory: string,
  sessionID: string,
): AuditStartAssignment | null {
  const runnerExists = db.query("SELECT name FROM sqlite_master WHERE name='runner_attempts'").get()
  if (!runnerExists) return null
  const assignment = db
    .query<AuditStartAssignment, [string, string]>(
      `SELECT a.task_id,a.plan_id,a.id,a.workspace FROM runner_attempts a
          JOIN runner_plans p ON p.id=a.plan_id WHERE a.session_id=? AND p.project_directory=?`,
    )
    .get(sessionID, projectDirectory)
  return assignment ?? null
}

function checkStartWorkspace(assignment: AuditStartAssignment | null, workspace: string): void {
  if (!assignment) return
  if (realpathSync(assignment.workspace) !== realpathSync(workspace))
    throw new Error("Audit workspace differs from its assigned attempt")
}

function resolveStartTaskID(
  repository: TaskRepository,
  assignment: AuditStartAssignment | null,
  inputTaskID: string | undefined,
): string | null {
  if (assignment) return assignment.task_id
  if (!inputTaskID) return null
  return repository.resolveTaskID(inputTaskID) ?? null
}

function checkStartTaskMatch(
  repository: TaskRepository,
  inputTaskID: string | undefined,
  taskID: string | null,
  assignment: AuditStartAssignment | null,
): void {
  if (!inputTaskID) return
  if (!taskID) throw new Error("Audit task does not match this project or worker assignment")
  if (assignment && repository.resolveTaskID(inputTaskID) !== taskID)
    throw new Error("Audit task does not match this project or worker assignment")
}

function checkStartTaskExists(repository: TaskRepository, taskID: string | null): void {
  if (!taskID) return
  if (!repository.get(taskID)) throw new Error("Audit task not found in this project")
}

function findBaselineAuditRun(
  db: Database,
  projectDirectory: string,
  taskID: string | null,
  sessionID: string,
  baselineRunID: string | undefined,
  loadRun: (runID: string) => AuditRun,
): AuditRun | undefined {
  if (baselineRunID) return loadRun(baselineRunID)
  const scope = taskID ? "task_id=?" : "task_id IS NULL AND session_id=?"
  const row = db
    .query<{ payload: string }, [string, string]>(
      `SELECT payload FROM audit_runs WHERE project_directory=? AND ${scope} AND json_extract(payload,'$.phase')='baseline' ORDER BY started_at,rowid LIMIT 1`,
    )
    .get(projectDirectory, taskID ?? sessionID)
  if (!row) return undefined
  return JSON.parse(row.payload) as AuditRun
}

function checkBaselineTask(baseline: AuditRun | undefined, taskID: string | null): void {
  if (!baseline) return
  if (baseline.taskID && baseline.taskID !== taskID)
    throw new Error("Baseline belongs to a different task")
}

function startPhaseFor(input: AuditStartInput, baseline: AuditRun | undefined): AuditRun["phase"] {
  if (input.phase) return input.phase
  if (baseline) return "follow-up"
  return "baseline"
}

function startBaselineRunIDFor(
  input: AuditStartInput,
  baseline: AuditRun | undefined,
): string | null {
  if (input.phase === "baseline") return null
  return baseline?.runID ?? null
}

function buildStartRun(
  projectDirectory: string,
  input: AuditStartInput,
  actor: AuditActor,
  assignment: AuditStartAssignment | null,
  taskID: string | null,
  baseline: AuditRun | undefined,
  canonicalInput: string,
): AuditRun {
  return {
    schemaVersion: 1,
    runID: crypto.randomUUID(),
    projectDirectory,
    workspace: input.workspace,
    taskID: taskID ?? null,
    planID: assignment?.plan_id ?? null,
    attemptID: assignment?.id ?? null,
    sessionID: actor.sessionID,
    agent: actor.agent,
    requestID: input.requestID,
    phase: startPhaseFor(input, baseline),
    baselineRunID: startBaselineRunIDFor(input, baseline),
    startedAt: Date.now(),
    finishedAt: null,
    state: "collecting",
    source: input.sourcePath ? "legacy-file" : "fallow",
    sourcePath: input.sourcePath ?? null,
    error: null,
    requestInput: canonicalInput,
  }
}

function insertStartRun(db: Database, run: AuditRun): void {
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
}

function runStartTransaction(
  db: Database,
  repository: TaskRepository,
  input: AuditStartInput,
  actor: AuditActor,
  loadRun: (runID: string) => AuditRun,
): { created: boolean; run: AuditRun } {
  const canonicalInput = canonicalStartInput(input)
  const previous = findPreviousAuditRun(
    db,
    repository.projectDirectory,
    actor.sessionID,
    input.requestID,
  )
  const duplicate = matchPreviousAuditRun(previous, canonicalInput)
  if (duplicate) return duplicate
  const assignment = findStartAssignment(db, repository.projectDirectory, actor.sessionID)
  checkStartWorkspace(assignment, input.workspace)
  const taskID = resolveStartTaskID(repository, assignment, input.taskID)
  checkStartTaskMatch(repository, input.taskID, taskID, assignment)
  checkStartTaskExists(repository, taskID)
  const baseline = findBaselineAuditRun(
    db,
    repository.projectDirectory,
    taskID,
    actor.sessionID,
    input.baselineRunID,
    loadRun,
  )
  checkBaselineTask(baseline, taskID)
  const run = buildStartRun(
    repository.projectDirectory,
    input,
    actor,
    assignment,
    taskID,
    baseline,
    canonicalInput,
  )
  insertStartRun(db, run)
  repository.changed()
  return { created: true, run }
}

function insertFindings(
  db: Database,
  runID: string,
  analysis: string,
  capturedAt: number,
  findings: AuditFinding[],
) {
  const insert = db.query(
    "INSERT OR REPLACE INTO audit_findings(run_id,analysis,ordinal,finding_id,section_at,category,path,line,details) VALUES(?,?,?,?,?,?,?,?,?)",
  )
  findings.forEach((f, ordinal) =>
    insert.run(
      runID,
      analysis,
      ordinal,
      f.findingID,
      capturedAt,
      f.category,
      f.path,
      f.line,
      JSON.stringify(f.details),
    ),
  )
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
      CREATE TABLE IF NOT EXISTS audit_findings (
        run_id TEXT NOT NULL REFERENCES audit_runs(id), analysis TEXT NOT NULL,
        ordinal INTEGER NOT NULL, finding_id TEXT NOT NULL, section_at INTEGER NOT NULL,
        category TEXT NOT NULL, path TEXT, line INTEGER, details TEXT NOT NULL,
        PRIMARY KEY(run_id,analysis,ordinal)
      );
      CREATE INDEX IF NOT EXISTS audit_findings_id ON audit_findings(run_id,finding_id);
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
  start(input: AuditStartInput, actor: AuditActor) {
    return this.repository.atomic((db) =>
      runStartTransaction(db, this.repository, input, actor, this.get.bind(this)),
    )
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
    const findings = auditFindings(runID, analysis, report)
    const capturedAt = Date.now()
    this.repository.atomic((db) => {
      db.query("INSERT INTO audit_sections VALUES(?,?,?,?,?,?,?)").run(
        runID,
        analysis,
        JSON.stringify(report ?? null),
        JSON.stringify(summary),
        error ?? null,
        capturedAt,
        findings.length,
      )
      insertFindings(db, runID, analysis, capturedAt, findings)
    })
  }

  /**
   * Findings are indexed once, when their section is stored. A run stored before the index
   * existed is indexed on first read: its sections are parsed once, then never again.
   */
  private indexFindings(runID: string) {
    this.repository.atomic((db) => {
      const stale = db
        .query<{ analysis: string; payload: string; captured_at: number }, [string]>(
          `SELECT s.analysis,s.payload,s.captured_at FROM audit_sections s WHERE s.run_id=?
           AND s.finding_count != (SELECT COUNT(*) FROM audit_findings f WHERE f.run_id=s.run_id AND f.analysis=s.analysis)`,
        )
        .all(runID)
      for (const row of stale) {
        db.query("DELETE FROM audit_findings WHERE run_id=? AND analysis=?").run(
          runID,
          row.analysis,
        )
        insertFindings(
          db,
          runID,
          row.analysis,
          row.captured_at,
          auditFindings(runID, row.analysis, JSON.parse(row.payload)),
        )
      }
    })
  }
  finish(runID: string, interrupted?: string, finishedAt = Date.now()) {
    const run = this.get(runID)
    if (run.state !== "collecting") return run
    // Existence in SQL: no section report is read or parsed to learn whether one failed.
    const failed = this.repository.atomic(
      (db) =>
        db
          .query<{ one: number }, [string]>(
            "SELECT 1 AS one FROM audit_sections WHERE run_id=? AND error IS NOT NULL LIMIT 1",
          )
          .get(runID) !== null,
    )
    run.finishedAt = finishedAt
    run.error = interrupted ?? null
    run.state = interrupted ? "interrupted" : failed ? "partial" : "completed"
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
    const run = this.get(runID)
    this.indexFindings(runID)
    const offset = input.offset ?? 0,
      limit = input.limit ?? 50
    const where = `run_id=? ${input.analysis ? "AND analysis=?" : ""} ${input.path ? "AND instr(details,?)>0" : ""}`
    const filter = [
      runID,
      ...(input.analysis ? [input.analysis] : []),
      ...(input.path ? [input.path] : []),
    ]
    // Paged in SQL: only the requested window is read and parsed.
    const { rows, total } = this.repository.atomic((db) => ({
      total: db
        .query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM audit_findings WHERE ${where}`)
        .get(...filter)!.n,
      rows: db
        .query<
          {
            finding_id: string
            analysis: string
            category: string
            path: string | null
            line: number | null
            details: string
            section_at: number
          },
          (string | number)[]
        >(
          `SELECT finding_id,analysis,category,path,line,details,section_at FROM audit_findings
           WHERE ${where} ORDER BY section_at,analysis,ordinal LIMIT ? OFFSET ?`,
        )
        .all(...filter, limit, offset),
    }))
    const findings = rows.map((row) => ({
      findingID: row.finding_id,
      analysis: row.analysis,
      category: row.category,
      path: row.path,
      line: row.line,
      details: JSON.parse(row.details) as unknown,
      observedAt: row.section_at,
    }))
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
      findings: findings.map((f) => ({
        ...f,
        decisions: decisions.filter((d) => d.findingID === f.findingID),
      })),
      totalFindings: total,
      nextOffset: offset + limit < total ? offset + limit : null,
      ...(input.includeReports
        ? {
            reports: Object.fromEntries(this.sections(runID).map((s) => [s.analysis, s.report])),
          }
        : {}),
    }
  }
  decide(input: AuditDecision, actor: AuditActor) {
    const run = this.get(input.runID)
    this.indexFindings(run.runID)
    const known = this.repository.atomic(
      (db) =>
        db
          .query<{ one: number }, [string, string]>(
            "SELECT 1 AS one FROM audit_findings WHERE run_id=? AND finding_id=? LIMIT 1",
          )
          .get(run.runID, input.findingID) !== null,
    )
    if (!known) throw new Error("Finding not found in this audit run")
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
  /**
   * Writes the export section by section: one report is read, serialized and written at a time,
   * so the file's size is never held in memory. The bytes equal `JSON.stringify(value, null, 2)`
   * of `{ ...run, schemaVersion: 2, reports }`.
   */
  async export(runID: string) {
    const run = this.summary(this.get(runID))
    const path = this.reportPath(runID),
      temporary = `${path}.${crypto.randomUUID()}.tmp`
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const head = JSON.stringify({ ...run, schemaVersion: 2 }, null, 2)
    const writer = Bun.file(temporary).writer()
    try {
      writer.write(`${head.slice(0, -2)},\n  "reports": {`)
      let first = true
      const names = this.repository.atomic((db) =>
        db
          .query<{ analysis: string }, [string]>(
            "SELECT analysis FROM audit_sections WHERE run_id=? ORDER BY captured_at,analysis",
          )
          .all(runID)
          .map((row) => row.analysis),
      )
      for (const analysis of names) {
        const payload = this.repository.atomic(
          (db) =>
            db
              .query<{ payload: string }, [string, string]>(
                "SELECT payload FROM audit_sections WHERE run_id=? AND analysis=?",
              )
              .get(runID, analysis)!.payload,
        )
        const body = JSON.stringify(JSON.parse(payload), null, 2).replaceAll("\n", "\n    ")
        writer.write(`${first ? "\n" : ",\n"}    ${JSON.stringify(analysis)}: ${body}`)
        first = false
      }
      writer.write(first ? "}\n}\n" : "\n  }\n}\n")
      await writer.end()
    } catch (error) {
      await Promise.resolve(writer.end()).catch(() => 0)
      await rm(temporary, { force: true })
      throw error
    }
    await chmod(temporary, 0o600)
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
