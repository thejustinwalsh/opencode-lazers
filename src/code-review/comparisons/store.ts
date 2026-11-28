import type { Database } from "bun:sqlite"
import { schemaModules } from "../../database-schema.ts"
import type { TaskRepository } from "../../storage.ts"
import {
  CodeReviewComparisonSchema,
  type CodeReviewComparison,
  type CodeReviewFileKind,
  type CodeReviewFileStatus,
  type CodeReviewHunk,
  type CodeReviewSide,
} from "../contract.ts"

export type ComparisonFile = {
  side: CodeReviewSide
  path: string
  mode: string | null
  objectID: string | null
  size: number | null
  kind: CodeReviewFileKind
  status: CodeReviewFileStatus
  changed: boolean
  hunks: CodeReviewHunk[]
  attributionTaskIDs: string[]
}

export type ComparisonBlob = { id: string; content: Uint8Array }

export type StoredCodeReviewFile = Omit<ComparisonFile, "objectID"> & {
  objectID: string | null
  project_directory: string
  comparison_id: string
}

const MODULE = schemaModules["code-review"]

function installCodeReviewSchema(repository: TaskRepository): void {
  repository.installSchema("code-review", MODULE.generation, MODULE.tables, (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS code_review_comparisons (
        project_directory TEXT NOT NULL,
        comparison_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        plan_id TEXT,
        attempt_id TEXT,
        mode TEXT NOT NULL,
        identity_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(project_directory,comparison_id)
      );
      CREATE TABLE IF NOT EXISTS code_review_files (
        project_directory TEXT NOT NULL,
        comparison_id TEXT NOT NULL,
        side TEXT NOT NULL,
        path TEXT NOT NULL,
        mode TEXT,
        object_id TEXT,
        size INTEGER,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        changed INTEGER NOT NULL,
        hunks TEXT NOT NULL,
        attribution_task_ids TEXT NOT NULL,
        PRIMARY KEY(project_directory,comparison_id,side,path)
      );
      CREATE INDEX IF NOT EXISTS code_review_files_side_path
        ON code_review_files(project_directory,comparison_id,side,path);
      CREATE TABLE IF NOT EXISTS code_review_blobs (
        project_directory TEXT NOT NULL,
        blob_id TEXT NOT NULL,
        content BLOB NOT NULL,
        PRIMARY KEY(project_directory,blob_id)
      );
      CREATE TABLE IF NOT EXISTS code_review_reviewed_baselines (
        project_directory TEXT NOT NULL,
        baseline_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        comparison_id TEXT NOT NULL,
        identity_json TEXT NOT NULL,
        reviewed_at INTEGER NOT NULL,
        PRIMARY KEY(project_directory,baseline_id),
        UNIQUE(project_directory,task_id,comparison_id)
      );
      CREATE INDEX IF NOT EXISTS code_review_reviewed_task_page
        ON code_review_reviewed_baselines(project_directory,task_id,reviewed_at,baseline_id);
      CREATE TABLE IF NOT EXISTS code_review_reviewed_requests (
        project_directory TEXT NOT NULL,
        request_id TEXT NOT NULL,
        baseline_id TEXT NOT NULL,
        PRIMARY KEY(project_directory,request_id)
      );
    `)
  })
}

export class CodeReviewStore {
  constructor(readonly repository: TaskRepository) {
    installCodeReviewSchema(repository)
  }

  comparison(comparisonID: string): CodeReviewComparison | undefined {
    const json = this.repository.read(
      (db) =>
        db
          .query<{ result_json: string }, [string, string]>(
            "SELECT result_json FROM code_review_comparisons WHERE project_directory=? AND comparison_id=?",
          )
          .get(this.repository.projectDirectory, comparisonID)?.result_json,
    )
    return json ? CodeReviewComparisonSchema.parse(JSON.parse(json)) : undefined
  }

  file(comparisonID: string, side: CodeReviewSide, path: string): StoredCodeReviewFile | undefined {
    const row = this.repository.read((db) =>
      db
        .query<
          {
            project_directory: string
            comparison_id: string
            side: CodeReviewSide
            path: string
            mode: string | null
            object_id: string | null
            size: number | null
            kind: CodeReviewFileKind
            status: CodeReviewFileStatus
            changed: number
            hunks: string
            attribution_task_ids: string
          },
          [string, string, string, string]
        >(
          `SELECT project_directory,comparison_id,side,path,mode,object_id,size,kind,status,changed,
                  hunks,attribution_task_ids
           FROM code_review_files
           WHERE project_directory=? AND comparison_id=? AND side=? AND path=?`,
        )
        .get(this.repository.projectDirectory, comparisonID, side, path),
    )
    if (!row) return undefined
    return {
      project_directory: row.project_directory,
      comparison_id: row.comparison_id,
      side: row.side,
      path: row.path,
      mode: row.mode,
      objectID: row.object_id,
      size: row.size,
      kind: row.kind,
      status: row.status,
      changed: Boolean(row.changed),
      hunks: JSON.parse(row.hunks) as CodeReviewHunk[],
      attributionTaskIDs: JSON.parse(row.attribution_task_ids) as string[],
    }
  }

  blob(blobID: string): Uint8Array | undefined {
    return this.repository.read(
      (db) =>
        db
          .query<{ content: Uint8Array }, [string, string]>(
            "SELECT content FROM code_review_blobs WHERE project_directory=? AND blob_id=?",
          )
          .get(this.repository.projectDirectory, blobID)?.content,
    )
  }

  persist(
    comparison: CodeReviewComparison,
    files: readonly ComparisonFile[],
    blobs: readonly ComparisonBlob[],
  ): CodeReviewComparison {
    const identity = comparison.identity
    const resultJSON = JSON.stringify(comparison)
    this.repository.atomic((db) => {
      db.query(
        `INSERT OR IGNORE INTO code_review_comparisons(
           project_directory,comparison_id,task_id,plan_id,attempt_id,mode,identity_json,result_json,created_at
         ) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        identity.comparisonID,
        identity.taskID,
        identity.planID,
        identity.attemptID,
        identity.mode,
        JSON.stringify(identity),
        resultJSON,
        identity.capturedAt ?? Date.now(),
      )
      const insertBlob = db.query(
        `INSERT OR IGNORE INTO code_review_blobs(project_directory,blob_id,content) VALUES(?,?,?)`,
      )
      for (const blob of blobs)
        insertBlob.run(this.repository.projectDirectory, blob.id, blob.content)
      const insertFile = db.query(
        `INSERT OR IGNORE INTO code_review_files(
           project_directory,comparison_id,side,path,mode,object_id,size,kind,status,changed,hunks,attribution_task_ids
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      for (const file of files)
        insertFile.run(
          this.repository.projectDirectory,
          identity.comparisonID,
          file.side,
          file.path,
          file.mode,
          file.objectID,
          file.size,
          file.kind,
          file.status,
          Number(file.changed),
          JSON.stringify(file.hunks),
          JSON.stringify(file.attributionTaskIDs),
        )
    })
    return this.comparison(identity.comparisonID) ?? comparison
  }

  /** Direct read counterpart used by stream authorization; project partition is always explicit. */
  existsIn(db: Database, comparisonID: string): boolean {
    return Boolean(
      db
        .query<{ present: number }, [string, string]>(
          "SELECT 1 AS present FROM code_review_comparisons WHERE project_directory=? AND comparison_id=?",
        )
        .get(this.repository.projectDirectory, comparisonID),
    )
  }
}
