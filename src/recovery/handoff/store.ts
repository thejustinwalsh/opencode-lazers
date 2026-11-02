import type { Database } from "bun:sqlite"
import { canonical } from "../../identity.ts"
import type { TaskRepository } from "../../storage.ts"
import { TaskSpecSchema } from "../../task.ts"
import { RunnerStore } from "../../runner/store.ts"
import {
  HandoffActor,
  HandoffAttachment,
  HandoffDispositionInput,
  HandoffDispositionRecord,
  HandoffDraft,
  HandoffDraftSubmissionInput,
  HandoffDraftRecord,
  HandoffEventRecord,
  HandoffFinalizeInput,
  HandoffHistoryCursor,
  HandoffNotificationIntent,
  HandoffRequestBody,
  HandoffRequestInput,
  HandoffRequestRecord,
  HandoffReviewCheck,
  HandoffReviewOutcome,
  HandoffReviewOutcomeInput,
  HandoffReviewReservationInput,
  HandoffReviewRoundRecord,
  HandoffReportRecord,
  HandoffSource,
  JsonObjectSchema,
  JsonValueSchema,
} from "./schema.ts"
import type {
  HandoffActor as HandoffActorType,
  HandoffDispositionInput as HandoffDispositionInputType,
  HandoffDispositionRecord as HandoffDispositionRecordType,
  HandoffDraftRecord as HandoffDraftRecordType,
  HandoffEventRecord as HandoffEventRecordType,
  HandoffHistoryPage,
  HandoffNotificationIntent as HandoffNotificationIntentType,
  HandoffRequestRecord as HandoffRequestRecordType,
  HandoffReviewOutcome as HandoffReviewOutcomeType,
  HandoffReviewRoundRecord as HandoffReviewRoundRecordType,
  HandoffReportRecord as HandoffReportRecordType,
  HandoffSource as HandoffSourceType,
} from "./schema.ts"

type Receipt<T> =
  | { status: "created" | "recorded"; record: T }
  | { status: "replayed"; record: T }
  | { status: "conflict"; message: string }

type SourceRow = {
  task_body: string
  plan_id: string
  plan_revision: number
  plan_version: number
  plan_state: string
  plan_owner: string
  plan_body: string
  node_task_id: string
  node_state: string
  node_ordinal: number
  node_spec_revision: number
  node_machine_version: string
  node_snapshot: string
  attempt_id: string
  attempt_number: number
  attempt_session_id: string
  attempt_state: string
  attempt_started_at: number
  attempt_workspace: string
  attempt_base_commit: string
  attempt_artifact: string | null
  attempt_policy: string
  attempt_token_count: number | null
  attempt_tool_count: number
  attempt_retry_count: number
  attempt_cost: number | null
}

type PayloadRow = { payload: string }
type RoundRow = { payload: string; outcome_json: string | null }
type ReviewRoundPayloadRow = { payload: string }
type EventRow = {
  sequence: number
  request_id: string
  kind: string
  record_id: string
  data: string
  created_at: string
}

export type HandoffReviewContext = {
  request: HandoffRequestRecordType
  draft: HandoffDraftRecordType
  reviewID: string | null
  rounds: HandoffReviewRoundRecordType[]
}

const RequestInputWithSource = HandoffRequestInput
const DraftInput = HandoffDraftSubmissionInput

const NotificationLimit = 100

/**
 * SQLite persistence for source-attached recovery reports. This module stores
 * exact review reservations/results; review scoring and round progression stay
 * with the shared reviewer that calls this adapter.
 */
export class HandoffStore {
  readonly repository: TaskRepository
  private readonly now: () => string

  constructor(repository: TaskRepository, now: () => string = () => new Date().toISOString()) {
    this.repository = repository
    this.now = now
    // RunnerStore owns the runner tables this adapter joins for source ownership.
    new RunnerStore(repository)
    repository.atomic((db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS recovery_handoff_requests (
          project_directory TEXT NOT NULL,
          request_id TEXT NOT NULL,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          plan_id TEXT NOT NULL REFERENCES runner_plans(id),
          attempt_id TEXT NOT NULL REFERENCES runner_attempts(id),
          request_generation INTEGER NOT NULL CHECK(request_generation > 0),
          payload TEXT NOT NULL,
          PRIMARY KEY(project_directory, request_id),
          UNIQUE(project_directory, attempt_id, request_generation)
        );
        CREATE INDEX IF NOT EXISTS recovery_handoff_requests_attempt
          ON recovery_handoff_requests(project_directory, attempt_id, request_generation);
        CREATE TABLE IF NOT EXISTS recovery_handoff_drafts (
          project_directory TEXT NOT NULL,
          request_id TEXT NOT NULL,
          draft_id TEXT NOT NULL,
          draft_version INTEGER NOT NULL CHECK(draft_version > 0),
          payload TEXT NOT NULL,
          PRIMARY KEY(project_directory, request_id, draft_version),
          UNIQUE(project_directory, draft_id),
          FOREIGN KEY(project_directory, request_id)
            REFERENCES recovery_handoff_requests(project_directory, request_id)
        );
        CREATE TABLE IF NOT EXISTS recovery_handoff_reviews (
          project_directory TEXT NOT NULL,
          request_id TEXT NOT NULL,
          review_id TEXT NOT NULL,
          owner_json TEXT NOT NULL,
          contract_version TEXT NOT NULL,
          contract_json TEXT NOT NULL,
          check_version TEXT NOT NULL,
          checks_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(project_directory, review_id),
          FOREIGN KEY(project_directory, request_id)
            REFERENCES recovery_handoff_requests(project_directory, request_id)
        );
        CREATE TABLE IF NOT EXISTS recovery_handoff_rounds (
          project_directory TEXT NOT NULL,
          request_id TEXT NOT NULL,
          review_id TEXT NOT NULL,
          round INTEGER NOT NULL CHECK(round > 0),
          draft_version INTEGER NOT NULL,
          payload TEXT NOT NULL,
          outcome_json TEXT,
          completed_at TEXT,
          PRIMARY KEY(project_directory, review_id, round),
          FOREIGN KEY(project_directory, review_id)
            REFERENCES recovery_handoff_reviews(project_directory, review_id),
          FOREIGN KEY(project_directory, request_id, draft_version)
            REFERENCES recovery_handoff_drafts(project_directory, request_id, draft_version)
        );
        CREATE TABLE IF NOT EXISTS recovery_handoff_reports (
          project_directory TEXT NOT NULL,
          request_id TEXT NOT NULL,
          report_id TEXT NOT NULL,
          report_version INTEGER NOT NULL CHECK(report_version > 0),
          finalization_id TEXT NOT NULL,
          draft_version INTEGER NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY(project_directory, report_id),
          UNIQUE(project_directory, finalization_id),
          UNIQUE(project_directory, request_id, report_version),
          UNIQUE(project_directory, request_id, draft_version),
          FOREIGN KEY(project_directory, request_id, draft_version)
            REFERENCES recovery_handoff_drafts(project_directory, request_id, draft_version)
        );
        CREATE TABLE IF NOT EXISTS recovery_handoff_notifications (
          project_directory TEXT NOT NULL,
          intent_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          report_id TEXT NOT NULL,
          recipient_session_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY(project_directory, intent_id),
          UNIQUE(project_directory, report_id),
          FOREIGN KEY(project_directory, report_id)
            REFERENCES recovery_handoff_reports(project_directory, report_id)
        );
        CREATE TABLE IF NOT EXISTS recovery_handoff_dispositions (
          project_directory TEXT NOT NULL,
          request_id TEXT NOT NULL,
          report_id TEXT NOT NULL,
          disposition_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY(project_directory, disposition_id),
          FOREIGN KEY(project_directory, report_id)
            REFERENCES recovery_handoff_reports(project_directory, report_id)
        );
        CREATE TABLE IF NOT EXISTS recovery_handoff_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          project_directory TEXT NOT NULL,
          request_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          record_id TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(project_directory, request_id)
            REFERENCES recovery_handoff_requests(project_directory, request_id)
        );
        CREATE INDEX IF NOT EXISTS recovery_handoff_events_request
          ON recovery_handoff_events(project_directory, request_id, sequence DESC);
      `)
    })
  }

  /** An Architect authorizes a request against an attempt in a currently owned plan. */
  request(input: unknown, callerInput: unknown): Receipt<HandoffRequestRecordType> {
    const requestInput = RequestInputWithSource.parse(input)
    const caller = HandoffActor.parse(callerInput)
    const requestBody = HandoffRequestBody.parse(requestInput.request)
    if (caller.role !== "architect")
      throw new Error("Only the current Architect may authorize a source handoff request")

    return this.repository.atomic((db) => {
      const existing = this.requestRow(db, requestInput.requestID)
      if (existing) {
        const record = HandoffRequestRecord.parse(JSON.parse(existing.payload))
        this.assertRequestAuthority(db, record, caller)
        const same =
          record.requestID === requestInput.requestID &&
          canonical(record.request) === canonical(requestBody) &&
          canonical(record.requestedBy) === canonical(caller) &&
          record.source.attachment.attemptID === requestInput.sourceAttemptID
        return same
          ? { status: "replayed" as const, record }
          : {
              status: "conflict" as const,
              message: "requestID already identifies different handoff content",
            }
      }

      const sourceRow = this.resolveSourceRow(db, { attemptID: requestInput.sourceAttemptID })
      if (!sourceRow)
        throw new Error("No project-owned source attempt matches this authorized caller")
      const sourceWithoutGeneration = this.sourceFromRow(sourceRow, 1)
      this.assertArchitectOwnsPlan(db, sourceWithoutGeneration, caller)

      const generation = db
        .query<{ generation: number }, [string, string]>(
          `SELECT COALESCE(MAX(request_generation), 0) + 1 AS generation
           FROM recovery_handoff_requests WHERE project_directory=? AND attempt_id=?`,
        )
        .get(
          this.repository.projectDirectory,
          sourceWithoutGeneration.attachment.attemptID,
        )!.generation
      if (!Number.isSafeInteger(generation) || generation < 1)
        throw new Error("Handoff request generation is exhausted")
      const source = this.sourceFromRow(sourceRow, generation)
      const record = HandoffRequestRecord.parse({
        requestID: requestInput.requestID,
        requestGeneration: generation,
        request: requestBody,
        requestedBy: caller,
        source,
        createdAt: this.timestamp(),
      })
      db.query(
        `INSERT INTO recovery_handoff_requests
         (project_directory,request_id,task_id,plan_id,attempt_id,request_generation,payload)
         VALUES(?,?,?,?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        record.requestID,
        source.attachment.taskID,
        source.attachment.planID,
        source.attachment.attemptID,
        generation,
        JSON.stringify(record),
      )
      this.appendEvent(
        db,
        record.requestID,
        "request-created",
        record.requestID,
        { requestGeneration: record.requestGeneration },
        record.createdAt,
      )
      return { status: "created" as const, record }
    })
  }

  /** Persist an immutable worker-authored draft version before it is reviewed. */
  saveDraft(input: unknown, callerInput: unknown): Receipt<HandoffDraftRecordType> {
    const parsed = DraftInput.parse(input)
    const caller = HandoffActor.parse(callerInput)
    const draft = HandoffDraft.parse(parsed.draft)
    return this.repository.atomic((db) => {
      const request = this.requireRequest(db, parsed.requestID)
      this.assertDraftAuthor(db, request, caller)
      const existing = db
        .query<PayloadRow, [string, string]>(
          `SELECT payload FROM recovery_handoff_drafts
           WHERE project_directory=? AND draft_id=?`,
        )
        .get(this.repository.projectDirectory, parsed.draftID)
      if (existing) {
        const record = HandoffDraftRecord.parse(JSON.parse(existing.payload))
        const same =
          record.requestID === parsed.requestID &&
          canonical(record.draft) === canonical(draft) &&
          canonical(record.author) === canonical(caller)
        return same
          ? { status: "replayed" as const, record }
          : {
              status: "conflict" as const,
              message: "draftID already identifies different handoff content",
            }
      }
      const version = db
        .query<{ version: number }, [string, string]>(
          `SELECT COALESCE(MAX(draft_version), 0) + 1 AS version
           FROM recovery_handoff_drafts WHERE project_directory=? AND request_id=?`,
        )
        .get(this.repository.projectDirectory, parsed.requestID)!.version
      const record = HandoffDraftRecord.parse({
        requestID: request.requestID,
        draftID: parsed.draftID,
        draftVersion: version,
        source: request.source,
        author: caller,
        draft,
        createdAt: this.timestamp(),
      })
      db.query(
        `INSERT INTO recovery_handoff_drafts
         (project_directory,request_id,draft_id,draft_version,payload) VALUES(?,?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        parsed.requestID,
        parsed.draftID,
        version,
        JSON.stringify(record),
      )
      this.appendEvent(
        db,
        parsed.requestID,
        "draft-saved",
        parsed.draftID,
        { draftVersion: record.draftVersion },
        record.createdAt,
      )
      return { status: "created" as const, record }
    })
  }

  /** Read the private, source-bound review context and any matching durable chain. */
  readReviewContext(
    input: {
      requestID: string
      draftVersion: number
      reviewID?: string
      effectiveContractVersion?: string
      effectiveContract?: unknown
      checkVersion?: string
      checks?: unknown
    },
    reviewerInput: unknown,
  ): HandoffReviewContext {
    const requestID = HandoffRequestInput.shape.requestID.parse(input.requestID)
    const draftVersion = HandoffReviewReservationInput.shape.draftVersion.parse(input.draftVersion)
    const reviewID =
      input.reviewID === undefined
        ? undefined
        : HandoffReviewReservationInput.shape.reviewID.parse(input.reviewID)
    const policyInputCount = [
      input.effectiveContractVersion,
      input.effectiveContract,
      input.checkVersion,
      input.checks,
    ].filter((value) => value !== undefined).length
    if (policyInputCount !== 0 && policyInputCount !== 4)
      throw new Error("Review contract and check identity must be supplied together")
    const effectiveContractVersion =
      input.effectiveContractVersion === undefined
        ? undefined
        : HandoffReviewReservationInput.shape.effectiveContractVersion.parse(
            input.effectiveContractVersion,
          )
    const effectiveContract =
      input.effectiveContract === undefined
        ? undefined
        : JsonObjectSchema.parse(input.effectiveContract)
    const checkVersion =
      input.checkVersion === undefined
        ? undefined
        : HandoffReviewReservationInput.shape.checkVersion.parse(input.checkVersion)
    const checks =
      input.checks === undefined
        ? undefined
        : HandoffReviewReservationInput.shape.checks.parse(input.checks)
    const reviewer = HandoffActor.parse(reviewerInput)

    return this.repository.atomic((db) => {
      const request = this.requireRequest(db, requestID)
      this.assertReviewAuthority(db, request, reviewer)
      const draftRow = this.draftRow(db, requestID, draftVersion)
      if (!draftRow) throw new Error("Draft version is not attached to this request")
      const draft = HandoffDraftRecord.parse(JSON.parse(draftRow.payload))
      if (draft.requestID !== requestID || canonical(draft.source) !== canonical(request.source))
        throw new Error("Draft source attachment does not match the current handoff request")

      const headers = db
        .query<ReviewHeaderRow, [string, string]>(
          `SELECT * FROM recovery_handoff_reviews WHERE project_directory=? AND request_id=?`,
        )
        .all(this.repository.projectDirectory, requestID)
      const requestedHeader =
        policyInputCount > 0 && reviewID !== undefined
          ? db
              .query<ReviewHeaderRow, [string, string]>(
                `SELECT * FROM recovery_handoff_reviews WHERE project_directory=? AND review_id=?`,
              )
              .get(this.repository.projectDirectory, reviewID)
          : undefined
      if (requestedHeader && requestedHeader.request_id !== requestID)
        throw new Error("Review ID is already attached to another handoff request")
      if (
        policyInputCount &&
        requestedHeader &&
        (canonical(JSON.parse(requestedHeader.owner_json)) !== canonical(reviewer) ||
          requestedHeader.contract_version !== effectiveContractVersion ||
          requestedHeader.contract_json !== canonical(effectiveContract) ||
          requestedHeader.check_version !== checkVersion ||
          requestedHeader.checks_json !== canonical(checks))
      )
        throw new Error("Review owner or effective contract/check version is stale")

      const matching = policyInputCount
        ? headers.filter(
            (header) =>
              canonical(JSON.parse(header.owner_json)) === canonical(reviewer) &&
              header.contract_version === effectiveContractVersion &&
              header.contract_json === canonical(effectiveContract!) &&
              header.check_version === checkVersion &&
              header.checks_json === canonical(checks!),
          )
        : []
      const preferred =
        (reviewID ? matching.find((header) => header.review_id === reviewID) : undefined) ??
        matching.sort((left, right) => left.created_at.localeCompare(right.created_at))[0]
      const chainIDs = new Set(matching.map((header) => header.review_id))
      const rounds = chainIDs.size
        ? db
            .query<ReviewRoundPayloadRow, [string, string]>(
              `SELECT payload FROM recovery_handoff_rounds
               WHERE project_directory=? AND request_id=? ORDER BY rowid`,
            )
            .all(this.repository.projectDirectory, requestID)
            .map((row) => HandoffReviewRoundRecord.parse(JSON.parse(row.payload)))
            .filter((round) => chainIDs.has(round.reviewID))
            .sort((left, right) => left.round - right.round)
        : []
      return {
        request,
        draft,
        reviewID: preferred?.review_id ?? (policyInputCount ? (reviewID ?? null) : null),
        rounds,
      }
    })
  }

  /** Reserve exact source/evidence/contract/check versions before asynchronous review. */
  reserveRound(input: unknown, reviewerInput: unknown): Receipt<HandoffReviewRoundRecordType> {
    const reservation = HandoffReviewReservationInput.parse(input)
    const reviewer = HandoffActor.parse(reviewerInput)
    const checks = reservation.checks.map((check) => HandoffReviewCheck.parse(check))
    const evidence = reservation.evidence
    const contract = JsonObjectSchema.parse(reservation.effectiveContract)
    return this.repository.atomic((db) => {
      const request = this.requireRequest(db, reservation.requestID)
      this.assertReviewAuthority(db, request, reviewer)
      const draft = this.draftRow(db, reservation.requestID, reservation.draftVersion)
      if (!draft) throw new Error("Draft version is not attached to this request")
      const draftRecord = HandoffDraftRecord.parse(JSON.parse(draft.payload))
      if (
        draftRecord.requestID !== reservation.requestID ||
        canonical(draftRecord.source) !== canonical(request.source)
      )
        throw new Error("Draft source attachment does not match the current handoff request")

      const review = db
        .query<ReviewHeaderRow, [string, string]>(
          `SELECT * FROM recovery_handoff_reviews WHERE project_directory=? AND review_id=?`,
        )
        .get(this.repository.projectDirectory, reservation.reviewID)
      if (review && review.request_id !== reservation.requestID)
        throw new Error("Review ID is already attached to another handoff request")
      if (review) {
        if (
          canonical(JSON.parse(review.owner_json)) !== canonical(reviewer) ||
          review.contract_version !== reservation.effectiveContractVersion ||
          review.contract_json !== canonical(contract) ||
          review.check_version !== reservation.checkVersion ||
          review.checks_json !== canonical(checks)
        )
          throw new Error("Review owner or effective contract/check version is stale")
      }

      const priorRound = db
        .query<PayloadRow, [string, string, number]>(
          `SELECT payload FROM recovery_handoff_rounds
           WHERE project_directory=? AND review_id=? AND round=?`,
        )
        .get(this.repository.projectDirectory, reservation.reviewID, reservation.round)
      if (priorRound) {
        const record = HandoffReviewRoundRecord.parse(JSON.parse(priorRound.payload))
        return canonical(this.reservationIdentity(record)) ===
          canonical(this.reservationIdentityFromInput(reservation, reviewer, request.source))
          ? { status: "replayed" as const, record }
          : {
              status: "conflict" as const,
              message: "Review round already has a different reservation",
            }
      }

      const chainHeaders = db
        .query<ReviewHeaderRow, [string, string]>(
          `SELECT * FROM recovery_handoff_reviews WHERE project_directory=? AND request_id=?`,
        )
        .all(this.repository.projectDirectory, reservation.requestID)
        .filter(
          (header) =>
            canonical(JSON.parse(header.owner_json)) === canonical(reviewer) &&
            header.contract_version === reservation.effectiveContractVersion &&
            header.contract_json === canonical(contract) &&
            header.check_version === reservation.checkVersion &&
            header.checks_json === canonical(checks),
        )
      const chainIDs = new Set(chainHeaders.map((header) => header.review_id))
      if (chainIDs.size && !chainIDs.has(reservation.reviewID))
        return {
          status: "conflict" as const,
          message: `Review chain already belongs to review ${chainHeaders[0]!.review_id}`,
        }
      const existingRounds = chainIDs.size
        ? db
            .query<ReviewRoundPayloadRow, [string, string]>(
              `SELECT payload FROM recovery_handoff_rounds
               WHERE project_directory=? AND request_id=? ORDER BY rowid`,
            )
            .all(this.repository.projectDirectory, reservation.requestID)
            .map((row) => HandoffReviewRoundRecord.parse(JSON.parse(row.payload)))
            .filter((round) => chainIDs.has(round.reviewID))
        : []
      const expectedRound =
        existingRounds.reduce((maximum, round) => Math.max(maximum, round.round), 0) + 1
      if (reservation.round !== expectedRound)
        return {
          status: "conflict" as const,
          message: `Review chain expected round ${expectedRound}, not ${reservation.round}`,
        }

      if (!review) {
        db.query(
          `INSERT INTO recovery_handoff_reviews
           (project_directory,request_id,review_id,owner_json,contract_version,contract_json,check_version,checks_json,created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        ).run(
          this.repository.projectDirectory,
          reservation.requestID,
          reservation.reviewID,
          JSON.stringify(reviewer),
          reservation.effectiveContractVersion,
          canonical(contract),
          reservation.checkVersion,
          canonical(checks),
          this.timestamp(),
        )
      }

      const record = HandoffReviewRoundRecord.parse({
        ...reservation,
        source: request.source,
        reviewer,
        evidence,
        effectiveContract: contract,
        checks,
        reservedAt: this.timestamp(),
      })
      db.query(
        `INSERT INTO recovery_handoff_rounds
         (project_directory,request_id,review_id,round,draft_version,payload,outcome_json,completed_at)
         VALUES(?,?,?,?,?,?,NULL,NULL)`,
      ).run(
        this.repository.projectDirectory,
        reservation.requestID,
        reservation.reviewID,
        reservation.round,
        reservation.draftVersion,
        JSON.stringify(record),
      )
      this.appendEvent(
        db,
        reservation.requestID,
        "review-reserved",
        this.roundKey(reservation.reviewID, reservation.round),
        {
          reviewID: record.reviewID,
          round: record.round,
          draftVersion: record.draftVersion,
          evidenceVersion: record.evidenceVersion,
          effectiveContractVersion: record.effectiveContractVersion,
          checkVersion: record.checkVersion,
        },
        record.reservedAt,
      )
      return { status: "created" as const, record }
    })
  }

  /** Complete a reservation once; identical retries replay without overwriting it. */
  recordReviewOutcome(
    input: unknown,
    reviewerInput: unknown,
  ): Receipt<HandoffReviewRoundRecordType> {
    const parsed = HandoffReviewOutcomeInput.parse(input)
    const reviewer = HandoffActor.parse(reviewerInput)
    const outcome = HandoffReviewOutcome.parse(parsed.outcome)
    return this.repository.atomic((db) => {
      const request = this.requireRequest(db, parsed.requestID)
      this.assertReviewAuthority(db, request, reviewer)
      const row = db
        .query<RoundRow, [string, string, number]>(
          `SELECT payload,outcome_json FROM recovery_handoff_rounds
           WHERE project_directory=? AND review_id=? AND round=?`,
        )
        .get(this.repository.projectDirectory, parsed.reviewID, parsed.round)
      if (!row) throw new Error("Review round was not reserved")
      const reserved = HandoffReviewRoundRecord.parse(JSON.parse(row.payload))
      if (
        reserved.requestID !== parsed.requestID ||
        canonical(reserved.reviewer) !== canonical(reviewer)
      )
        throw new Error("Review round belongs to another request or caller")
      if (row.outcome_json !== null) {
        const saved = HandoffReviewRoundRecord.parse(JSON.parse(row.payload))
        return canonical(saved.outcome) === canonical(outcome)
          ? { status: "replayed" as const, record: saved }
          : { status: "conflict" as const, message: "Review outcome is immutable once recorded" }
      }
      const completedAt = this.timestamp()
      const record = HandoffReviewRoundRecord.parse({
        ...reserved,
        outcome,
        completedAt,
      })
      db.query(
        `UPDATE recovery_handoff_rounds SET payload=?,outcome_json=?,completed_at=?
         WHERE project_directory=? AND review_id=? AND round=? AND outcome_json IS NULL`,
      ).run(
        JSON.stringify(record),
        JSON.stringify(outcome),
        completedAt,
        this.repository.projectDirectory,
        parsed.reviewID,
        parsed.round,
      )
      this.appendEvent(
        db,
        parsed.requestID,
        "review-completed",
        this.roundKey(parsed.reviewID, parsed.round),
        {
          reviewID: record.reviewID,
          round: record.round,
          status: outcome.status,
          concernCount: outcome.concerns.length,
          errorCount: outcome.errors.length,
          elapsedMs: outcome.elapsedMs,
          usage: outcome.usage,
        },
        completedAt,
      )
      return { status: "recorded" as const, record }
    })
  }

  /** Finalize a draft and its pending notification intent in one SQLite transaction. */
  finalize(
    input: unknown,
    callerInput: unknown,
  ):
    | {
        status: "finalized" | "replayed"
        report: HandoffReportRecordType
        notification: HandoffNotificationIntentType
      }
    | { status: "conflict"; message: string } {
    const parsed = HandoffFinalizeInput.parse(input)
    const caller = HandoffActor.parse(callerInput)
    return this.repository.atomic((db) => {
      const request = this.requireRequest(db, parsed.requestID)
      this.assertReviewAuthority(db, request, caller)
      const existingFinalization = db
        .query<FinalizationRow, [string, string]>(
          `SELECT r.payload AS report_payload,n.payload AS notification_payload
           FROM recovery_handoff_reports r
           JOIN recovery_handoff_notifications n
             ON n.project_directory=r.project_directory AND n.report_id=r.report_id
           WHERE r.project_directory=? AND r.finalization_id=?`,
        )
        .get(this.repository.projectDirectory, parsed.finalizationID)
      if (existingFinalization) {
        const report = HandoffReportRecord.parse(JSON.parse(existingFinalization.report_payload))
        const notification = HandoffNotificationIntent.parse(
          JSON.parse(existingFinalization.notification_payload),
        )
        const same =
          report.requestID === parsed.requestID &&
          report.draftVersion === parsed.draftVersion &&
          report.reviewID === parsed.reviewID &&
          report.round === parsed.round &&
          canonical(report.finalizedBy) === canonical(caller)
        return same
          ? { status: "replayed" as const, report, notification }
          : {
              status: "conflict" as const,
              message: "finalizationID already identifies different report content",
            }
      }

      const alreadyFinalized = db
        .query<{ report_id: string }, [string, string, number]>(
          `SELECT report_id FROM recovery_handoff_reports
           WHERE project_directory=? AND request_id=? AND draft_version=?`,
        )
        .get(this.repository.projectDirectory, parsed.requestID, parsed.draftVersion)
      if (alreadyFinalized)
        return {
          status: "conflict" as const,
          message: "This draft version already has a finalized report",
        }

      const draftRow = this.draftRow(db, parsed.requestID, parsed.draftVersion)
      if (!draftRow) throw new Error("Draft version is not attached to this request")
      const draft = HandoffDraftRecord.parse(JSON.parse(draftRow.payload))
      const roundRow = db
        .query<RoundRow, [string, string, number]>(
          `SELECT payload,outcome_json FROM recovery_handoff_rounds
           WHERE project_directory=? AND review_id=? AND round=?`,
        )
        .get(this.repository.projectDirectory, parsed.reviewID, parsed.round)
      if (!roundRow) throw new Error("Review round was not reserved")
      const review = HandoffReviewRoundRecord.parse(JSON.parse(roundRow.payload))
      if (
        review.requestID !== parsed.requestID ||
        review.draftVersion !== parsed.draftVersion ||
        canonical(review.reviewer) !== canonical(caller) ||
        roundRow.outcome_json === null ||
        !review.outcome
      )
        throw new Error("Review result is missing, stale, or belongs to another draft/caller")

      const { reviewStatus, limitation } = this.finalizationStatus(review.outcome)
      const reportVersion = db
        .query<{ version: number }, [string, string]>(
          `SELECT COALESCE(MAX(report_version),0)+1 AS version
           FROM recovery_handoff_reports WHERE project_directory=? AND request_id=?`,
        )
        .get(this.repository.projectDirectory, parsed.requestID)!.version
      const createdAt = this.timestamp()
      const report = HandoffReportRecord.parse({
        reportID: crypto.randomUUID(),
        requestID: parsed.requestID,
        reportVersion,
        finalizationID: parsed.finalizationID,
        draftVersion: parsed.draftVersion,
        reviewID: parsed.reviewID,
        round: parsed.round,
        reviewStatus,
        limitation,
        concerns: review.outcome.concerns,
        source: request.source,
        draft,
        review,
        finalizedBy: caller,
        createdAt,
      })
      const notification = HandoffNotificationIntent.parse({
        intentID: crypto.randomUUID(),
        requestID: parsed.requestID,
        reportID: report.reportID,
        recipientSessionID: request.requestedBy.sessionID,
        status: "pending",
        createdAt,
      })
      db.query(
        `INSERT INTO recovery_handoff_reports
         (project_directory,request_id,report_id,report_version,finalization_id,draft_version,payload)
         VALUES(?,?,?,?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        parsed.requestID,
        report.reportID,
        report.reportVersion,
        report.finalizationID,
        report.draftVersion,
        JSON.stringify(report),
      )
      db.query(
        `INSERT INTO recovery_handoff_notifications
         (project_directory,intent_id,request_id,report_id,recipient_session_id,payload)
         VALUES(?,?,?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        notification.intentID,
        notification.requestID,
        notification.reportID,
        notification.recipientSessionID,
        JSON.stringify(notification),
      )
      this.appendEvent(
        db,
        parsed.requestID,
        "report-finalized",
        report.reportID,
        {
          reportID: report.reportID,
          reportVersion: report.reportVersion,
          draftVersion: report.draftVersion,
          reviewStatus: report.reviewStatus,
          limitation: report.limitation,
          notificationIntentID: notification.intentID,
        },
        createdAt,
      )
      return { status: "finalized" as const, report, notification }
    })
  }

  /** Append an Architect interpretation; it neither changes task state nor answers for a user. */
  recordDisposition(input: unknown, callerInput: unknown): Receipt<HandoffDispositionRecordType> {
    const parsed = HandoffDispositionInput.parse(input)
    const caller = HandoffActor.parse(callerInput)
    return this.repository.atomic((db) => {
      const request = this.requireRequest(db, parsed.requestID)
      this.assertCurrentRequest(db, request)
      this.assertArchitectOwnsPlan(db, request.source, caller)
      const reportRow = db
        .query<PayloadRow, [string, string, string]>(
          `SELECT payload FROM recovery_handoff_reports
           WHERE project_directory=? AND request_id=? AND report_id=?`,
        )
        .get(this.repository.projectDirectory, parsed.requestID, parsed.reportID)
      if (!reportRow) throw new Error("Report is not attached to this handoff request")

      const existing = db
        .query<PayloadRow, [string, string]>(
          `SELECT payload FROM recovery_handoff_dispositions
           WHERE project_directory=? AND disposition_id=?`,
        )
        .get(this.repository.projectDirectory, parsed.dispositionID)
      if (existing) {
        const record = HandoffDispositionRecord.parse(JSON.parse(existing.payload))
        const same =
          record.requestID === parsed.requestID &&
          canonical(this.dispositionInput(record)) === canonical(parsed) &&
          canonical(record.recordedBy) === canonical(caller)
        return same
          ? { status: "replayed" as const, record }
          : {
              status: "conflict" as const,
              message: "dispositionID already identifies different content",
            }
      }
      if (parsed.relatedTaskIDs.length) {
        const placeholders = parsed.relatedTaskIDs.map(() => "?").join(",")
        const found = db
          .query<{ count: number }, (string | number)[]>(
            `SELECT COUNT(*) AS count FROM tasks WHERE project_directory=? AND id IN (${placeholders})`,
          )
          .get(this.repository.projectDirectory, ...parsed.relatedTaskIDs)!.count
        if (found !== parsed.relatedTaskIDs.length)
          throw new Error("Related task must belong to this project")
      }
      const record = HandoffDispositionRecord.parse({
        ...parsed,
        source: request.source,
        recordedBy: caller,
        createdAt: this.timestamp(),
      })
      db.query(
        `INSERT INTO recovery_handoff_dispositions
         (project_directory,request_id,report_id,disposition_id,payload) VALUES(?,?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        parsed.requestID,
        parsed.reportID,
        parsed.dispositionID,
        JSON.stringify(record),
      )
      this.appendEvent(
        db,
        parsed.requestID,
        "architect-disposition",
        parsed.dispositionID,
        {
          dispositionID: record.dispositionID,
          reportID: record.reportID,
          decision: record.decision,
          question: record.question,
          answer: record.answer,
        },
        record.createdAt,
      )
      return { status: "recorded" as const, record }
    })
  }

  getRequest(requestID: string): HandoffRequestRecordType | undefined {
    return this.repository.atomic((db) => {
      const row = this.requestRow(db, requestID)
      return row ? HandoffRequestRecord.parse(JSON.parse(row.payload)) : undefined
    })
  }

  getDraft(requestID: string, draftVersion: number): HandoffDraftRecordType | undefined {
    return this.repository.atomic((db) => {
      const row = this.draftRow(db, requestID, draftVersion)
      return row ? HandoffDraftRecord.parse(JSON.parse(row.payload)) : undefined
    })
  }

  getReviewRound(
    requestID: string,
    reviewID: string,
    round: number,
  ): HandoffReviewRoundRecordType | undefined {
    return this.repository.atomic((db) => {
      const row = db
        .query<PayloadRow, [string, string, string, number]>(
          `SELECT payload FROM recovery_handoff_rounds
           WHERE project_directory=? AND request_id=? AND review_id=? AND round=?`,
        )
        .get(this.repository.projectDirectory, requestID, reviewID, round)
      return row ? HandoffReviewRoundRecord.parse(JSON.parse(row.payload)) : undefined
    })
  }

  getReport(requestID: string, reportID: string): HandoffReportRecordType | undefined {
    return this.repository.atomic((db) => {
      const row = db
        .query<PayloadRow, [string, string, string]>(
          `SELECT payload FROM recovery_handoff_reports
           WHERE project_directory=? AND request_id=? AND report_id=?`,
        )
        .get(this.repository.projectDirectory, requestID, reportID)
      return row ? HandoffReportRecord.parse(JSON.parse(row.payload)) : undefined
    })
  }

  getDisposition(
    requestID: string,
    dispositionID: string,
  ): HandoffDispositionRecordType | undefined {
    return this.repository.atomic((db) => {
      const row = db
        .query<PayloadRow, [string, string, string]>(
          `SELECT payload FROM recovery_handoff_dispositions
           WHERE project_directory=? AND request_id=? AND disposition_id=?`,
        )
        .get(this.repository.projectDirectory, requestID, dispositionID)
      return row ? HandoffDispositionRecord.parse(JSON.parse(row.payload)) : undefined
    })
  }

  pendingNotifications(limit = 20): HandoffNotificationIntentType[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > NotificationLimit)
      throw new Error(`Use a notification limit from 1 to ${NotificationLimit}`)
    return this.repository.atomic((db) =>
      db
        .query<PayloadRow, [string, number]>(
          `SELECT payload FROM recovery_handoff_notifications WHERE project_directory=?
           ORDER BY rowid LIMIT ?`,
        )
        .all(this.repository.projectDirectory, limit)
        .map((row) => HandoffNotificationIntent.parse(JSON.parse(row.payload))),
    )
  }

  /** Read the immutable source attachment plus a bounded, forward-pageable event history. */
  readHistory(input: {
    requestID: string
    limit?: number
    cursor?: string
  }): HandoffHistoryPage | undefined {
    const requestID = HandoffRequestInput.shape.requestID.parse(input.requestID)
    const limit = input.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Use a handoff history limit from 1 to 100")
    let before: number | undefined
    if (input.cursor !== undefined) {
      try {
        const cursor = HandoffHistoryCursor.parse(
          JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
        )
        if (cursor.requestID !== requestID) throw new Error("cursor request mismatch")
        before = cursor.before
      } catch {
        throw new Error("Invalid handoff history cursor")
      }
    }
    return this.repository.atomic((db) => {
      const requestRow = this.requestRow(db, requestID)
      if (!requestRow) return undefined
      const rows = db
        .query<EventRow, (string | number)[]>(
          `SELECT sequence,request_id,kind,record_id,data,created_at
           FROM recovery_handoff_events
           WHERE project_directory=? AND request_id=?${before === undefined ? "" : " AND sequence < ?"}
           ORDER BY sequence DESC LIMIT ?`,
        )
        .all(
          this.repository.projectDirectory,
          requestID,
          ...(before === undefined ? [] : [before]),
          limit + 1,
        )
      const visible = rows.slice(0, limit)
      const nextCursor =
        rows.length > limit && visible.length
          ? Buffer.from(JSON.stringify({ requestID, before: visible.at(-1)!.sequence })).toString(
              "base64url",
            )
          : null
      const request = HandoffRequestRecord.parse(JSON.parse(requestRow.payload))
      return {
        request,
        events: visible.map((row) => this.eventRecord(row)),
        nextCursor,
      }
    })
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString()
  }

  private requestRow(db: Database, requestID: string): PayloadRow | undefined {
    return (
      db
        .query<PayloadRow, [string, string]>(
          `SELECT payload FROM recovery_handoff_requests WHERE project_directory=? AND request_id=?`,
        )
        .get(this.repository.projectDirectory, requestID) ?? undefined
    )
  }

  private requireRequest(db: Database, requestID: string): HandoffRequestRecordType {
    const row = this.requestRow(db, requestID)
    if (!row) throw new Error("Handoff request not found in this project")
    return HandoffRequestRecord.parse(JSON.parse(row.payload))
  }

  private draftRow(db: Database, requestID: string, version: number): PayloadRow | undefined {
    return (
      db
        .query<PayloadRow, [string, string, number]>(
          `SELECT payload FROM recovery_handoff_drafts
           WHERE project_directory=? AND request_id=? AND draft_version=?`,
        )
        .get(this.repository.projectDirectory, requestID, version) ?? undefined
    )
  }

  private resolveSourceRow(db: Database, selector: { attemptID: string }): SourceRow | undefined {
    const selectorValue = selector.attemptID
    const row = db
      .query<SourceRow, [string, string]>(
        `SELECT t.body AS task_body,p.id AS plan_id,p.revision AS plan_revision,
                p.version AS plan_version,p.state AS plan_state,p.owner AS plan_owner,p.body AS plan_body,
                n.task_id AS node_task_id,n.state AS node_state,n.ordinal AS node_ordinal,
                n.spec_revision AS node_spec_revision,
                n.machine_version AS node_machine_version,n.snapshot AS node_snapshot,
                a.id AS attempt_id,a.number AS attempt_number,a.session_id AS attempt_session_id,
                a.state AS attempt_state,a.started_at AS attempt_started_at,a.workspace AS attempt_workspace,
                a.base_commit AS attempt_base_commit,a.artifact AS attempt_artifact,a.policy AS attempt_policy,
                a.token_count AS attempt_token_count,a.tool_count AS attempt_tool_count,
                a.retry_count AS attempt_retry_count,a.cost AS attempt_cost
         FROM runner_attempts a
         JOIN runner_plans p ON p.id=a.plan_id AND p.project_directory=?
         JOIN runner_nodes n ON n.plan_id=p.id AND n.task_id=a.task_id
         JOIN tasks t ON t.id=n.task_id AND t.project_directory=p.project_directory
         WHERE a.id=?`,
      )
      .get(this.repository.projectDirectory, selectorValue)
    if (!row) return undefined
    const task = TaskSpecSchema.parse(JSON.parse(row.task_body))
    if (task.id !== row.node_task_id || task.revision !== row.node_spec_revision)
      throw new Error("Source runner node no longer matches the immutable task specification")
    return row
  }

  private sourceFromRow(row: SourceRow, requestGeneration: number): HandoffSourceType {
    const task = TaskSpecSchema.parse(JSON.parse(row.task_body))
    if (
      task.id !== row.node_task_id ||
      task.revision !== row.node_spec_revision ||
      task.provenance.projectDirectory !== this.repository.projectDirectory
    )
      throw new Error("Source runner ownership does not match the stored task specification")
    const attachment = HandoffAttachment.parse({
      projectDirectory: this.repository.projectDirectory,
      planID: row.plan_id,
      taskID: task.id,
      specRevision: row.node_spec_revision,
      attemptID: row.attempt_id,
      sourceSessionID: row.attempt_session_id,
      requestGeneration,
    })
    let policy: unknown
    try {
      policy = JSON.parse(row.attempt_policy)
    } catch {
      policy = null
    }
    const policyAgent =
      typeof policy === "object" &&
      policy !== null &&
      "agent" in policy &&
      typeof policy.agent === "string"
        ? policy.agent
        : null
    return HandoffSource.parse({
      attachment,
      task,
      plan: {
        revision: row.plan_revision,
        version: row.plan_version,
        state: row.plan_state,
        ownerSessionID: row.plan_owner,
        body: JSON.parse(row.plan_body),
      },
      node: {
        state: row.node_state,
        ordinal: row.node_ordinal,
        specRevision: row.node_spec_revision,
        machineVersion: row.node_machine_version,
        snapshot: JSON.parse(row.node_snapshot),
      },
      attempt: {
        number: row.attempt_number,
        state: row.attempt_state,
        startedAt: row.attempt_started_at,
        workspace: row.attempt_workspace,
        baseCommit: row.attempt_base_commit,
        artifact: row.attempt_artifact,
        tokenCount: row.attempt_token_count,
        toolCount: row.attempt_tool_count,
        retryCount: row.attempt_retry_count,
        costUSD: row.attempt_cost,
        policyAgent,
      },
    })
  }

  private assertRequestAuthority(
    db: Database,
    request: HandoffRequestRecordType,
    actor: HandoffActorType,
  ): void {
    this.assertCurrentRequest(db, request)
    this.assertArchitectOwnsPlan(db, request.source, actor)
  }

  private assertWorkerOwnsSource(source: HandoffSourceType, actor: HandoffActorType): void {
    if (
      actor.role !== "worker" ||
      actor.sessionID !== source.attachment.sourceSessionID ||
      !source.attempt.policyAgent ||
      actor.agent !== source.attempt.policyAgent
    )
      throw new Error("Handoff caller is not the worker assigned to this source attempt")
  }

  private assertDraftAuthor(
    db: Database,
    request: HandoffRequestRecordType,
    actor: HandoffActorType,
  ): void {
    this.assertCurrentRequest(db, request)
    this.assertWorkerOwnsSource(request.source, actor)
  }

  private assertReviewAuthority(
    db: Database,
    request: HandoffRequestRecordType,
    actor: HandoffActorType,
  ): void {
    this.assertCurrentRequest(db, request)
    if (actor.role === "worker") this.assertWorkerOwnsSource(request.source, actor)
    else this.assertArchitectOwnsPlan(db, request.source, actor)
  }

  private assertCurrentRequest(db: Database, request: HandoffRequestRecordType): void {
    const source = request.source
    const currentSource = db
      .query<{ id: string; task_body: string }, (string | number)[]>(
        `SELECT a.id,t.body AS task_body FROM runner_attempts a
         JOIN runner_plans p ON p.id=a.plan_id AND p.project_directory=?
         JOIN runner_nodes n ON n.plan_id=p.id AND n.task_id=a.task_id
         JOIN tasks t ON t.id=n.task_id AND t.project_directory=p.project_directory
         WHERE a.id=? AND a.plan_id=? AND a.task_id=? AND a.session_id=?
           AND n.spec_revision=? AND json_extract(t.body,'$.revision')=?`,
      )
      .get(
        this.repository.projectDirectory,
        source.attachment.attemptID,
        source.attachment.planID,
        source.attachment.taskID,
        source.attachment.sourceSessionID,
        source.attachment.specRevision,
        source.attachment.specRevision,
      )
    if (!currentSource)
      throw new Error("Handoff source attempt is stale or no longer project-owned")
    const currentTask = TaskSpecSchema.parse(JSON.parse(currentSource.task_body))
    if (canonical(currentTask) !== canonical(source.task))
      throw new Error("Handoff source task contract is stale")
    const generation = db
      .query<{ generation: number }, [string, string]>(
        `SELECT COALESCE(MAX(request_generation),0) AS generation
         FROM recovery_handoff_requests WHERE project_directory=? AND attempt_id=?`,
      )
      .get(this.repository.projectDirectory, source.attachment.attemptID)!.generation
    if (generation !== source.attachment.requestGeneration)
      throw new Error("Handoff request generation is stale")
  }

  private assertArchitectOwnsPlan(
    db: Database,
    source: HandoffSourceType,
    actor: HandoffActorType,
  ): void {
    if (actor.role !== "architect")
      throw new Error("Only the authorized Architect may review or finalize a handoff")
    const owner = db
      .query<{ owned: number }, [string, string, string]>(
        `SELECT 1 AS owned FROM runner_plans
         WHERE id=? AND project_directory=? AND owner=?`,
      )
      .get(source.attachment.planID, this.repository.projectDirectory, actor.sessionID)
    if (!owner) throw new Error("Handoff caller is not the current owner of the source plan")
  }

  private appendEvent(
    db: Database,
    requestID: string,
    kind: HandoffEventRecordType["kind"],
    recordID: string,
    data: unknown,
    createdAt: string,
  ): void {
    const value = JsonValueSchema.parse(data)
    db.query(
      `INSERT INTO recovery_handoff_events
       (project_directory,request_id,kind,record_id,data,created_at) VALUES(?,?,?,?,?,?)`,
    ).run(
      this.repository.projectDirectory,
      requestID,
      kind,
      recordID,
      JSON.stringify(value),
      createdAt,
    )
  }

  private eventRecord(row: EventRow): HandoffEventRecordType {
    return HandoffEventRecord.parse({
      sequence: row.sequence,
      requestID: row.request_id,
      kind: row.kind,
      recordID: row.record_id,
      data: JSON.parse(row.data),
      createdAt: row.created_at,
    })
  }

  private reservationIdentity(record: HandoffReviewRoundRecordType) {
    return {
      requestID: record.requestID,
      reviewID: record.reviewID,
      round: record.round,
      draftVersion: record.draftVersion,
      reviewer: record.reviewer,
      evidenceVersion: record.evidenceVersion,
      evidence: record.evidence,
      effectiveContractVersion: record.effectiveContractVersion,
      effectiveContract: record.effectiveContract,
      checkVersion: record.checkVersion,
      checks: record.checks,
    }
  }

  private reservationIdentityFromInput(
    input: ReturnType<typeof HandoffReviewReservationInput.parse>,
    reviewer: HandoffActorType,
    _source: HandoffSourceType,
  ) {
    return {
      requestID: input.requestID,
      reviewID: input.reviewID,
      round: input.round,
      draftVersion: input.draftVersion,
      reviewer,
      evidenceVersion: input.evidenceVersion,
      evidence: input.evidence,
      effectiveContractVersion: input.effectiveContractVersion,
      effectiveContract: input.effectiveContract,
      checkVersion: input.checkVersion,
      checks: input.checks,
    }
  }

  private roundKey(reviewID: string, round: number): string {
    return `${reviewID}:${round}`
  }

  private finalizationStatus(outcome: HandoffReviewOutcomeType): {
    reviewStatus: HandoffReportRecordType["reviewStatus"]
    limitation: string | null
  } {
    if (outcome.status === "completed" || outcome.status === "completed_with_concerns")
      return { reviewStatus: "reviewed", limitation: null }
    if (outcome.status === "disabled" || outcome.status === "unavailable")
      return { reviewStatus: outcome.status, limitation: outcome.limitation }
    throw new Error("A handoff cannot be finalized from a pending review result")
  }

  private dispositionInput(record: HandoffDispositionRecordType): HandoffDispositionInputType {
    return HandoffDispositionInput.parse({
      dispositionID: record.dispositionID,
      requestID: record.requestID,
      reportID: record.reportID,
      decision: record.decision,
      correction: record.correction,
      reason: record.reason,
      evidence: record.evidence,
      question: record.question,
      answer: record.answer,
      relatedTaskIDs: record.relatedTaskIDs,
    })
  }
}

type ReviewHeaderRow = {
  request_id: string
  review_id: string
  owner_json: string
  contract_version: string
  contract_json: string
  check_version: string
  checks_json: string
  created_at: string
}

type FinalizationRow = { report_payload: string; notification_payload: string }
