import type { Database } from "bun:sqlite"
import { TaskSpecSchema } from "../task.ts"
import type { TaskRepository } from "../storage.ts"
import type { HostBackgroundObservation } from "./host.ts"
import { z } from "zod"

export type NativeIdleBinding = {
  projectDirectory: string
  projectID: string
  attemptID: string
  sessionID: string
  workspace: string
  assignedMessageID: string
}

export type NativeIdleReport = {
  observedAt: number
  inputID: string
  executionStartSequence: number
  eventSequence: number
  count: number
  kinds: { shell: number; subagent: number; image: number }
}

export type NativeIdleTerminal = {
  sequence: number
  eventID: string
  messageID: string
}

export type NativeIdleState = {
  version: 1
  binding: NativeIdleBinding
  revision: number
  lastEventSequence: number | null
  executionStartSequence: number | null
  report: NativeIdleReport | null
  pendingTerminal: NativeIdleTerminal | null
  terminal: NativeIdleTerminal | null
  invalidation: { reason: string; at: number; eventSequence?: number } | null
  staleEventSequence: number | null
}

const bindingSchema = z.object({
  projectDirectory: z.string().min(1),
  projectID: z.string().min(1),
  attemptID: z.string().min(1),
  sessionID: z.string().min(1),
  workspace: z.string().min(1),
  assignedMessageID: z.string().min(1),
})
const terminalSchema = z.object({
  sequence: z.number().int().nonnegative().safe(),
  eventID: z.string().min(1),
  messageID: z.string().min(1),
})
const stateSchema = z.object({
  version: z.literal(1),
  binding: bindingSchema,
  revision: z.number().int().positive().safe(),
  lastEventSequence: z.number().int().nonnegative().safe().nullable(),
  executionStartSequence: z.number().int().nonnegative().safe().nullable(),
  report: z
    .object({
      observedAt: z.number().finite(),
      inputID: z.string().min(1),
      executionStartSequence: z.number().int().nonnegative().safe(),
      eventSequence: z.number().int().nonnegative().safe(),
      count: z.number().int().nonnegative().safe(),
      kinds: z.object({
        shell: z.number().int().nonnegative().safe(),
        subagent: z.number().int().nonnegative().safe(),
        image: z.number().int().nonnegative().safe(),
      }),
    })
    .nullable(),
  pendingTerminal: terminalSchema.nullable(),
  terminal: terminalSchema.nullable(),
  invalidation: z
    .object({
      reason: z.string().min(1),
      at: z.number().finite(),
      eventSequence: z.number().int().nonnegative().safe().optional(),
    })
    .nullable(),
  staleEventSequence: z.number().int().nonnegative().safe().nullable(),
})

function sameBinding(a: NativeIdleBinding, b: NativeIdleBinding) {
  return (
    a.projectDirectory === b.projectDirectory &&
    a.projectID === b.projectID &&
    a.attemptID === b.attemptID &&
    a.sessionID === b.sessionID &&
    a.workspace === b.workspace &&
    a.assignedMessageID === b.assignedMessageID
  )
}

function sameAttempt(a: NativeIdleBinding, b: NativeIdleBinding) {
  return (
    a.projectDirectory === b.projectDirectory &&
    a.projectID === b.projectID &&
    a.attemptID === b.attemptID &&
    a.sessionID === b.sessionID &&
    a.workspace === b.workspace
  )
}

function initialState(binding: NativeIdleBinding): NativeIdleState {
  return {
    version: 1,
    binding,
    revision: 0,
    lastEventSequence: null,
    executionStartSequence: null,
    report: null,
    pendingTerminal: null,
    terminal: null,
    invalidation: null,
    staleEventSequence: null,
  }
}

function decodeRow(body: string, revision: number): NativeIdleState {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error("Native idle persistence is corrupt; preserve the workspace")
  }
  const result = stateSchema.safeParse(parsed)
  if (!result.success || result.data.revision !== revision)
    throw new Error("Native idle persistence is corrupt; preserve the workspace")
  return result.data
}

export type NativeIdleEventResult =
  | { status: "stale" | "seen" | "unbound"; revision?: number }
  | { status: "changed" | "terminal-pending"; revision: number }

export class NativeIdleStore {
  constructor(private readonly repository: TaskRepository) {
    repository.atomic((db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS runner_native_idle (
          project_directory TEXT NOT NULL,
          session_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          body TEXT NOT NULL,
          PRIMARY KEY(project_directory, session_id)
        );
      `),
    )
  }

  private row(db: Database, binding: NativeIdleBinding): NativeIdleState | undefined {
    const assigned = this.assignedBinding(db, binding.sessionID)
    if (!assigned || !sameBinding(assigned, binding))
      throw new Error("Native idle binding is stale or no longer owned; preserve the workspace")
    const row = db
      .query<{ revision: number; body: string }, [string, string]>(
        "SELECT revision,body FROM runner_native_idle WHERE project_directory=? AND session_id=?",
      )
      .get(binding.projectDirectory, binding.sessionID)
    if (!row) return undefined
    const state = decodeRow(row.body, row.revision)
    if (!sameAttempt(state.binding, binding))
      throw new Error("Native idle identity binding changed; preserve the workspace")
    if (!sameBinding(state.binding, binding))
      return this.save(db, {
        ...state,
        binding,
        pendingTerminal: null,
        terminal: null,
        invalidation: {
          reason: "Assigned native worker input changed; previous idle evidence is stale",
          at: Date.now(),
        },
      })
    return state
  }

  private saveDiagnostic(db: Database, state: NativeIdleState) {
    // Stale-event bookkeeping is diagnostic-only; it must not advance the safety CAS revision.
    const result = db
      .query(
        `UPDATE runner_native_idle SET body=?
         WHERE project_directory=? AND session_id=? AND revision=?`,
      )
      .run(
        JSON.stringify(state),
        state.binding.projectDirectory,
        state.binding.sessionID,
        state.revision,
      )
    if (result.changes !== 1) throw new Error("Native idle diagnostic update lost its durable row")
    return state
  }

  private assignedBinding(db: Database, sessionID: string): NativeIdleBinding | undefined {
    const row = db
      .query<
        {
          attempt_id: string
          session_id: string
          message_id: string
          workspace: string
          project_directory: string
          task_body: string
        },
        [string, string]
      >(
        `SELECT a.id AS attempt_id,a.session_id,a.message_id,a.workspace,
                p.project_directory,t.body AS task_body
         FROM runner_attempts a
         JOIN runner_plans p ON p.id=a.plan_id
         JOIN tasks t ON t.id=a.task_id AND t.project_directory=p.project_directory
         WHERE p.project_directory=? AND a.session_id=?`,
      )
      .get(this.repository.projectDirectory, sessionID)
    if (!row) return undefined
    let task
    try {
      task = TaskSpecSchema.parse(JSON.parse(row.task_body))
    } catch {
      throw new Error("Native idle assignment is corrupt; preserve the workspace")
    }
    if (
      task.provenance.projectDirectory !== row.project_directory ||
      task.provenance.projectID === ""
    )
      throw new Error("Native idle assignment identity is corrupt; preserve the workspace")
    return {
      projectDirectory: row.project_directory,
      projectID: task.provenance.projectID,
      attemptID: row.attempt_id,
      sessionID: row.session_id,
      workspace: row.workspace,
      assignedMessageID: row.message_id,
    }
  }

  private save(db: Database, state: NativeIdleState) {
    const revision = state.revision + 1
    const next = { ...state, revision }
    db.query(
      `INSERT INTO runner_native_idle(project_directory,session_id,revision,body)
       VALUES(?,?,?,?)
       ON CONFLICT(project_directory,session_id) DO UPDATE SET
         revision=excluded.revision,body=excluded.body`,
    ).run(state.binding.projectDirectory, state.binding.sessionID, revision, JSON.stringify(next))
    return next
  }

  read(binding: NativeIdleBinding): NativeIdleState | undefined {
    return this.repository.atomic((db) => this.row(db, binding))
  }

  assignmentForSession(sessionID: string): NativeIdleBinding | undefined {
    return this.repository.atomic((db) => this.assignedBinding(db, sessionID))
  }

  recordIdle(
    binding: NativeIdleBinding,
    report: NativeIdleReport,
    expectedRevision: number,
  ): boolean {
    return this.repository.atomic((db) => {
      const current = this.row(db, binding) ?? initialState(binding)
      if (
        current.revision !== expectedRevision ||
        current.lastEventSequence !== report.eventSequence ||
        current.executionStartSequence !== report.executionStartSequence ||
        current.pendingTerminal !== null ||
        current.terminal !== null
      )
        return false
      this.save(db, {
        ...current,
        report,
        pendingTerminal: null,
        terminal: null,
        invalidation: null,
      })
      return true
    })
  }

  observeEvent(
    binding: NativeIdleBinding,
    type: string,
    sequence: number | undefined,
    eventID?: string,
    terminalMessageID?: string,
  ): NativeIdleEventResult {
    return this.repository.atomic((db) => {
      const current = this.row(db, binding) ?? initialState(binding)
      if (sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 0) {
        this.save(db, {
          ...current,
          executionStartSequence: null,
          pendingTerminal: null,
          terminal: null,
          invalidation: {
            reason: `Native ${type} had no trustworthy durable session sequence`,
            at: Date.now(),
          },
        })
        return { status: "changed" as const, revision: current.revision + 1 }
      }
      if (current.lastEventSequence !== null && sequence < current.lastEventSequence) {
        const saved =
          current.report &&
          (current.staleEventSequence === null || sequence > current.staleEventSequence)
            ? this.saveDiagnostic(db, { ...current, staleEventSequence: sequence })
            : current
        return { status: "stale" as const, revision: saved.revision }
      }
      if (sequence === current.lastEventSequence)
        return { status: "seen" as const, revision: current.revision }

      const next: NativeIdleState = { ...current, lastEventSequence: sequence }
      if (type === "session.execution.started") {
        next.executionStartSequence = sequence
        next.pendingTerminal = null
        next.terminal = null
        next.invalidation = {
          reason:
            "A newer native foreground execution started after the last experimental.idle report",
          at: Date.now(),
          eventSequence: sequence,
        }
      } else if (type === "session.execution.succeeded") {
        const validTerminal =
          current.report !== null &&
          current.invalidation === null &&
          current.executionStartSequence === current.report.executionStartSequence &&
          sequence > current.report.eventSequence &&
          typeof eventID === "string" &&
          eventID.length > 0 &&
          typeof terminalMessageID === "string" &&
          terminalMessageID.length > 0
        if (validTerminal) {
          next.pendingTerminal = { sequence, eventID, messageID: terminalMessageID }
          next.terminal = null
          const saved = this.save(db, next)
          return { status: "terminal-pending" as const, revision: saved.revision }
        }
        next.pendingTerminal = null
        next.terminal = null
        next.invalidation = {
          reason: "Native execution success did not match the current experimental.idle execution",
          at: Date.now(),
          eventSequence: sequence,
        }
      } else {
        next.pendingTerminal = null
        next.terminal = null
        next.invalidation = {
          reason: `Native ${type} was observed after the last experimental.idle background report`,
          at: Date.now(),
          eventSequence: sequence,
        }
      }
      const saved = this.save(db, next)
      return { status: "changed" as const, revision: saved.revision }
    })
  }

  confirmSuccess(
    binding: NativeIdleBinding,
    inputID: string | undefined,
    terminal: NativeIdleTerminal,
    expectedRevision: number,
  ): boolean {
    return this.repository.atomic((db) => {
      const current = this.row(db, binding)
      if (
        !current ||
        current.revision !== expectedRevision ||
        current.lastEventSequence !== terminal.sequence ||
        current.pendingTerminal?.sequence !== terminal.sequence ||
        current.pendingTerminal.eventID !== terminal.eventID ||
        current.pendingTerminal.messageID !== terminal.messageID ||
        current.invalidation !== null ||
        current.report === null ||
        current.report.inputID !== inputID ||
        terminal.sequence <= current.report.eventSequence
      )
        return false
      this.save(db, { ...current, terminal, pendingTerminal: null })
      return true
    })
  }

  invalidate(
    binding: NativeIdleBinding,
    reason: string,
    expectedRevision?: number,
    eventSequence?: number,
  ): boolean {
    return this.repository.atomic((db) => {
      const current = this.row(db, binding) ?? initialState(binding)
      if (expectedRevision !== undefined && current.revision !== expectedRevision) return false
      this.save(db, {
        ...current,
        pendingTerminal: null,
        terminal: null,
        invalidation: {
          reason,
          at: Date.now(),
          ...(eventSequence === undefined ? {} : { eventSequence }),
        },
      })
      return true
    })
  }

  background(binding: NativeIdleBinding, state?: NativeIdleState): HostBackgroundObservation {
    const current = state ?? this.read(binding)
    if (!current)
      return {
        state: "unknown",
        source: "experimental.idle",
        reason: "No experimental.idle background report was observed for the assigned attempt",
      }
    if (current.invalidation)
      return {
        state: "unknown",
        source: "experimental.idle",
        reason: current.invalidation.reason,
        observedAt: current.invalidation.at,
      }
    if (!current.report)
      return {
        state: "unknown",
        source: "experimental.idle",
        reason: "No experimental.idle background report was observed for the assigned attempt",
      }
    if (current.report.count === 0 && !current.terminal)
      return {
        state: "unknown",
        source: "experimental.idle",
        reason: "Zero-background idle report has no matching confirmed native success",
        observedAt: current.report.observedAt,
      }
    return {
      state: "observed",
      source: "experimental.idle",
      ...current.binding,
      ...current.report,
      ...(current.terminal
        ? {
            terminalSequence: current.terminal.sequence,
            terminalEventID: current.terminal.eventID,
            terminalMessageID: current.terminal.messageID,
          }
        : {}),
      ...(current.staleEventSequence === null
        ? {}
        : { staleEventSequence: current.staleEventSequence }),
    }
  }
}
