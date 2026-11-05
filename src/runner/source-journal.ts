import { Buffer } from "node:buffer"
import type { Database } from "bun:sqlite"
import { z } from "zod"
import { fingerprint } from "../identity.ts"

const JournalPosition = z.strictObject({
  sourceSessionID: z.string().min(1).max(256),
  kind: z.enum(["source", "input", "result"]),
  messageID: z.string().max(2048),
})

const JournalCursor = z.strictObject({
  version: z.literal(1),
  planID: z.uuid(),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  after: JournalPosition,
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
})

export type SourceJournalPosition = z.infer<typeof JournalPosition>
type SourceJournalCursor = z.infer<typeof JournalCursor>

type SourceContext = {
  source_session_id: string
  renewal_id: string
  anchor_plan_id: string
  source_state: string
  source_revision: number
  scan_sweep: number
  scan_cursor_present: number
  source_updated_at: number
  renewal_state: string
  previous_session_id: string
  successor_session_id: string
  renewal_started_at: number
}

type SourceRow = SourceContext
type InputRow = SourceContext & {
  message_id: string
  native_type: string | null
  delivery: string | null
  disposition: string
  observed_at: number
  referenced_revision: number
  input_updated_at: number
}
type ResultRow = SourceContext & {
  message_id: string
  result_state: string
  finish: string | null
  tool_running: number
  tool_completed: number
  tool_failed: number
  tool_other: number
  result_revision: number
  referenced_revision: number
  result_updated_at: number
}

export type SourceJournalItem =
  | (ReturnType<typeof sourceContext> & {
      kind: "source"
      recordID: string
      renewalStartedAt: number
    })
  | (ReturnType<typeof sourceContext> & {
      kind: "input"
      recordID: string
      messageID: string
      inputType: string
      delivery: string | null
      disposition: string
      observedAt: number
      referencedSourceRevision: number
      updatedAt: number
    })
  | (ReturnType<typeof sourceContext> & {
      kind: "result"
      recordID: string
      messageID: string
      state: string
      finish: string | null
      toolCounts: { running: number; completed: number; failed: number; other: number }
      resultRevision: number
      referencedSourceRevision: number
      updatedAt: number
    })

export type SourceJournalPage = {
  mode: "journal"
  planID: string
  page: {
    limit: number
    returned: number
    hasMore: boolean
    snapshotRevision: number
    concurrentChanges: "selected-journal-changes-invalidate-cursor"
  }
  records: SourceJournalItem[]
  nextCursor: string | null
  coverage: {
    kind: "metadata-only"
    sourceReferences: "original-session-and-message-ids"
    messageFetch: "requires-authenticated-native-sdk"
    messageBodies: "not-included"
    transcriptCompleteness: "unknown"
    nativeConsumption: "unknown"
    checkpointCoverage: "not-asserted"
    unresolvedInputDispositions: ["pending", "steering", "unknown"]
    diagnostics: "scan-and-timestamps-live-not-snapshot-pinned"
    scanCursorMeaning: "scanner-state-only; not-transcript-completeness"
  }
}

type PositionedRecord = {
  position: SourceJournalPosition
  order: number
  item: SourceJournalItem
}

function sourceContext(row: SourceContext, planID: string) {
  return {
    sourceSessionID: row.source_session_id,
    associatedPlanID: planID,
    anchorPlanID: row.anchor_plan_id,
    renewalID: row.renewal_id,
    renewalState: row.renewal_state,
    predecessorSessionID: row.previous_session_id,
    successorSessionID: row.successor_session_id,
    sourceState: row.source_state,
    sourceRevision: row.source_revision,
    scan: {
      sweep: row.scan_sweep,
      cursorPresent: row.scan_cursor_present !== 0,
      updatedAt: row.source_updated_at,
    },
  }
}

function cursorScope(projectDirectory: string, planID: string) {
  return fingerprint({ projectDirectory, planID })
}

function cursorBody(
  projectDirectory: string,
  planID: string,
  revision: number,
  after: SourceJournalPosition,
) {
  return {
    version: 1 as const,
    planID,
    scope: cursorScope(projectDirectory, planID),
    revision,
    after,
  }
}

function encodeCursor(
  projectDirectory: string,
  planID: string,
  revision: number,
  after: SourceJournalPosition,
) {
  const body = cursorBody(projectDirectory, planID, revision, after)
  return Buffer.from(JSON.stringify({ ...body, checksum: fingerprint(body) })).toString("base64url")
}

function decodeCursor(cursor: string, projectDirectory: string, planID: string) {
  if (cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new Error("Invalid journal cursor")
  let parsed: unknown
  try {
    const decoded = Buffer.from(cursor, "base64url")
    if (decoded.toString("base64url") !== cursor) throw new Error("non-canonical cursor")
    parsed = JSON.parse(decoded.toString("utf8"))
  } catch {
    throw new Error("Invalid journal cursor")
  }
  const result = JournalCursor.safeParse(parsed)
  if (!result.success) throw new Error("Invalid journal cursor")
  const { checksum, ...body } = result.data
  if (fingerprint(body) !== checksum) throw new Error("Invalid journal cursor")
  if (result.data.planID !== planID || result.data.scope !== cursorScope(projectDirectory, planID))
    throw new Error("Journal cursor does not match this project and plan")
  return result.data
}

function orderFor(kind: SourceJournalPosition["kind"]) {
  return kind === "source" ? 0 : kind === "input" ? 1 : 2
}

function comparePosition(left: PositionedRecord, right: PositionedRecord) {
  const compareText = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))
  return (
    compareText(left.position.sourceSessionID, right.position.sourceSessionID) ||
    left.order - right.order ||
    compareText(left.position.messageID, right.position.messageID)
  )
}

function scopedSource(alias: string) {
  return `EXISTS (
    SELECT 1 FROM runner_architect_renewal_plans rp
    JOIN runner_architect_renewals renewal ON renewal.id=rp.renewal_id
    JOIN runner_plans mapped ON mapped.id=rp.plan_id
    JOIN runner_plans anchor ON anchor.id=renewal.anchor_plan_id
    WHERE rp.plan_id=? AND rp.renewal_id=${alias}.renewal_id
      AND renewal.anchor_plan_id=${alias}.anchor_plan_id
      AND renewal.previous_session_id=${alias}.session_id
      AND mapped.project_directory=? AND anchor.project_directory=?
  )`
}

function cursorForTable(
  kind: "input" | "result",
  cursor: SourceJournalCursor | null,
  sessionColumn: string,
  messageColumn: string,
) {
  if (!cursor) return { clause: "", parameters: [] as string[] }
  const position = cursor.after
  const order = orderFor(position.kind)
  const messageID = position.messageID
  if (order < orderFor(kind))
    return {
      clause: `AND (${sessionColumn}>? OR ${sessionColumn}=?)`,
      parameters: [position.sourceSessionID, position.sourceSessionID],
    }
  if (order > orderFor(kind))
    return { clause: `AND ${sessionColumn}>?`, parameters: [position.sourceSessionID] }
  return {
    clause: `AND (${sessionColumn}>? OR (${sessionColumn}=? AND ${messageColumn}>?))`,
    parameters: [position.sourceSessionID, position.sourceSessionID, messageID],
  }
}

function sourceCursorClause(cursor: SourceJournalCursor | null) {
  if (!cursor) return { clause: "", parameters: [] as string[] }
  return { clause: "AND s.session_id>?", parameters: [cursor.after.sourceSessionID] }
}

function validateCursorPosition(
  db: Database,
  projectDirectory: string,
  planID: string,
  position: SourceJournalPosition,
) {
  if (position.kind === "source" && position.messageID !== "")
    throw new Error("Invalid journal cursor")
  const scope = scopedSource("s")
  const present =
    position.kind === "source"
      ? db
          .query<{ present: number }, [string, string, string, string]>(
            `SELECT 1 AS present FROM runner_architect_sources s
             WHERE s.session_id=? AND ${scope} LIMIT 1`,
          )
          .get(position.sourceSessionID, planID, projectDirectory, projectDirectory)
      : position.kind === "input"
        ? db
            .query<{ present: number }, [string, string, string, string, string]>(
              `SELECT 1 AS present FROM runner_architect_inputs i
               JOIN runner_architect_sources s ON s.session_id=i.session_id
               WHERE i.session_id=? AND i.message_id=? AND ${scope} LIMIT 1`,
            )
            .get(
              position.sourceSessionID,
              position.messageID,
              planID,
              projectDirectory,
              projectDirectory,
            )
        : db
            .query<{ present: number }, [string, string, string, string, string]>(
              `SELECT 1 AS present FROM runner_architect_source_results i
               JOIN runner_architect_sources s ON s.session_id=i.session_id
               WHERE i.session_id=? AND i.message_id=? AND i.renewal_id=s.renewal_id
                 AND ${scope} LIMIT 1`,
            )
            .get(
              position.sourceSessionID,
              position.messageID,
              planID,
              projectDirectory,
              projectDirectory,
            )
  if (!present) throw new Error("Journal cursor does not identify a record in this plan")
}

export function readSourceJournalPage(
  db: Database,
  projectDirectory: string,
  planID: string,
  limit: number,
  rawCursor?: string,
): SourceJournalPage {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Journal page limit must be an integer between 1 and 100")
  const cursor = rawCursor === undefined ? null : decodeCursor(rawCursor, projectDirectory, planID)
  const plan = db
    .query<{ present: number }, [string, string]>(
      "SELECT 1 AS present FROM runner_plans WHERE project_directory=? AND id=?",
    )
    .get(projectDirectory, planID)
  if (!plan) throw new Error("Plan not found")

  const currentRevision =
    db
      .query<{ revision: number }, [string, string]>(
        `SELECT revision FROM runner_architect_journal_revisions
         WHERE project_directory=? AND plan_id=?`,
      )
      .get(projectDirectory, planID)?.revision ?? 0
  if (cursor && cursor.revision !== currentRevision)
    throw new Error("Journal changed since this page; restart the journal view")
  if (cursor) validateCursorPosition(db, projectDirectory, planID, cursor.after)

  const scoped = scopedSource("s")
  const params = [planID, projectDirectory, projectDirectory] as const
  const sourceAfter = sourceCursorClause(cursor)
  const sourceRows = db
    .query<SourceRow, [...typeof params, ...string[], number]>(
      `SELECT s.session_id AS source_session_id,s.renewal_id,s.anchor_plan_id,
         s.state AS source_state,s.revision AS source_revision,s.scan_sweep,
         (s.scan_cursor IS NOT NULL) AS scan_cursor_present,s.updated_at AS source_updated_at,
         renewal.state AS renewal_state,renewal.previous_session_id,renewal.successor_session_id,
         renewal.started_at AS renewal_started_at
       FROM runner_architect_sources s
       JOIN runner_architect_renewals renewal ON renewal.id=s.renewal_id
       WHERE ${scoped} ${sourceAfter.clause}
       ORDER BY s.session_id LIMIT ?`,
    )
    .all(...params, ...sourceAfter.parameters, limit + 1)

  const inputAfter = cursorForTable("input", cursor, "i.session_id", "i.message_id")
  const inputRows = db
    .query<InputRow, [...typeof params, ...string[], number]>(
      `SELECT s.session_id AS source_session_id,s.renewal_id,s.anchor_plan_id,
         s.state AS source_state,s.revision AS source_revision,s.scan_sweep,
         (s.scan_cursor IS NOT NULL) AS scan_cursor_present,s.updated_at AS source_updated_at,
         renewal.state AS renewal_state,renewal.previous_session_id,renewal.successor_session_id,
         renewal.started_at AS renewal_started_at,
         i.message_id,i.native_type,i.delivery,i.disposition,i.observed_at,
         i.referenced_revision,i.updated_at AS input_updated_at
       FROM runner_architect_inputs i
       JOIN runner_architect_sources s ON s.session_id=i.session_id
       JOIN runner_architect_renewals renewal ON renewal.id=s.renewal_id
       WHERE ${scoped} ${inputAfter.clause}
       ORDER BY i.session_id,i.message_id LIMIT ?`,
    )
    .all(...params, ...inputAfter.parameters, limit + 1)

  const resultAfter = cursorForTable("result", cursor, "i.session_id", "i.message_id")
  const resultRows = db
    .query<ResultRow, [...typeof params, ...string[], number]>(
      `SELECT s.session_id AS source_session_id,s.renewal_id,s.anchor_plan_id,
         s.state AS source_state,s.revision AS source_revision,s.scan_sweep,
         (s.scan_cursor IS NOT NULL) AS scan_cursor_present,s.updated_at AS source_updated_at,
         renewal.state AS renewal_state,renewal.previous_session_id,renewal.successor_session_id,
         renewal.started_at AS renewal_started_at,
         i.message_id,i.state AS result_state,i.finish,i.tool_running,i.tool_completed,
         i.tool_failed,i.tool_other,i.result_revision,i.referenced_revision,
         i.updated_at AS result_updated_at
       FROM runner_architect_source_results i
       JOIN runner_architect_sources s ON s.session_id=i.session_id AND s.renewal_id=i.renewal_id
       JOIN runner_architect_renewals renewal ON renewal.id=s.renewal_id
       WHERE ${scoped} ${resultAfter.clause}
       ORDER BY i.session_id,i.message_id LIMIT ?`,
    )
    .all(...params, ...resultAfter.parameters, limit + 1)

  const positioned: PositionedRecord[] = [
    ...sourceRows.map((row) => ({
      position: { sourceSessionID: row.source_session_id, kind: "source" as const, messageID: "" },
      order: 0,
      item: {
        ...sourceContext(row, planID),
        kind: "source" as const,
        recordID: `source:${row.source_session_id}`,
        renewalStartedAt: row.renewal_started_at,
      },
    })),
    ...inputRows.map((row) => ({
      position: {
        sourceSessionID: row.source_session_id,
        kind: "input" as const,
        messageID: row.message_id,
      },
      order: 1,
      item: {
        ...sourceContext(row, planID),
        kind: "input" as const,
        recordID: `input:${row.source_session_id}:${row.message_id}`,
        messageID: row.message_id,
        inputType: row.native_type ?? "unknown",
        delivery: row.delivery,
        disposition: row.disposition,
        observedAt: row.observed_at,
        referencedSourceRevision: row.referenced_revision,
        updatedAt: row.input_updated_at,
      },
    })),
    ...resultRows.map((row) => ({
      position: {
        sourceSessionID: row.source_session_id,
        kind: "result" as const,
        messageID: row.message_id,
      },
      order: 2,
      item: {
        ...sourceContext(row, planID),
        kind: "result" as const,
        recordID: `result:${row.source_session_id}:${row.message_id}`,
        messageID: row.message_id,
        state: row.result_state,
        finish: row.finish,
        toolCounts: {
          running: row.tool_running,
          completed: row.tool_completed,
          failed: row.tool_failed,
          other: row.tool_other,
        },
        resultRevision: row.result_revision,
        referencedSourceRevision: row.referenced_revision,
        updatedAt: row.result_updated_at,
      },
    })),
  ].sort(comparePosition)

  const hasMore = positioned.length > limit
  const page = positioned.slice(0, limit)
  const last = page.at(-1)
  return {
    mode: "journal",
    planID,
    page: {
      limit,
      returned: page.length,
      hasMore,
      snapshotRevision: currentRevision,
      concurrentChanges: "selected-journal-changes-invalidate-cursor",
    },
    records: page.map(({ item }) => item),
    nextCursor:
      hasMore && last
        ? encodeCursor(projectDirectory, planID, currentRevision, last.position)
        : null,
    coverage: {
      kind: "metadata-only",
      sourceReferences: "original-session-and-message-ids",
      messageFetch: "requires-authenticated-native-sdk",
      messageBodies: "not-included",
      transcriptCompleteness: "unknown",
      nativeConsumption: "unknown",
      checkpointCoverage: "not-asserted",
      unresolvedInputDispositions: ["pending", "steering", "unknown"],
      diagnostics: "scan-and-timestamps-live-not-snapshot-pinned",
      scanCursorMeaning: "scanner-state-only; not-transcript-completeness",
    },
  }
}
