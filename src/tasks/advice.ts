import type { Database } from "bun:sqlite"
import { z } from "zod"
import { schemaModules } from "../database-schema.ts"
import { canonical } from "../identity.ts"
import type { TaskRepository } from "../storage.ts"
import { TaskSpecSchema } from "../task.ts"

const AdviceLine = z
  .string()
  .min(1)
  .regex(/\S/, "Advice must contain non-whitespace text")
  .regex(/^[^\r\n]+$/, "Advice entries must be a single line")

const AdviceReference = z.strictObject({
  kind: z.enum(["source", "mini-skill"]),
  reference: z
    .string()
    .min(1)
    .max(512)
    .regex(/\S/, "References must contain non-whitespace text")
    .regex(/^[^\r\n]+$/, "References must be a single line"),
  description: z
    .string()
    .min(1)
    .max(160)
    .regex(/\S/, "Descriptions must contain non-whitespace text")
    .regex(/^[^\r\n]+$/, "Descriptions must be a single line")
    .optional(),
})

const AdviceContent = {
  findings: z.array(AdviceLine).min(1).max(4),
  implementationAdvice: z.array(AdviceLine).min(1).max(4),
  references: z.array(AdviceReference).max(4).default([]),
}

export const TaskAdviceInput = z.strictObject({
  taskID: z.uuid(),
  specRevision: z.int().positive(),
  requestID: z.string().min(1).max(200).regex(/\S/, "requestID must contain non-whitespace text"),
  expectedRevision: z.int().nonnegative(),
  ...AdviceContent,
})
export type TaskAdviceInput = z.infer<typeof TaskAdviceInput>

export const TaskAdviceRecord = z.strictObject({
  projectDirectory: z.string().min(1),
  taskID: z.uuid(),
  specRevision: z.int().positive(),
  requestID: z.string().min(1),
  revision: z.int().positive(),
  ...AdviceContent,
  provenance: z.strictObject({
    sessionID: z.string().min(1),
    agent: z.string().min(1),
    createdAt: z.iso.datetime(),
  }),
})
export type TaskAdviceRecord = z.infer<typeof TaskAdviceRecord>

/** Bound worker-facing history without discarding durable corrections or refusing new ones. */
export const TASK_ADVICE_HISTORY_PROJECTION_LIMIT = 20

export const TaskAdviceSnapshot = z.strictObject({
  current: TaskAdviceRecord,
  history: z.array(TaskAdviceRecord).max(TASK_ADVICE_HISTORY_PROJECTION_LIMIT),
  historyCount: z.int().nonnegative(),
  historyTruncated: z.boolean(),
})
export type TaskAdviceSnapshot = z.infer<typeof TaskAdviceSnapshot>

export const TaskAdviceReceipt = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("recorded"),
    advice: TaskAdviceRecord,
  }),
  z.strictObject({
    status: z.literal("replayed"),
    advice: TaskAdviceRecord,
  }),
  z.strictObject({
    status: z.literal("conflict"),
    taskID: z.uuid(),
    message: z.string(),
    expectedRevision: z.int().nonnegative().optional(),
    currentRevision: z.int().nonnegative().optional(),
  }),
])
export type TaskAdviceReceipt = z.infer<typeof TaskAdviceReceipt>

type AdviceRow = { payload: string; record_json: string }
type AdviceRecordRow = { record_json: string }

function hasAdviceTable(db: Database): boolean {
  return Boolean(
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='task_advice'",
      )
      .get(),
  )
}

/** Task advice is installed at repository startup, never as a tool-write side effect. */
export function installTaskAdviceSchema(repository: TaskRepository) {
  repository.installSchema(
    "task-advice",
    schemaModules["task-advice"].generation,
    schemaModules["task-advice"].tables,
    (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_advice (
          project_directory TEXT NOT NULL,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          request_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision > 0),
          payload TEXT NOT NULL,
          record_json TEXT NOT NULL,
          PRIMARY KEY(project_directory, request_id),
          UNIQUE(project_directory, task_id, revision)
        );
        CREATE INDEX IF NOT EXISTS task_advice_history
          ON task_advice(project_directory, task_id, revision);
        CREATE TRIGGER IF NOT EXISTS task_advice_no_update BEFORE UPDATE ON task_advice
        BEGIN SELECT RAISE(ABORT, 'Task advice history is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS task_advice_no_delete BEFORE DELETE ON task_advice
        BEGIN SELECT RAISE(ABORT, 'Task advice history is append-only'); END;
      `)
    },
  )
}

/** Reads only the task-owned advice projection; legacy reads never create its table. */
export function taskAdviceSnapshot(
  repository: TaskRepository,
  taskID: string,
): TaskAdviceSnapshot | null {
  return repository.atomic((db) => {
    if (!hasAdviceTable(db)) throw new Error("Task advice schema is not installed")
    const taskRow = db
      .query<{ body: string }, [string, string]>(
        "SELECT body FROM tasks WHERE project_directory=? AND id=?",
      )
      .get(repository.projectDirectory, taskID)
    if (!taskRow) return null
    const task = TaskSpecSchema.parse(JSON.parse(taskRow.body))
    const historyCount = db
      .query<{ count: number }, [string, string]>(
        "SELECT COUNT(*) AS count FROM task_advice WHERE project_directory=? AND task_id=?",
      )
      .get(repository.projectDirectory, taskID)!.count
    if (historyCount === 0) return null
    const records = db
      .query<AdviceRecordRow, [string, string, number]>(
        `SELECT record_json FROM task_advice
         WHERE project_directory=? AND task_id=? ORDER BY revision DESC LIMIT ?`,
      )
      .all(repository.projectDirectory, taskID, TASK_ADVICE_HISTORY_PROJECTION_LIMIT)
      .reverse()
      .map((row) => TaskAdviceRecord.parse(JSON.parse(row.record_json)))
    const firstRevision = historyCount - records.length + 1
    records.forEach((record, index) => {
      if (
        record.projectDirectory !== repository.projectDirectory ||
        record.taskID !== taskID ||
        record.specRevision !== task.revision ||
        record.revision !== firstRevision + index
      )
        throw new Error("Task advice history does not match its project/task revision")
    })
    return TaskAdviceSnapshot.parse({
      current: records.at(-1),
      history: records,
      historyCount,
      historyTruncated: historyCount > records.length,
    })
  })
}

/** Append task-bound advice without changing the immutable task specification. */
export function recordTaskAdvice(
  repository: TaskRepository,
  input: unknown,
  actor: { sessionID: string; agent: string },
): TaskAdviceReceipt {
  const parsed = TaskAdviceInput.parse(input)
  const requestPayload = canonical({
    taskID: parsed.taskID,
    specRevision: parsed.specRevision,
    expectedRevision: parsed.expectedRevision,
    findings: parsed.findings,
    implementationAdvice: parsed.implementationAdvice,
    references: parsed.references,
  })

  return repository.atomic((db) => {
    const tableExists = hasAdviceTable(db)
    const existing = tableExists
      ? db
          .query<AdviceRow, [string, string]>(
            "SELECT payload,record_json FROM task_advice WHERE project_directory=? AND request_id=?",
          )
          .get(repository.projectDirectory, parsed.requestID)
      : undefined
    if (existing) {
      if (existing.payload !== requestPayload)
        return TaskAdviceReceipt.parse({
          status: "conflict",
          taskID: parsed.taskID,
          message: "requestID already identifies different task advice content",
        })
      return TaskAdviceReceipt.parse({
        status: "replayed",
        advice: JSON.parse(existing.record_json),
      })
    }

    const taskRow = db
      .query<{ body: string }, [string, string]>(
        "SELECT body FROM tasks WHERE project_directory=? AND id=?",
      )
      .get(repository.projectDirectory, parsed.taskID)
    if (!taskRow) throw new Error("Task not found in this project")
    const task = TaskSpecSchema.parse(JSON.parse(taskRow.body))
    if (task.revision !== parsed.specRevision)
      return TaskAdviceReceipt.parse({
        status: "conflict",
        taskID: parsed.taskID,
        message: "Task specification revision is unavailable",
      })

    const currentRevision = tableExists
      ? (db
          .query<{ revision: number | null }, [string, string]>(
            "SELECT MAX(revision) AS revision FROM task_advice WHERE project_directory=? AND task_id=?",
          )
          .get(repository.projectDirectory, parsed.taskID)?.revision ?? 0)
      : 0
    if (parsed.expectedRevision !== currentRevision)
      return TaskAdviceReceipt.parse({
        status: "conflict",
        taskID: parsed.taskID,
        expectedRevision: parsed.expectedRevision,
        currentRevision,
        message: "Task advice revision changed; read current advice before correcting",
      })

    const advice = TaskAdviceRecord.parse({
      projectDirectory: repository.projectDirectory,
      taskID: parsed.taskID,
      specRevision: parsed.specRevision,
      requestID: parsed.requestID,
      revision: currentRevision + 1,
      findings: parsed.findings,
      implementationAdvice: parsed.implementationAdvice,
      references: parsed.references,
      provenance: {
        sessionID: actor.sessionID,
        agent: actor.agent,
        createdAt: new Date().toISOString(),
      },
    })
    db.query(
      `INSERT INTO task_advice
       (project_directory,task_id,request_id,revision,payload,record_json) VALUES(?,?,?,?,?,?)`,
    ).run(
      repository.projectDirectory,
      parsed.taskID,
      parsed.requestID,
      advice.revision,
      requestPayload,
      JSON.stringify(advice),
    )
    repository.changed()
    return TaskAdviceReceipt.parse({ status: "recorded", advice })
  })
}
