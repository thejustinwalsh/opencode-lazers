import { DateTime } from "effect"
import type { Database } from "bun:sqlite"
import type { Tool } from "@opencode/schema/tool"
import { TaskSpecSchema } from "../task.ts"
import type { RunnerStore } from "../runner/store.ts"
import { privacyStats, safeError, safeText } from "../trajectory/privacy.ts"
import { publicProgressError, visibleProgressText } from "./privacy.ts"
import { ProgressInput } from "./schema.ts"

export type ProgressSource =
  "tool-commentary" | "tool-hook" | "native-event" | "runtime" | "recovery" | "reminder"

export type ProgressKind =
  | "commentary"
  | "tool"
  | "visible-text"
  | "step"
  | "usage-snapshot"
  | "provider-retry"
  | "execution-outcome"
  | "outcome-snapshot"
  | "shell"
  | "verification"
  | "artifact"
  | "gap"
  | "reminder"

export type ProgressAssignment = {
  projectID: string
  taskID: string
  planID: string
  attemptID: string
  attemptState: string
  sessionID: string
  assignedMessageID: string
  workspace: string
}

export type ReminderOwnership = {
  lazersKind: "worker-progress-reminder"
  lazersAssignedMessageID?: string
  lazersProjectID: string
  lazersProjectDirectory: string
  lazersPlanID: string
  lazersTaskID: string
  lazersAttemptID: string
  lazersSessionID: string
  lazersMessageID: string
}

export type ReminderClaim = {
  attemptID: string
  sessionID: string
  messageID: string
  sequence: number
  attemptNumber: number
  ownership: ReminderOwnership
}

export type ReminderDelivery = "admitted" | "unknown" | "rejected"

type Fact = {
  source: ProgressSource
  kind: ProgressKind
  dedupeKey: string
  at: number
  payload: Record<string, unknown>
  eventID?: string
  callID?: string
  messageID?: string
}

type ToolCall = {
  tool: string
  sessionID: string
  agent: string
  messageID: string
  callID: string
  status: "completed" | "error"
  result?: Tool.Result
  error?: Tool.Error
}

type JsonObject = Record<string, unknown>

const object = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

function dateMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (value === null || value === undefined) return undefined
  try {
    return DateTime.toEpochMillis(value as DateTime.DateTime)
  } catch {
    return undefined
  }
}

function visibleContent(
  value: unknown,
  stats: ReturnType<typeof privacyStats>,
): string | undefined {
  if (typeof value === "string") return visibleProgressText(value, stats)
  if (!Array.isArray(value)) return undefined
  const visible = value.flatMap((part) => {
    const entry = object(part)
    return entry?.type === "text" && typeof entry.text === "string" ? [entry.text] : []
  })
  return visible.length
    ? safeText(visible.map((part) => visibleProgressText(part, stats)).join("\n"), stats)
    : undefined
}

function errorView(value: unknown, stats: ReturnType<typeof privacyStats>) {
  return publicProgressError(value, stats)
}

function measuredUsage(value: unknown, costValue?: unknown) {
  const tokens = object(value)
  const cache = object(tokens?.cache)
  const cost = number(costValue)
  return {
    input: number(tokens?.input) ?? null,
    output: number(tokens?.output) ?? null,
    reasoning: number(tokens?.reasoning) ?? null,
    cacheRead: number(cache?.read) ?? null,
    cacheWrite: number(cache?.write) ?? null,
    costUSD: cost ?? null,
  }
}

function parseSources(textValue: string): ProgressSource[] {
  try {
    const parsed: unknown = JSON.parse(textValue)
    if (Array.isArray(parsed))
      return parsed.filter((source): source is ProgressSource => typeof source === "string")
  } catch {
    // Older or damaged rows still retain their original source column.
  }
  return []
}

function parseIDs(textValue: string): string[] {
  try {
    const parsed: unknown = JSON.parse(textValue)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

function mergeObjects(previous: JsonObject, incoming: JsonObject): JsonObject {
  const merged: JsonObject = { ...previous }
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === null) continue
    const old = merged[key]
    const oldObject = object(old)
    const nextObject = object(value)
    merged[key] = oldObject && nextObject ? mergeObjects(oldObject, nextObject) : value
  }
  return merged
}

function mergeObservations(previous: unknown, incoming: unknown): JsonObject[] {
  const values = [
    ...(Array.isArray(previous) ? previous : []),
    ...(Array.isArray(incoming) ? incoming : []),
  ]
  const unique = new Map<string, JsonObject>()
  for (const value of values) {
    const item = object(value)
    if (!item) continue
    const identity =
      text(item.eventID) ??
      `${text(item.source) ?? "unknown"}:${text(item.eventType) ?? "unknown"}:${number(item.at) ?? "unknown"}`
    unique.set(identity, item)
  }
  return [...unique.values()].slice(-25)
}

const toolStatusRank: Record<string, number> = {
  "not-executed": 0,
  running: 1,
  succeeded: 2,
  failed: 2,
}

function mergeFactPayload(
  kind: ProgressKind,
  previous: JsonObject,
  incoming: JsonObject,
): JsonObject {
  const merged = mergeObjects(previous, incoming)
  const observations = mergeObservations(previous.observations, incoming.observations)
  if (observations.length) merged.observations = observations
  if (kind === "tool") {
    const oldStatus = text(previous.status)
    const newStatus = text(incoming.status)
    if (
      oldStatus &&
      newStatus &&
      (toolStatusRank[oldStatus] ?? -1) > (toolStatusRank[newStatus] ?? -1)
    )
      merged.status = oldStatus
  }
  if (kind === "step") {
    const rank: Record<string, number> = { started: 0, ended: 1, failed: 2 }
    const oldStatus = text(previous.status)
    const newStatus = text(incoming.status)
    if (oldStatus && newStatus && (rank[oldStatus] ?? -1) > (rank[newStatus] ?? -1))
      merged.status = oldStatus
  }
  if (kind === "shell") {
    const terminal = new Set(["exited", "timeout", "killed"])
    const oldStatus = text(previous.status)
    const newStatus = text(incoming.status)
    if (oldStatus && newStatus && terminal.has(oldStatus) && !terminal.has(newStatus))
      merged.status = oldStatus
  }
  return merged
}

const activeAttempt = (state: string) => ["preparing", "running", "verifying"].includes(state)

function sameReminderOwnership(value: unknown, expected: ReminderOwnership): boolean {
  const actual = object(value)
  return Boolean(
    actual &&
    actual.lazersKind === expected.lazersKind &&
    actual.lazersProjectID === expected.lazersProjectID &&
    actual.lazersProjectDirectory === expected.lazersProjectDirectory &&
    actual.lazersPlanID === expected.lazersPlanID &&
    actual.lazersTaskID === expected.lazersTaskID &&
    actual.lazersAttemptID === expected.lazersAttemptID &&
    actual.lazersSessionID === expected.lazersSessionID &&
    actual.lazersMessageID === expected.lazersMessageID &&
    actual.lazersAssignedMessageID === expected.lazersAssignedMessageID,
  )
}

/**
 * One append-only, project-scoped ordered log shared by model commentary,
 * OpenCode observations, recovery and runtime verification facts.
 */
export class ProgressRecorder {
  constructor(
    readonly store: RunnerStore,
    readonly projectID: string,
  ) {}

  private assignmentFromRow(row: {
    plan_id: string
    task_id: string
    attempt_id: string
    attempt_state: string
    session_id: string
    message_id: string
    workspace: string
    project_directory: string
    task_body: string
  }): ProgressAssignment | undefined {
    if (row.project_directory !== this.store.repository.projectDirectory) return undefined
    const task = TaskSpecSchema.parse(JSON.parse(row.task_body))
    if (
      task.id !== row.task_id ||
      task.provenance.projectID !== this.projectID ||
      task.provenance.projectDirectory !== row.project_directory
    )
      return undefined
    return {
      projectID: task.provenance.projectID,
      taskID: task.id,
      planID: row.plan_id,
      attemptID: row.attempt_id,
      attemptState: row.attempt_state,
      sessionID: row.session_id,
      assignedMessageID: row.message_id,
      workspace: row.workspace,
    }
  }

  private assignmentQuery(db: Database, where: "session" | "attempt", value: string) {
    const condition = where === "session" ? "a.session_id=?" : "a.id=?"
    const row = db
      .query<
        {
          plan_id: string
          task_id: string
          attempt_id: string
          attempt_state: string
          session_id: string
          message_id: string
          workspace: string
          project_directory: string
          task_body: string
        },
        [string, string, string]
      >(
        `SELECT a.plan_id,a.task_id,a.id AS attempt_id,a.state AS attempt_state,
                a.session_id,a.message_id,a.workspace,p.project_directory,t.body AS task_body
         FROM runner_attempts a
         JOIN runner_plans p ON p.id=a.plan_id
         JOIN tasks t ON t.id=a.task_id AND t.project_directory=p.project_directory
         WHERE p.project_directory=? AND t.project_directory=? AND ${condition}`,
      )
      .get(this.store.repository.projectDirectory, this.store.repository.projectDirectory, value)
    return row ? this.assignmentFromRow(row) : undefined
  }

  assignmentForSession(sessionID: string): ProgressAssignment | undefined {
    return this.store.atomic((db) => this.assignmentQuery(db, "session", sessionID))
  }

  matchesAssignedInput(
    attemptID: string,
    sessionID: string,
    assignedMessageID: string,
    inputID: string | null | undefined,
  ): boolean {
    if (!inputID) return false
    return this.store.atomic((db) => {
      const assignment = this.assignmentQuery(db, "attempt", attemptID)
      if (
        !assignment ||
        assignment.sessionID !== sessionID ||
        assignment.assignedMessageID !== assignedMessageID
      )
        return false
      if (inputID === assignedMessageID) return true
      const claim = this.reminderClaimIn(db, attemptID, sessionID, inputID)
      return Boolean(
        claim &&
        claim.status === "admitted" &&
        sameReminderOwnership(claim.ownership, {
          lazersKind: "worker-progress-reminder",
          lazersAssignedMessageID: assignedMessageID,
          lazersProjectID: assignment.projectID,
          lazersProjectDirectory: this.store.repository.projectDirectory,
          lazersPlanID: assignment.planID,
          lazersTaskID: assignment.taskID,
          lazersAttemptID: attemptID,
          lazersSessionID: sessionID,
          lazersMessageID: inputID,
        }),
      )
    })
  }

  assignments(): ProgressAssignment[] {
    return this.store.atomic((db) => {
      const rows = db
        .query<
          {
            plan_id: string
            task_id: string
            attempt_id: string
            attempt_state: string
            session_id: string
            message_id: string
            workspace: string
            project_directory: string
            task_body: string
          },
          [string, string]
        >(
          `SELECT a.plan_id,a.task_id,a.id AS attempt_id,a.state AS attempt_state,
                  a.session_id,a.message_id,a.workspace,p.project_directory,t.body AS task_body
           FROM runner_attempts a
           JOIN runner_plans p ON p.id=a.plan_id
           JOIN tasks t ON t.id=a.task_id AND t.project_directory=p.project_directory
           WHERE p.project_directory=? AND t.project_directory=? ORDER BY a.started_at,a.number`,
        )
        .all(this.store.repository.projectDirectory, this.store.repository.projectDirectory)
      return rows.flatMap((row) => {
        const assignment = this.assignmentFromRow(row)
        return assignment ? [assignment] : []
      })
    })
  }

  private appendIn(db: Database, assignment: ProgressAssignment, fact: Fact): number {
    const directory = this.store.repository.projectDirectory
    const payload = JSON.stringify(fact.payload)
    const inserted = db
      .query(
        `INSERT OR IGNORE INTO runner_progress
         (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,source,
          sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        directory,
        assignment.projectID,
        assignment.planID,
        assignment.taskID,
        assignment.attemptID,
        assignment.sessionID,
        fact.at,
        fact.source,
        JSON.stringify([fact.source]),
        fact.kind,
        JSON.stringify(fact.eventID ? [fact.eventID] : []),
        fact.callID ?? null,
        fact.messageID ?? null,
        fact.dedupeKey,
        payload,
      )
    if (inserted.changes) {
      return db.query<{ seq: number }, []>("SELECT last_insert_rowid() AS seq").get()!.seq
    }

    const existing = db
      .query<
        {
          seq: number
          at: number
          source: string
          sources_json: string
          kind: string
          event_ids_json: string
          payload: string
        },
        [string, string]
      >(
        "SELECT seq,at,source,sources_json,kind,event_ids_json,payload FROM runner_progress WHERE project_directory=? AND dedupe_key=?",
      )
      .get(directory, fact.dedupeKey)
    if (!existing) throw new Error("Progress fact disappeared during append")
    let priorPayload: JsonObject = {}
    try {
      priorPayload = object(JSON.parse(existing.payload)) ?? {}
    } catch {
      // A repaired append replaces malformed JSON with only the current safe projection.
    }
    const nextKind =
      existing.kind === "tool" && fact.kind === "commentary" ? "commentary" : existing.kind
    const cumulative = fact.kind === "usage-snapshot" || fact.kind === "outcome-snapshot"
    const replaceCumulative = cumulative && fact.at >= existing.at
    const nextPayload = cumulative
      ? replaceCumulative
        ? fact.payload
        : priorPayload
      : mergeFactPayload(nextKind as ProgressKind, priorPayload, fact.payload)
    const sources = [
      ...new Set([...parseSources(existing.sources_json), existing.source, fact.source]),
    ]
    const eventIDs = [
      ...new Set([...parseIDs(existing.event_ids_json), ...(fact.eventID ? [fact.eventID] : [])]),
    ]
    db.query(
      `UPDATE runner_progress SET kind=?,payload=?,sources_json=?,event_ids_json=?,
       call_id=COALESCE(call_id,?),message_id=COALESCE(message_id,?),at=? WHERE seq=?`,
    ).run(
      nextKind,
      JSON.stringify(nextPayload),
      JSON.stringify(sources),
      JSON.stringify(eventIDs),
      fact.callID ?? null,
      fact.messageID ?? null,
      replaceCumulative ? fact.at : existing.at,
      existing.seq,
    )
    return existing.seq
  }

  private appendForSession(sessionID: string, fact: Fact): number | undefined {
    return this.store.atomic((db) => {
      const assignment = this.assignmentQuery(db, "session", sessionID)
      return assignment ? this.appendIn(db, assignment, fact) : undefined
    })
  }

  report(input: {
    sessionID: string
    agent: string
    callID: string
    messageID: string
    message: unknown
  }): { sequence: number; text: string } {
    if (input.agent !== "lazers-implementor")
      throw new Error("Only an assigned LAZERS implementor may report progress")
    const parsed = ProgressInput.parse({ message: input.message })
    const stats = privacyStats()
    const safeMessage = safeText(parsed.message, stats, 1200).trim()
    if (!safeMessage) throw new Error("Progress message is empty after privacy filtering")
    const result = this.store.atomic((db) => {
      const assignment = this.assignmentQuery(db, "session", input.sessionID)
      if (!assignment || !activeAttempt(assignment.attemptState))
        throw new Error("Progress reports require an active assigned worker session")
      return this.appendIn(db, assignment, {
        source: "tool-commentary",
        kind: "commentary",
        dedupeKey: `tool:${input.sessionID}:${input.callID}`,
        at: Date.now(),
        callID: input.callID,
        messageID: input.messageID,
        payload: { text: safeMessage },
      })
    })
    return { sequence: result, text: safeMessage }
  }

  recordToolHook(call: ToolCall): number | undefined {
    if (call.tool === "lazers_report_progress" || call.agent !== "lazers-implementor")
      return undefined
    const stats = privacyStats()
    const payload: Record<string, unknown> = {
      tool: safeText(call.tool, stats, 160),
      status: call.status === "error" ? "failed" : "succeeded",
    }
    if (call.status === "error") {
      const error = errorView(call.error, stats)
      if (error !== undefined) payload.error = error
    } else if (call.result) {
      const content = visibleContent(call.result.content, stats)
      if (content !== undefined) payload.content = content
      // Tool.Result.output is arbitrary data, not a public-content contract.
    }
    return this.appendForSession(call.sessionID, {
      source: "tool-hook",
      kind: "tool",
      dedupeKey: `tool:${call.sessionID}:${call.callID}`,
      at: Date.now(),
      callID: call.callID,
      messageID: call.messageID,
      payload,
    })
  }

  recordNativeEvent(value: unknown): number | undefined {
    const event = object(value)
    const data = object(event?.data)
    const type = text(event?.type)
    const sessionID = text(data?.sessionID)
    if (!event || !data || !type || !sessionID) return undefined
    const eventID = text(event.id)
    const at = number(event.created) ?? Date.now()
    const messageID = text(data.assistantMessageID)
    const stats = privacyStats()
    if (type === "session.synthetic")
      return eventID
        ? this.observeReminderAdmission(sessionID, data.metadata, eventID, at)
        : undefined
    let fact: Fact | undefined

    if (
      type === "session.tool.input.started" ||
      type === "session.tool.called" ||
      type === "session.tool.success" ||
      type === "session.tool.failed"
    ) {
      const callID = text(data.id)
      if (!callID) return undefined
      const payload: Record<string, unknown> = {
        ...(type === "session.tool.input.started" && text(data.name)
          ? { tool: safeText(text(data.name)!, stats, 160) }
          : {}),
        status:
          type === "session.tool.input.started" || type === "session.tool.called"
            ? data.executed === false
              ? "not-executed"
              : "running"
            : type === "session.tool.success"
              ? "succeeded"
              : "failed",
      }
      if (type === "session.tool.success" || type === "session.tool.failed") {
        const content = visibleContent(data.content, stats)
        if (content !== undefined) payload.content = content
      }
      if (type === "session.tool.failed") {
        const error = errorView(data.error, stats)
        if (error !== undefined) payload.error = error
      }
      payload.observations = [
        {
          source: "native-event",
          ...(eventID ? { eventID } : {}),
          eventType: type,
          at,
          status: payload.status,
          messageID: messageID ?? null,
          callID,
          ...(type === "session.tool.input.started" && text(data.name)
            ? { tool: safeText(text(data.name)!, stats, 160) }
            : {}),
        },
      ]
      fact = {
        source: "native-event",
        kind: "tool",
        dedupeKey: `tool:${sessionID}:${callID}`,
        at,
        eventID,
        callID,
        messageID,
        payload,
      }
    } else if (
      type === "session.step.started" ||
      type === "session.step.ended" ||
      type === "session.step.failed"
    ) {
      if (!messageID) return undefined
      const status = type.endsWith("started")
        ? "started"
        : type.endsWith("failed")
          ? "failed"
          : "ended"
      const payload: Record<string, unknown> = { status }
      const observedAgent = type === "session.step.started" ? text(data.agent) : undefined
      const model = type === "session.step.started" ? object(data.model) : undefined
      const providerID = text(model?.providerID)
      const modelID = text(model?.id)
      const variant = text(model?.variant)
      const route =
        providerID && modelID
          ? {
              providerID: safeText(providerID, stats, 200),
              modelID: safeText(modelID, stats, 300),
              variant: variant ? safeText(variant, stats, 200) : null,
            }
          : undefined
      if (observedAgent) payload.agent = safeText(observedAgent, stats, 200)
      if (route) payload.route = route
      if (type === "session.step.ended" || type === "session.step.failed") {
        payload.measurementBasis = "additive-step-measurement"
        payload.usage = measuredUsage(data.tokens, data.cost)
        if (text(data.finish)) payload.finish = safeText(text(data.finish)!, stats, 80)
      }
      const error = errorView(data.error, stats)
      if (error !== undefined) payload.error = error
      payload.observations = [
        {
          source: "native-event",
          ...(eventID ? { eventID } : {}),
          eventType: type,
          at,
          status,
          messageID,
          ...(observedAgent ? { agent: safeText(observedAgent, stats, 200) } : {}),
          ...(route ? { route } : {}),
          ...(type === "session.step.started" && number(data.started) !== undefined
            ? { startedAt: number(data.started) }
            : {}),
        },
      ]
      fact = {
        source: "native-event",
        kind: "step",
        dedupeKey: `step:${sessionID}:${messageID}`,
        at,
        eventID,
        messageID,
        payload,
      }
    } else if (type === "session.usage.updated") {
      fact = {
        source: "native-event",
        kind: "usage-snapshot",
        dedupeKey: `usage-snapshot:${sessionID}`,
        at,
        eventID,
        payload: {
          measurementBasis: "cumulative-session-snapshot",
          usage: measuredUsage(data.tokens, data.cost),
        },
      }
    } else if (type === "session.retry.scheduled") {
      if (!messageID) return undefined
      const attemptNumber = number(data.attempt)
      const error = errorView(data.error, stats)
      fact = {
        source: "native-event",
        kind: "provider-retry",
        dedupeKey: `retry:${sessionID}:${messageID}:${attemptNumber ?? "unknown"}`,
        at: number(data.at) ?? at,
        eventID,
        messageID,
        payload: {
          ...(attemptNumber !== undefined ? { attempt: attemptNumber } : {}),
          ...(error !== undefined ? { error } : {}),
        },
      }
    } else if (type.startsWith("session.execution.")) {
      const outcome = type.slice("session.execution.".length)
      if (!new Set(["started", "succeeded", "failed", "interrupted"]).has(outcome)) return undefined
      const error = errorView(data.error, stats)
      // Pinned OpenCode creates terminal idle messages from this exact event ID
      // (schema SessionMessage.ID.fromEvent; core session/message-updater.ts).
      const terminalMessageID = eventID?.replace(/^evt_/, "msg_")
      fact = {
        source: "native-event",
        kind: "execution-outcome",
        dedupeKey:
          outcome !== "started" && terminalMessageID
            ? `turn:${sessionID}:${terminalMessageID}`
            : `execution-event:${sessionID}:${eventID ?? `${outcome}:${at}`}`,
        at,
        eventID,
        messageID: outcome === "started" ? messageID : terminalMessageID,
        payload: {
          outcome,
          ...(error !== undefined ? { error } : {}),
        },
      }
    } else if (type === "session.shell.started" || type === "session.shell.ended") {
      const shell = object(data.shell)
      const shellID = text(shell?.id)
      if (!shell || !shellID) return undefined
      const payload: Record<string, unknown> = {
        shellID,
        status: text(shell.status) ?? (type.endsWith("started") ? "running" : "unknown"),
      }
      if (text(shell.command)) payload.command = safeText(text(shell.command)!, stats)
      if (number(shell.exit) !== undefined) payload.exit = number(shell.exit)
      const output = object(data.output)
      const shellOutput = text(output?.output)
      if (shellOutput) payload.output = safeText(shellOutput, stats)
      if (output?.truncated === true) payload.truncated = true
      fact = {
        source: "native-event",
        kind: "shell",
        dedupeKey: `shell:${sessionID}:${shellID}`,
        at: number(object(shell.time)?.started) ?? at,
        eventID,
        payload,
      }
    } else if (type === "session.text.ended") {
      if (!messageID || typeof data.ordinal !== "number" || typeof data.text !== "string")
        return undefined
      fact = {
        source: "native-event",
        kind: "visible-text",
        dedupeKey: `text:${sessionID}:${messageID}:${data.ordinal}`,
        at,
        eventID,
        messageID,
        payload: { text: safeText(data.text, stats) },
      }
    }
    return fact ? this.appendForSession(sessionID, fact) : undefined
  }

  /** Reconcile only retained public session messages; it never invokes execution. */
  reconcileMessages(sessionID: string, rawMessages: readonly unknown[]): void {
    this.reconcileReminder(sessionID, rawMessages)
    this.store.atomic((db) => {
      const assignment = this.assignmentQuery(db, "session", sessionID)
      if (!assignment) return
      const messages = rawMessages.slice(0, 10_000)
      for (const raw of messages) {
        const message = object(raw)
        const messageID = text(message?.id)
        if (!message || !messageID) continue
        const at = dateMillis(object(message.time)?.created) ?? Date.now()
        if (message.type === "assistant") {
          const parts = Array.isArray(message.content) ? message.content : []
          for (const [index, rawPart] of parts.entries()) {
            const part = object(rawPart)
            if (!part) continue
            const stats = privacyStats()
            if (part.type === "text" && typeof part.text === "string") {
              this.appendIn(db, assignment, {
                source: "recovery",
                kind: "visible-text",
                dedupeKey: `text:${sessionID}:${messageID}:${index}`,
                at,
                messageID,
                payload: { text: safeText(part.text, stats) },
              })
            } else if (part.type === "tool") {
              this.recordRecoveredToolIn(db, assignment, messageID, part, at)
            }
          }
          const tokens = object(message.tokens)
          const messageCost = number(message.cost)
          if (tokens || messageCost !== undefined) {
            this.appendIn(db, assignment, {
              source: "recovery",
              kind: "step",
              dedupeKey: `step:${sessionID}:${messageID}`,
              at,
              messageID,
              payload: {
                status: message.error ? "failed" : "ended",
                measurementBasis: "additive-step-measurement",
                usage: measuredUsage(tokens, messageCost),
                observations: [
                  {
                    source: "recovery",
                    eventType: "retained-assistant-message",
                    at,
                    status: message.error ? "failed" : "ended",
                    messageID,
                  },
                ],
                ...(message.error ? { error: errorView(message.error, privacyStats()) } : {}),
              },
            })
          }
          const retry = object(message.retry)
          if (retry) {
            const retryAttempt = number(retry.attempt)
            const error = errorView(retry.error, privacyStats())
            this.appendIn(db, assignment, {
              source: "recovery",
              kind: "provider-retry",
              dedupeKey: `retry:${sessionID}:${messageID}:${retryAttempt ?? "unknown"}`,
              at: number(retry.at) ?? at,
              messageID,
              payload: {
                ...(retryAttempt !== undefined ? { attempt: retryAttempt } : {}),
                ...(error !== undefined ? { error } : {}),
              },
            })
          }
          if (message.error) {
            this.appendIn(db, assignment, {
              source: "recovery",
              kind: "execution-outcome",
              dedupeKey: `assistant-error:${sessionID}:${messageID}`,
              at,
              messageID,
              payload: { outcome: "failed", error: errorView(message.error, privacyStats()) },
            })
          }
          continue
        }
        if (message.type === "shell") {
          const stats = privacyStats()
          const shellID = text(message.shellID)
          if (shellID) {
            const output = object(message.output)
            const shellOutput = text(output?.output)
            this.appendIn(db, assignment, {
              source: "recovery",
              kind: "shell",
              dedupeKey: `shell:${sessionID}:${shellID}`,
              at,
              messageID,
              payload: {
                shellID,
                status: text(message.status) ?? "unknown",
                ...(text(message.command)
                  ? { command: safeText(text(message.command)!, stats) }
                  : {}),
                ...(number(message.exit) !== undefined ? { exit: number(message.exit) } : {}),
                ...(shellOutput ? { output: safeText(shellOutput, stats) } : {}),
                ...(output?.truncated === true ? { truncated: true } : {}),
              },
            })
          }
          continue
        }
        if (message.type === "idle") {
          const outcome = text(message.outcome)
          const error = errorView(message.error, privacyStats())
          this.appendIn(db, assignment, {
            source: "recovery",
            kind: "execution-outcome",
            dedupeKey: `turn:${sessionID}:${messageID}`,
            at,
            messageID,
            payload: {
              outcome:
                outcome && ["succeeded", "failed", "interrupted"].includes(outcome)
                  ? outcome
                  : "unknown",
              ...(error !== undefined ? { error } : {}),
              basis: "retained-session-turn-marker",
            },
          })
          continue
        }
        if (message.type === "compaction") {
          this.appendIn(db, assignment, {
            source: "recovery",
            kind: "gap",
            dedupeKey: `compaction-gap:${sessionID}:${messageID}`,
            at,
            messageID,
            payload: {
              reason:
                "Session compaction may omit earlier public messages; the private summary is not retained in progress facts.",
            },
          })
        }
      }
      if (rawMessages.length > messages.length) {
        this.appendIn(db, assignment, {
          source: "recovery",
          kind: "gap",
          dedupeKey: `recovery-gap:${assignment.attemptID}:message-bound`,
          at: Date.now(),
          payload: { reason: "Retained public session context exceeded the recovery bound." },
        })
      }
      this.appendIn(db, assignment, {
        source: "recovery",
        kind: "gap",
        dedupeKey: `recovery-gap:${assignment.attemptID}:public-context-only`,
        at: Date.now(),
        payload: {
          reason:
            "The native event stream has no durable cursor and session.context is not guaranteed complete; facts outside retained public messages cannot be reconstructed.",
        },
      })
    })
  }

  private recordRecoveredToolIn(
    db: Database,
    assignment: ProgressAssignment,
    messageID: string,
    part: JsonObject,
    at: number,
  ) {
    const toolID = text(part.id)
    if (!toolID) return
    const state = object(part.state)
    const status = text(state?.status)
    const stats = privacyStats()
    const payload: Record<string, unknown> = {
      ...(text(part.name) ? { tool: safeText(text(part.name)!, stats, 160) } : {}),
      status:
        status === "completed"
          ? "succeeded"
          : status === "error"
            ? "failed"
            : status === "running" || status === "streaming"
              ? "running"
              : "not-executed",
      observations: [
        {
          source: "recovery",
          eventType: "retained-tool-message",
          at,
          status:
            status === "completed"
              ? "succeeded"
              : status === "error"
                ? "failed"
                : status === "running" || status === "streaming"
                  ? "running"
                  : "not-executed",
          messageID,
          ...(text(part.name) ? { tool: safeText(text(part.name)!, stats, 160) } : {}),
        },
      ],
    }
    if (status === "completed" || status === "error") {
      const content = visibleContent(state?.content, stats)
      if (content !== undefined) payload.content = content
    }
    if (status === "error") {
      const error = errorView(state?.error, stats)
      if (error !== undefined) payload.error = error
    }
    this.appendIn(db, assignment, {
      source: "recovery",
      kind: "tool",
      dedupeKey: `tool:${assignment.sessionID}:${toolID}`,
      at,
      callID: toolID,
      messageID,
      payload,
    })
  }

  recordSessionSnapshot(sessionID: string, value: unknown): number | undefined {
    const session = object(value)
    if (!session) return undefined
    const tokens = object(session.tokens)
    const cost = number(session.cost)
    if (!tokens && cost === undefined) return undefined
    const at = dateMillis(object(session.time)?.updated) ?? Date.now()
    return this.appendForSession(sessionID, {
      source: "recovery",
      kind: "usage-snapshot",
      dedupeKey: `usage-snapshot:${sessionID}`,
      at,
      payload: {
        measurementBasis: "cumulative-session-snapshot",
        usage: measuredUsage(tokens, cost),
      },
    })
  }

  recordSessionOutcome(sessionID: string, value: unknown): number | undefined {
    const session = object(value)
    const outcome = text(session?.outcome)
    if (!outcome || !["succeeded", "failed", "interrupted"].includes(outcome)) return undefined
    const at = dateMillis(object(session?.time)?.idle)
    if (at === undefined)
      return this.markRecoveryGap(
        sessionID,
        "Session outcome has no native idle boundary; no execution identity is inferred.",
        "outcome-identity",
      )
    return this.appendForSession(sessionID, {
      source: "recovery",
      kind: "outcome-snapshot",
      dedupeKey: `outcome-snapshot:${sessionID}`,
      at,
      // A session aggregate exposes no terminal event ID. Keep it non-additive,
      // separate from identified executions; time.idle can advance within 1 ms.
      payload: {
        outcome,
        basis: "cumulative-session-outcome-snapshot",
        additive: false,
        turnIdentity: "unavailable",
      },
    })
  }

  markRecoveryGap(sessionID: string, reason: string, category = "unavailable"): number | undefined {
    const stats = privacyStats()
    return this.store.atomic((db) => {
      const assignment = this.assignmentQuery(db, "session", sessionID)
      if (!assignment) return undefined
      const reminder = db
        .query<{ message_id: string | null; status: string }, [string, string]>(
          "SELECT message_id,status FROM runner_progress_reminders WHERE attempt_id=? AND session_id=?",
        )
        .get(assignment.attemptID, sessionID)
      if (reminder?.message_id && reminder.status === "dispatching")
        this.completeReminderIn(
          db,
          assignment.attemptID,
          sessionID,
          reminder.message_id,
          "unknown",
          Date.now(),
        )
      return this.appendIn(db, assignment, {
        source: "recovery",
        kind: "gap",
        dedupeKey: `recovery-gap:${assignment.attemptID}:${category}`,
        at: Date.now(),
        payload: { reason: safeText(reason, stats, 500) },
      })
    })
  }

  recordVerification(attemptID: string, effectID: string, receipt: unknown): number | undefined {
    const assignment = this.store.atomic((db) => this.assignmentQuery(db, "attempt", attemptID))
    const result = object(receipt)
    if (!assignment || !result) return undefined
    const exitCode = number(result.exitCode)
    const timedOut = typeof result.timedOut === "boolean" ? result.timedOut : null
    const unchanged = typeof result.unchanged === "boolean" ? result.unchanged : null
    const identityMatches =
      typeof result.inputIdentity === "string" &&
      typeof result.artifact === "string" &&
      result.inputIdentity === result.artifact
    const passed = exitCode === 0 && timedOut === false && unchanged === true && identityMatches
    return this.store.atomic((db) =>
      this.appendIn(db, assignment, {
        source: "runtime",
        kind: "verification",
        dedupeKey: `verification:${attemptID}:${effectID}`,
        at: number(result.endedAt) ?? Date.now(),
        payload: {
          checkID: text(result.id) ?? "unknown",
          result: passed ? "passed" : "failed",
          exitCode: exitCode ?? null,
          timedOut,
          unchanged,
          ...(text(result.artifact) ? { artifact: text(result.artifact) } : {}),
          ...(text(result.command)
            ? { command: safeText(text(result.command)!, privacyStats()) }
            : {}),
          startedAt: number(result.startedAt) ?? null,
          endedAt: number(result.endedAt) ?? null,
        },
      }),
    )
  }

  recordVerificationError(
    attemptID: string,
    effectID: string,
    checkID: string,
    error: unknown,
  ): number | undefined {
    const assignment = this.store.atomic((db) => this.assignmentQuery(db, "attempt", attemptID))
    if (!assignment) return undefined
    const stats = privacyStats()
    return this.store.atomic((db) =>
      this.appendIn(db, assignment, {
        source: "runtime",
        kind: "verification",
        dedupeKey: `verification:${attemptID}:${effectID}`,
        at: Date.now(),
        payload: {
          checkID: safeText(checkID, stats, 120),
          result: "unknown",
          error: safeError(error, stats),
        },
      }),
    )
  }

  recordArtifact(attemptID: string, commit: string): number | undefined {
    const assignment = this.store.atomic((db) => this.assignmentQuery(db, "attempt", attemptID))
    if (!assignment) return undefined
    return this.store.atomic((db) =>
      this.appendIn(db, assignment, {
        source: "runtime",
        kind: "artifact",
        dedupeKey: `artifact:${attemptID}:${commit}`,
        at: Date.now(),
        payload: { commit: safeText(commit, privacyStats(), 128) },
      }),
    )
  }

  recordAttemptOutcome(attemptID: string, outcome: string, reason?: string): number | undefined {
    const assignment = this.store.atomic((db) => this.assignmentQuery(db, "attempt", attemptID))
    if (!assignment) return undefined
    const stats = privacyStats()
    return this.store.atomic((db) =>
      this.appendIn(db, assignment, {
        source: "runtime",
        kind: "execution-outcome",
        dedupeKey: `runtime-outcome:${attemptID}:${outcome}`,
        at: Date.now(),
        payload: {
          outcome: safeText(outcome, stats, 120),
          ...(reason ? { reason: safeText(reason, stats, 500) } : {}),
          basis: "runtime observation; not acceptance authority",
        },
      }),
    )
  }

  claimReminder(sessionID: string, message: string, messageID: string): ReminderClaim | undefined {
    const stats = privacyStats()
    const safeMessage = safeText(message, stats, 500)
    return this.store.atomic((db) => {
      const assignment = this.assignmentQuery(db, "session", sessionID)
      if (!assignment || !activeAttempt(assignment.attemptState)) return undefined
      const existing = db
        .query<
          {
            session_id: string
            message_id: string | null
            ownership_json: string | null
            attempts: number
            status: string
          },
          [string]
        >(
          "SELECT session_id,message_id,ownership_json,attempts,status FROM runner_progress_reminders WHERE attempt_id=?",
        )
        .get(assignment.attemptID)
      let attemptNumber = 1
      let stableMessageID = messageID
      if (existing) {
        if (
          existing.session_id !== sessionID ||
          !existing.message_id ||
          existing.status !== "rejected" ||
          existing.attempts >= 2
        )
          return undefined
        stableMessageID = existing.message_id
      }
      const ownership: ReminderOwnership = {
        lazersKind: "worker-progress-reminder",
        lazersAssignedMessageID: assignment.assignedMessageID,
        lazersProjectID: assignment.projectID,
        lazersProjectDirectory: this.store.repository.projectDirectory,
        lazersPlanID: assignment.planID,
        lazersTaskID: assignment.taskID,
        lazersAttemptID: assignment.attemptID,
        lazersSessionID: assignment.sessionID,
        lazersMessageID: stableMessageID,
      }
      if (existing) {
        let existingOwnership: unknown
        try {
          existingOwnership = existing.ownership_json
            ? JSON.parse(existing.ownership_json)
            : undefined
        } catch {
          return undefined
        }
        if (!sameReminderOwnership(existingOwnership, ownership)) return undefined
        attemptNumber = existing.attempts + 1
        const changed = db
          .query(
            `UPDATE runner_progress_reminders SET status='dispatching',attempts=?,updated_at=?
             WHERE attempt_id=? AND session_id=? AND message_id=? AND status='rejected' AND attempts=?`,
          )
          .run(
            attemptNumber,
            Date.now(),
            assignment.attemptID,
            sessionID,
            stableMessageID,
            existing.attempts,
          ).changes
        if (!changed) return undefined
      } else {
        const now = Date.now()
        const inserted = db
          .query(
            `INSERT OR IGNORE INTO runner_progress_reminders
             (attempt_id,session_id,message_id,ownership_json,created_at,updated_at,attempts,status)
             VALUES(?,?,?,?,?,?,1,'dispatching')`,
          )
          .run(
            assignment.attemptID,
            sessionID,
            stableMessageID,
            JSON.stringify(ownership),
            now,
            now,
          ).changes
        if (!inserted) return undefined
      }
      const sequence = this.appendIn(db, assignment, {
        source: "reminder",
        kind: "reminder",
        dedupeKey: `reminder:${assignment.attemptID}`,
        at: Date.now(),
        messageID: stableMessageID,
        payload: {
          text: safeMessage,
          delivery: "dispatching",
          attempt: attemptNumber,
          nativeMessageID: stableMessageID,
          ownership,
        },
      })
      return {
        attemptID: assignment.attemptID,
        sessionID,
        messageID: stableMessageID,
        sequence,
        attemptNumber,
        ownership,
      }
    })
  }

  finishReminder(claim: ReminderClaim, status: ReminderDelivery, error?: unknown): boolean {
    return this.store.atomic((db) => {
      const assignment = this.assignmentQuery(db, "attempt", claim.attemptID)
      if (
        !assignment ||
        assignment.sessionID !== claim.sessionID ||
        claim.ownership.lazersAttemptID !== claim.attemptID ||
        claim.ownership.lazersMessageID !== claim.messageID
      )
        return false
      const row = db
        .query<{ seq: number; payload: string }, [string, string, string, string]>(
          "SELECT seq,payload FROM runner_progress WHERE project_directory=? AND attempt_id=? AND dedupe_key=? AND message_id=?",
        )
        .get(
          this.store.repository.projectDirectory,
          claim.attemptID,
          `reminder:${claim.attemptID}`,
          claim.messageID,
        )
      if (!row) return false
      const changed = db
        .query(
          `UPDATE runner_progress_reminders SET status=?,updated_at=?
           WHERE attempt_id=? AND session_id=? AND message_id=? AND ownership_json=?
             AND status='dispatching'`,
        )
        .run(
          status,
          Date.now(),
          claim.attemptID,
          claim.sessionID,
          claim.messageID,
          JSON.stringify(claim.ownership),
        ).changes
      if (!changed) return false
      const payload = object(JSON.parse(row.payload)) ?? {}
      payload.delivery = status
      payload.deliveryAttempt = claim.attemptNumber
      if (error !== undefined) payload.deliveryError = safeError(error, privacyStats())
      else if (status === "admitted") delete payload.deliveryError
      db.query("UPDATE runner_progress SET payload=? WHERE seq=?").run(
        JSON.stringify(payload),
        row.seq,
      )
      return true
    })
  }

  private reminderClaimIn(db: Database, attemptID: string, sessionID: string, messageID: string) {
    const row = db
      .query<{ ownership_json: string; status: string }, [string, string, string]>(
        `SELECT ownership_json,status FROM runner_progress_reminders
         WHERE attempt_id=? AND session_id=? AND message_id=?`,
      )
      .get(attemptID, sessionID, messageID)
    if (!row) return undefined
    let ownership: unknown
    try {
      ownership = JSON.parse(row.ownership_json)
    } catch {
      return undefined
    }
    const parsedOwnership = object(ownership)
    if (
      !parsedOwnership ||
      parsedOwnership.lazersKind !== "worker-progress-reminder" ||
      parsedOwnership.lazersAttemptID !== attemptID ||
      parsedOwnership.lazersSessionID !== sessionID ||
      parsedOwnership.lazersMessageID !== messageID
    )
      return undefined
    return { ownership: parsedOwnership as unknown as ReminderOwnership, status: row.status }
  }

  private completeReminderIn(
    db: Database,
    attemptID: string,
    sessionID: string,
    messageID: string,
    status: ReminderDelivery,
    at: number,
    eventID?: string,
  ) {
    const assignment = this.assignmentQuery(db, "attempt", attemptID)
    const claim = this.reminderClaimIn(db, attemptID, sessionID, messageID)
    if (
      !assignment ||
      assignment.sessionID !== sessionID ||
      !claim ||
      claim.ownership.lazersProjectID !== assignment.projectID ||
      claim.ownership.lazersProjectDirectory !== this.store.repository.projectDirectory ||
      claim.ownership.lazersPlanID !== assignment.planID ||
      claim.ownership.lazersTaskID !== assignment.taskID
    )
      return undefined
    const changed = db
      .query(
        `UPDATE runner_progress_reminders SET status=?,updated_at=?
         WHERE attempt_id=? AND session_id=? AND message_id=? AND ownership_json=?
           AND status IN ('dispatching','unknown','admitted')`,
      )
      .run(
        status,
        Date.now(),
        attemptID,
        sessionID,
        messageID,
        JSON.stringify(claim.ownership),
      ).changes
    if (!changed) return undefined
    const sequence = this.appendIn(db, assignment, {
      source: eventID ? "native-event" : "recovery",
      kind: "reminder",
      dedupeKey: `reminder:${attemptID}`,
      at,
      ...(eventID ? { eventID } : {}),
      messageID,
      payload: {
        delivery: status,
        reconciledAt: at,
        ...(eventID ? { nativeEventID: eventID } : {}),
      },
    })
    const row = db
      .query<{ payload: string }, [number]>("SELECT payload FROM runner_progress WHERE seq=?")
      .get(sequence)
    if (row) {
      const payload = object(JSON.parse(row.payload)) ?? {}
      delete payload.deliveryError
      db.query("UPDATE runner_progress SET payload=? WHERE seq=?").run(
        JSON.stringify(payload),
        sequence,
      )
    }
    return sequence
  }

  observeReminderAdmission(
    sessionID: string,
    metadata: unknown,
    eventID: string,
    at: number,
  ): number | undefined {
    const value = object(metadata)
    if (
      value?.lazersKind !== "worker-progress-reminder" ||
      typeof value.lazersAttemptID !== "string" ||
      typeof value.lazersMessageID !== "string"
    )
      return undefined
    return this.store.atomic((db) =>
      (() => {
        const attemptID = value.lazersAttemptID as string
        const messageID = value.lazersMessageID as string
        const claim = this.reminderClaimIn(db, attemptID, sessionID, messageID)
        if (!claim || !sameReminderOwnership(value, claim.ownership)) return undefined
        return this.completeReminderIn(db, attemptID, sessionID, messageID, "admitted", at, eventID)
      })(),
    )
  }

  reconcileReminder(sessionID: string, messages: readonly unknown[]): void {
    this.store.atomic((db) => {
      const assignment = this.assignmentQuery(db, "session", sessionID)
      if (!assignment) return
      const reminder = db
        .query<{ message_id: string | null; status: string }, [string, string]>(
          "SELECT message_id,status FROM runner_progress_reminders WHERE attempt_id=? AND session_id=?",
        )
        .get(assignment.attemptID, sessionID)
      if (!reminder) return
      if (!reminder.message_id) {
        this.appendIn(db, assignment, {
          source: "recovery",
          kind: "reminder",
          dedupeKey: `reminder:${assignment.attemptID}`,
          at: Date.now(),
          payload: {
            delivery: "unknown",
            recoveryGap: "The prior reminder claim has no stable native message ID.",
          },
        })
        this.markRecoveryGapIn(
          db,
          assignment,
          "A legacy reminder claim has no persisted native message ID; admission cannot be determined or resent safely.",
          "reminder-identity",
        )
        return
      }
      const matching = messages
        .map(object)
        .find((message) => message?.type === "synthetic" && message.id === reminder.message_id)
      const metadata = object(matching?.metadata)
      const claim = this.reminderClaimIn(db, assignment.attemptID, sessionID, reminder.message_id)
      const matchesOwnership = Boolean(claim && sameReminderOwnership(metadata, claim.ownership))
      if (matchesOwnership) {
        this.completeReminderIn(
          db,
          assignment.attemptID,
          sessionID,
          reminder.message_id,
          "admitted",
          Date.now(),
        )
      } else if (reminder.status === "dispatching") {
        this.completeReminderIn(
          db,
          assignment.attemptID,
          sessionID,
          reminder.message_id,
          "unknown",
          Date.now(),
        )
      }
    })
  }

  private markRecoveryGapIn(
    db: Database,
    assignment: ProgressAssignment,
    reason: string,
    category: string,
  ) {
    const stats = privacyStats()
    return this.appendIn(db, assignment, {
      source: "recovery",
      kind: "gap",
      dedupeKey: `recovery-gap:${assignment.attemptID}:${category}`,
      at: Date.now(),
      payload: { reason: safeText(reason, stats, 500) },
    })
  }
}
