import type { Database } from "bun:sqlite"
import type { TaskRepository } from "../../storage.ts"
import { CodeReviewIntegrationTargetStore } from "./target-store.ts"
import { CodeReviewIntegrationSchema, type CodeReviewIntegration } from "./contract.ts"

export type IntegrationCursor = { createdAt: number; integrationID: string }

type LegacyIntegrationRow = {
  id: number
  plan_id: string
  task_id: string
  payload: string
  created_at: number
}

function legacyEventID(eventID: number): string {
  const suffix = eventID.toString(16).padStart(12, "0").slice(-12)
  return `00000000-0000-4000-8000-${suffix}`
}

function legacyEventNumber(integrationID: string): number | undefined {
  if (!/^00000000-0000-4000-8000-[0-9a-f]{12}$/.test(integrationID)) return undefined
  const eventID = Number.parseInt(integrationID.slice(-12), 16)
  return Number.isSafeInteger(eventID) ? eventID : undefined
}

function legacyIntegration(row: LegacyIntegrationRow): CodeReviewIntegration {
  let payload: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.payload) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      payload = parsed as Record<string, unknown>
  } catch {
    // A malformed old event remains visible as uncertain, source-less history.
  }
  const artifact =
    typeof payload.artifact === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(payload.artifact)
      ? payload.artifact
      : null
  const head =
    typeof payload.head === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(payload.head)
      ? payload.head
      : null
  return CodeReviewIntegrationSchema.parse({
    id: legacyEventID(row.id),
    target: null,
    taskID: row.task_id,
    planID: row.plan_id,
    attemptID: null,
    sourceBaseRevision: null,
    sourceArtifactRevision: artifact,
    sourceWorkspaceID: null,
    targetBeforeRevision: null,
    targetAfterRevision: head,
    landedCommits: [],
    proofID: null,
    lineage: "uncertain",
    batch: null,
    createdAt: row.created_at,
  })
}

export class CodeReviewIntegrationStore {
  private readonly targets: CodeReviewIntegrationTargetStore

  constructor(readonly repository: TaskRepository) {
    this.targets = new CodeReviewIntegrationTargetStore(repository)
  }

  private withCurrentTarget(db: Database, integration: CodeReviewIntegration) {
    if (!integration.target) return integration
    const current = this.targets.targetIn(db, integration.target.id)?.target
    return current ? { ...integration, target: current } : integration
  }

  recordIntegrationIn(
    db: Database,
    integration: CodeReviewIntegration,
    comparisonID: string,
  ): void {
    const parsed = CodeReviewIntegrationSchema.parse(integration)
    db.query(
      `INSERT INTO code_review_integrations(
         project_directory,integration_id,target_id,task_id,created_at,integration_json
       ) VALUES(?,?,?,?,?,?)`,
    ).run(
      this.repository.projectDirectory,
      parsed.id,
      parsed.target?.id ?? null,
      parsed.taskID,
      parsed.createdAt,
      JSON.stringify(parsed),
    )
    db.query(
      `INSERT INTO code_review_integration_comparisons(
         project_directory,integration_id,comparison_id
       ) VALUES(?,?,?)`,
    ).run(this.repository.projectDirectory, parsed.id, comparisonID)
  }

  comparisonID(integrationID: string): string | undefined {
    return this.repository.read(
      (db) =>
        db
          .query<{ comparison_id: string }, [string, string]>(
            `SELECT comparison_id FROM code_review_integration_comparisons
             WHERE project_directory=? AND integration_id=?`,
          )
          .get(this.repository.projectDirectory, integrationID)?.comparison_id,
    )
  }

  integrations(
    taskID: string,
    limit: number,
    cursor?: IntegrationCursor,
  ): { integrations: CodeReviewIntegration[]; nextCursor: IntegrationCursor | null } {
    const page = this.repository.read((db) => {
      const createdAt = cursor?.createdAt ?? -1
      const integrationID = cursor?.integrationID ?? ""
      const modern = db
        .query<{ integration_json: string }, [string, string, number, number, string, number]>(
          `SELECT integration_json FROM code_review_integrations
           WHERE project_directory=? AND task_id=?
             AND (created_at>? OR (created_at=? AND integration_id>?))
           ORDER BY created_at,integration_id LIMIT ?`,
        )
        .all(
          this.repository.projectDirectory,
          taskID,
          createdAt,
          createdAt,
          integrationID,
          limit + 1,
        )
        .map((row) =>
          this.withCurrentTarget(
            db,
            CodeReviewIntegrationSchema.parse(JSON.parse(row.integration_json)),
          ),
        )
      const legacy = db
        .query<LegacyIntegrationRow, [string, string, number, number, string, number]>(
          `SELECT t.id,t.plan_id,t.task_id,t.payload,t.created_at
           FROM runner_transitions t JOIN runner_plans p ON p.id=t.plan_id
           WHERE p.project_directory=? AND t.task_id=? AND t.event='TASK_INTEGRATION_RECORDED'
             AND json_valid(t.payload) AND json_extract(t.payload,'$.targetID') IS NULL
             AND (t.created_at>? OR (
               t.created_at=? AND
               ('00000000-0000-4000-8000-' || printf('%012x',t.id))>?
             ))
           ORDER BY t.created_at,
             '00000000-0000-4000-8000-' || printf('%012x',t.id)
           LIMIT ?`,
        )
        .all(
          this.repository.projectDirectory,
          taskID,
          createdAt,
          createdAt,
          integrationID,
          limit + 1,
        )
        .map(legacyIntegration)
      return [...modern, ...legacy].sort(compareIntegration)
    })
    const integrations = page.slice(0, limit)
    const last = integrations.at(-1)
    return {
      integrations,
      nextCursor:
        page.length > limit && last ? { createdAt: last.createdAt, integrationID: last.id } : null,
    }
  }

  integration(taskID: string, integrationID: string): CodeReviewIntegration | undefined {
    return this.repository.read((db) => {
      const row = db
        .query<{ integration_json: string }, [string, string, string]>(
          `SELECT integration_json FROM code_review_integrations
           WHERE project_directory=? AND task_id=? AND integration_id=?`,
        )
        .get(this.repository.projectDirectory, taskID, integrationID)
      if (row)
        return this.withCurrentTarget(
          db,
          CodeReviewIntegrationSchema.parse(JSON.parse(row.integration_json)),
        )
      const eventID = legacyEventNumber(integrationID)
      if (eventID === undefined) return undefined
      const event = db
        .query<LegacyIntegrationRow, [string, string, number]>(
          `SELECT t.id,t.plan_id,t.task_id,t.payload,t.created_at
           FROM runner_transitions t JOIN runner_plans p ON p.id=t.plan_id
           WHERE p.project_directory=? AND t.task_id=? AND t.id=?
             AND t.event='TASK_INTEGRATION_RECORDED' AND json_valid(t.payload)
             AND json_extract(t.payload,'$.targetID') IS NULL`,
        )
        .get(this.repository.projectDirectory, taskID, eventID)
      return event ? legacyIntegration(event) : undefined
    })
  }
}

function compareIntegration(left: CodeReviewIntegration, right: CodeReviewIntegration): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}
