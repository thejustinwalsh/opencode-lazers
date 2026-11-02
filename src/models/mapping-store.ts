import type { Database } from "bun:sqlite"
import { z } from "zod"
import { WorkerPersona } from "../runner/schema.ts"
import type { WorkerPersona as WorkerPersonaType } from "../runner/schema.ts"
import type { TaskRepository } from "../storage.ts"
import {
  ModelMappingRecordSchema,
  ModelMappingTargetInputSchema,
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

/** Versioned persona routes only; this store never changes task or runner state. */
export class ModelMappingStore {
  constructor(readonly repository: TaskRepository) {}

  update(input: unknown): ModelMappingWrite {
    const update = ModelMappingUpdateSchema.parse(input)
    const key = keyFor(update.target, this.repository.projectDirectory, update.persona)

    return this.repository.atomic((db) => {
      ensureTables(db)
      const current = currentIn(db, key)
      const currentRevision = current?.revision ?? 0
      if (currentRevision !== update.expectedRevision)
        return {
          status: "conflict" as const,
          expectedRevision: update.expectedRevision,
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
    return this.repository.atomic((db) => {
      ensureTables(db)
      return currentIn(db, key)
    })
  }

  history(targetInput: unknown, personaInput: unknown): ModelMappingRecord[] {
    const target = ModelMappingTargetInputSchema.parse(targetInput)
    const persona = WorkerPersona.parse(personaInput)
    const key = keyFor(target, this.repository.projectDirectory, persona)
    return this.repository.atomic((db) => {
      ensureTables(db)
      return db
        .query<{ payload: string }, [string, string, string, string]>(
          `SELECT payload FROM model_mappings
           WHERE scope=? AND project_directory=? AND task_id=? AND persona=?
           ORDER BY revision`,
        )
        .all(key.scope, key.projectDirectory, key.taskID, key.persona)
        .map((row) => decode(row.payload))
    })
  }

  /** Read all applicable layers in one SQLite transaction for a consistent resolution snapshot. */
  layers(persona: WorkerPersonaType, taskID?: string): ModelMappingLayers {
    const parsedPersona = WorkerPersona.parse(persona)
    const parsedTaskID = taskID === undefined ? undefined : z.uuid().parse(taskID)
    return this.repository.atomic((db) => {
      ensureTables(db)
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
