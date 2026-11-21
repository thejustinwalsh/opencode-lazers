import type { Database } from "bun:sqlite"
import { z } from "zod"
import { ModelMappingSubject as WorkerPersona } from "./agent-ids.ts"
import type { ModelMappingSubject as WorkerPersonaType } from "./agent-ids.ts"
import type { TaskRepository } from "../storage.ts"
import {
  ModelMappingRecordSchema,
  ModelMappingTargetInputSchema,
  ModelMappingToolInput,
  ModelMappingUpdateSchema,
} from "./mapping-schema.ts"
import type { ModelMappingRecord, ModelMappingTargetInput } from "./mapping-schema.ts"

type MappingKey = {
  scope: ModelMappingTargetInput["scope"]
  projectDirectory: string
  taskID: string
  persona: WorkerPersonaType
}

export type ModelMappingLayers = {
  task: ModelMappingRecord | null
  project: ModelMappingRecord | null
  shared: ModelMappingRecord | null
}

export type ModelMappingWrite =
  | { status: "updated"; mapping: ModelMappingRecord }
  | {
      status: "conflict"
      expectedRevision: number
      currentRevision: number
      current: ModelMappingRecord | null
    }

function ensureTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_mappings (
      scope TEXT NOT NULL CHECK(scope IN ('shared','project','task')),
      project_directory TEXT NOT NULL,
      task_id TEXT NOT NULL,
      persona TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      payload TEXT NOT NULL,
      PRIMARY KEY(scope,project_directory,task_id,persona,revision)
    );
  `)
}

function decode(payload: string): ModelMappingRecord {
  return ModelMappingRecordSchema.parse(JSON.parse(payload))
}

function keyFor(
  target: ModelMappingTargetInput,
  projectDirectory: string,
  persona: WorkerPersonaType,
): MappingKey {
  switch (target.scope) {
    case "shared":
      return { scope: "shared", projectDirectory: "", taskID: "", persona }
    case "project":
      return { scope: "project", projectDirectory, taskID: "", persona }
    case "task":
      return { scope: "task", projectDirectory, taskID: target.taskID, persona }
  }
}

function storedTarget(target: ModelMappingTargetInput, projectDirectory: string) {
  switch (target.scope) {
    case "shared":
      return { scope: "shared" as const }
    case "project":
      return { scope: "project" as const, projectDirectory }
    case "task":
      return { scope: "task" as const, projectDirectory, taskID: target.taskID }
  }
}

function currentIn(db: Database, key: MappingKey): ModelMappingRecord | null {
  const row = db
    .query<{ payload: string }, [string, string, string, string]>(
      `SELECT payload FROM model_mappings
       WHERE scope=? AND project_directory=? AND task_id=? AND persona=?
       ORDER BY revision DESC LIMIT 1`,
    )
    .get(key.scope, key.projectDirectory, key.taskID, key.persona)
  return row ? decode(row.payload) : null
}

/**
 * Versioned persona and agent routes; this store never changes task or runner state. The
 * subject column holds a persona (`ui`) or an agent id (`architect`); an agent route is never
 * task-scoped.
 */
export class ModelMappingStore {
  constructor(readonly repository: TaskRepository) {}

  private tablesPresent = false
  /** Reads run on a deferred read transaction; only a missing table takes the write lock, once. */
  private view<T>(run: (db: Database) => T): T {
    if (!this.tablesPresent) {
      const exists = this.repository.read(
        (db) =>
          db
            .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_mappings'")
            .get() !== null,
      )
      if (!exists) this.repository.atomic(ensureTables)
      this.tablesPresent = true
    }
    return this.repository.read(run)
  }

  /** GUI path: guarded by the revision the editor last read. */
  update(input: unknown): ModelMappingWrite {
    const update = ModelMappingUpdateSchema.parse(input)
    return this.write(update, update.expectedRevision)
  }

  /** Model-tool path: writes against whatever is current; last write wins and history keeps both. */
  overwrite(input: unknown): ModelMappingWrite {
    const update = ModelMappingToolInput.parse(input)
    // The guard is absent, so the placeholder revision is never compared.
    return this.write({ ...update, expectedRevision: 0 }, undefined)
  }

  private write(
    update: ReturnType<typeof ModelMappingUpdateSchema.parse>,
    guard: number | undefined,
  ): ModelMappingWrite {
    const key = keyFor(update.target, this.repository.projectDirectory, update.persona)

    return this.repository.atomic((db) => {
      ensureTables(db)
      const current = currentIn(db, key)
      const currentRevision = current?.revision ?? 0
      if (guard !== undefined && currentRevision !== guard)
        return {
          status: "conflict" as const,
          expectedRevision: guard!,
          currentRevision,
          current,
        }

      const mapping = ModelMappingRecordSchema.parse({
        schemaVersion: 1,
        target: storedTarget(update.target, this.repository.projectDirectory),
        persona: update.persona,
        revision: currentRevision + 1,
        route: update.route,
        updatedAt: Date.now(),
      })
      db.query(
        `INSERT INTO model_mappings
         (scope,project_directory,task_id,persona,revision,payload) VALUES(?,?,?,?,?,?)`,
      ).run(
        key.scope,
        key.projectDirectory,
        key.taskID,
        key.persona,
        mapping.revision,
        JSON.stringify(mapping),
      )
      return { status: "updated" as const, mapping }
    })
  }

  current(targetInput: unknown, personaInput: unknown): ModelMappingRecord | null {
    const target = ModelMappingTargetInputSchema.parse(targetInput)
    const persona = WorkerPersona.parse(personaInput)
    const key = keyFor(target, this.repository.projectDirectory, persona)
    return this.view((db) => currentIn(db, key))
  }

  history(targetInput: unknown, personaInput: unknown): ModelMappingRecord[] {
    const target = ModelMappingTargetInputSchema.parse(targetInput)
    const persona = WorkerPersona.parse(personaInput)
    const key = keyFor(target, this.repository.projectDirectory, persona)
    return this.view((db) =>
      db
        .query<{ payload: string }, [string, string, string, string]>(
          `SELECT payload FROM model_mappings
           WHERE scope=? AND project_directory=? AND task_id=? AND persona=?
           ORDER BY revision`,
        )
        .all(key.scope, key.projectDirectory, key.taskID, key.persona)
        .map((row) => decode(row.payload)),
    )
  }

  /**
   * The route an agent is configured to use: this project's, else the shared one. Synchronous,
   * so an agent transform can read it while the host builds the agent.
   */
  agentRoute(agentID: string): {
    route: NonNullable<ModelMappingRecord["route"]>
    scope: "project" | "shared"
    revision: number
  } | null {
    const layers = this.layers(WorkerPersona.parse(agentID))
    for (const scope of ["project", "shared"] as const) {
      const record = layers[scope]
      if (record?.route) return { route: record.route, scope, revision: record.revision }
    }
    return null
  }

  /** Read all applicable layers in one SQLite transaction for a consistent resolution snapshot. */
  layers(persona: WorkerPersonaType, taskID?: string): ModelMappingLayers {
    const parsedPersona = WorkerPersona.parse(persona)
    const parsedTaskID = taskID === undefined ? undefined : z.uuid().parse(taskID)
    return this.view((db) => {
      return {
        task: parsedTaskID
          ? currentIn(
              db,
              keyFor(
                { scope: "task", taskID: parsedTaskID },
                this.repository.projectDirectory,
                parsedPersona,
              ),
            )
          : null,
        project: currentIn(
          db,
          keyFor({ scope: "project" }, this.repository.projectDirectory, parsedPersona),
        ),
        shared: currentIn(
          db,
          keyFor({ scope: "shared" }, this.repository.projectDirectory, parsedPersona),
        ),
      }
    })
  }
}
