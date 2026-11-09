import type { Database } from "bun:sqlite"
import { SessionMessage } from "@opencode/schema/session-message"
import { canonical } from "../../identity.ts"
import { REVIEW_ROUNDS } from "../../review/progression.ts"
import type { TaskRepository } from "../../storage.ts"
import { TaskSpecSchema } from "../../task.ts"
import { RunnerStore } from "../../runner/store.ts"
import { interruptedHandoffReviewOutcome } from "./review-state.ts"
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
  RecoveryConcernCursor,
  RecoveryConcernPage,
  HandoffNotificationIntent,
  HandoffRequestBody,
  HandoffRequestInput,
  HandoffRequestRecord,
  HandoffReviewCheck,
  HandoffReviewFinalizationAuthorizationInput,
  HandoffReviewOutcomeInput,
  HandoffReviewReservationInput,
  HandoffReviewRoundRecord,
  HandoffReportRecord,
  HandoffSource,
  RecoveryCheckpointDelivery,
  RecoveryCheckpointState,
  RecoveryCheckpointConsumptionRecord,
  RecoveryCheckpointInput,
  RecoveryCheckpointRecord,
  RecoveryCheckpointResponseInput,
  RecoveryCheckpointResponseRecord,
  RecoveryConcernInput,
  RecoveryConcernRecord,
  RecoveryDispositionInput,
  RecoveryDispositionRecord,
  RecoverySource,
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
  RecoveryCheckpointState as RecoveryCheckpointStateType,
  RecoveryCheckpointResponseInput as RecoveryCheckpointResponseInputType,
  RecoveryConcernPage as RecoveryConcernPageType,
  RecoveryCheckpointRecord as RecoveryCheckpointRecordType,
  RecoveryCheckpointResponseRecord as RecoveryCheckpointResponseRecordType,
  RecoveryConcernRecord as RecoveryConcernRecordType,
  RecoveryDispositionRecord as RecoveryDispositionRecordType,
  RecoveryDispositionInput as RecoveryDispositionInputType,
  RecoverySource as RecoverySourceType,
} from "./schema.ts"

type Receipt<T> =
  | { status: "created" | "recorded"; record: T }
  | { status: "replayed"; record: T }
  | { status: "conflict"; message: string }

export const HANDOFF_REVIEW_RESERVATION_LEASE_MS = 120_000

const REVIEW_ROUNDS_EXHAUSTED_ERROR =
  "The three reserved review rounds are exhausted; no semantic pass was established."
const REVIEW_ROUNDS_EXHAUSTED_LIMITATION = "The review round budget is exhausted."

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
type RecoveryPayloadRow = { payload: string }
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
        CREATE TABLE IF NOT EXISTS recovery_concern_versions (
          project_directory TEXT NOT NULL,
          concern_id TEXT NOT NULL,
          version INTEGER NOT NULL CHECK(version > 0),
          request_id TEXT NOT NULL,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          plan_id TEXT NOT NULL REFERENCES runner_plans(id),
          attempt_id TEXT NOT NULL REFERENCES runner_attempts(id),
          source_session_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(project_directory, concern_id, version),
          UNIQUE(project_directory, request_id)
        );
        CREATE INDEX IF NOT EXISTS recovery_concerns_attempt
          ON recovery_concern_versions(project_directory, attempt_id, concern_id, version DESC);
        CREATE TABLE IF NOT EXISTS recovery_concern_dispositions (
          project_directory TEXT NOT NULL,
          disposition_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          concern_id TEXT NOT NULL,
          version INTEGER NOT NULL CHECK(version > 0),
          attempt_id TEXT NOT NULL REFERENCES runner_attempts(id),
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(project_directory, disposition_id),
          UNIQUE(project_directory, request_id),
          UNIQUE(project_directory, concern_id, version),
          FOREIGN KEY(project_directory, concern_id, version)
            REFERENCES recovery_concern_versions(project_directory, concern_id, version)
        );
        CREATE TABLE IF NOT EXISTS recovery_checkpoint_commands (
          project_directory TEXT NOT NULL,
          request_id TEXT NOT NULL,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          plan_id TEXT NOT NULL REFERENCES runner_plans(id),
          attempt_id TEXT NOT NULL REFERENCES runner_attempts(id),
          source_session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(project_directory, request_id),
          UNIQUE(project_directory, source_session_id, message_id)
        );
        CREATE TABLE IF NOT EXISTS recovery_checkpoint_delivery (
          project_directory TEXT NOT NULL,
          request_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('prepared','admitted','unknown')),
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(project_directory, request_id),
          FOREIGN KEY(project_directory, request_id)
            REFERENCES recovery_checkpoint_commands(project_directory, request_id)
        );
        CREATE TABLE IF NOT EXISTS recovery_checkpoint_responses (
          project_directory TEXT NOT NULL,
          request_id TEXT NOT NULL,
          response_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(project_directory, request_id),
          UNIQUE(project_directory, response_id),
          FOREIGN KEY(project_directory, request_id)
            REFERENCES recovery_checkpoint_commands(project_directory, request_id)
        );
        CREATE TABLE IF NOT EXISTS recovery_checkpoint_consumptions (
          project_directory TEXT NOT NULL,
          request_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(project_directory, request_id),
          FOREIGN KEY(project_directory, request_id)
            REFERENCES recovery_checkpoint_commands(project_directory, request_id)
        );
        CREATE TABLE IF NOT EXISTS recovery_control_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          project_directory TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          record_id TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(project_directory, kind, record_id)
        );
        CREATE INDEX IF NOT EXISTS recovery_control_events_attempt
          ON recovery_control_events(project_directory, attempt_id, sequence DESC);
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
        (requestedHeader.contract_version !== effectiveContractVersion ||
          requestedHeader.contract_json !== canonical(effectiveContract) ||
          requestedHeader.check_version !== checkVersion ||
          requestedHeader.checks_json !== canonical(checks))
      )
        throw new Error("Review effective contract/check version is stale")

      // The contract owns the chain; each reservation retains its actual reviewer.
      const matching = policyInputCount
        ? headers.filter(
            (header) =>
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
          review.contract_version !== reservation.effectiveContractVersion ||
          review.contract_json !== canonical(contract) ||
          review.check_version !== reservation.checkVersion ||
          review.checks_json !== canonical(checks)
        )
          throw new Error("Review effective contract/check version is stale")
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
      const expectedRound = existingRounds.length + 1
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
    const { outcome, ...identity } = HandoffReviewOutcomeInput.parse(input)
    return this.completeReviewOutcome(identity, reviewerInput, outcome)
  }

  /** A current authorized actor may close an expired reservation as interrupted. */
  recoverReviewOutcome(
    input: unknown,
    reviewerInput: unknown,
  ): Receipt<HandoffReviewRoundRecordType> {
    const identity = HandoffReviewOutcomeInput.omit({ outcome: true }).parse(input)
    return this.completeReviewOutcome(identity, reviewerInput)
  }

  private completeReviewOutcome(
    parsed: { requestID: string; reviewID: string; round: number },
    reviewerInput: unknown,
    suppliedOutcome?: HandoffReviewOutcomeType,
  ): Receipt<HandoffReviewRoundRecordType> {
    const reviewer = HandoffActor.parse(reviewerInput)
    const recovering = suppliedOutcome === undefined
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
        (!recovering && canonical(reserved.reviewer) !== canonical(reviewer))
      )
        throw new Error("Review round belongs to another request or caller")
      // Recovery supplies no outcome to compare. A durable result always wins,
      // even if more rounds were completed after this reservation.
      if (recovering && row.outcome_json !== null)
        return { status: "replayed" as const, record: reserved }
      const outcome =
        suppliedOutcome ??
        interruptedHandoffReviewOutcome(
          this.readReviewContext(
            {
              requestID: parsed.requestID,
              draftVersion: reserved.draftVersion,
              reviewID: reserved.reviewID,
              effectiveContractVersion: reserved.effectiveContractVersion,
              effectiveContract: reserved.effectiveContract,
              checkVersion: reserved.checkVersion,
              checks: reserved.checks,
            },
            reviewer,
          ),
          reserved,
        )
      if (row.outcome_json !== null) {
        const saved = HandoffReviewRoundRecord.parse(JSON.parse(row.payload))
        return canonical(saved.outcome) === canonical(outcome)
          ? { status: "replayed" as const, record: saved }
          : { status: "conflict" as const, message: "Review outcome is immutable once recorded" }
      }
      const completedAt = this.timestamp()
      if (
        recovering &&
        Date.parse(completedAt) - Date.parse(reserved.reservedAt) <
          HANDOFF_REVIEW_RESERVATION_LEASE_MS
      )
        throw new Error("Review reservation is still within its recovery window")
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
          reviewer: reserved.reviewer,
          completedBy: reviewer,
          recovered: recovering,
        },
        completedAt,
      )
      return { status: "recorded" as const, record }
    })
  }

  /** Persist the current Architect's authority over the exact result they reviewed. */
  authorizeReviewFinalization(input: unknown, callerInput: unknown): boolean {
    const parsed = HandoffReviewFinalizationAuthorizationInput.parse(input)
    const caller = HandoffActor.parse(callerInput)
    if (caller.role !== "architect")
      throw new Error("Only the authorized Architect may authorize handoff finalization")

    return this.repository.atomic((db) => {
      const request = this.requireRequest(db, parsed.requestID)
      this.assertReviewAuthority(db, request, caller)
      const row = db
        .query<RoundRow, [string, string, string, number]>(
          `SELECT payload,outcome_json FROM recovery_handoff_rounds
           WHERE project_directory=? AND request_id=? AND review_id=? AND round=?`,
        )
        .get(this.repository.projectDirectory, parsed.requestID, parsed.reviewID, parsed.round)
      if (!row || row.outcome_json === null) return false

      const review = HandoffReviewRoundRecord.parse(JSON.parse(row.payload))
      const result = parsed.result
      if (
        review.requestID !== parsed.requestID ||
        review.draftVersion !== parsed.draftVersion ||
        review.reviewID !== parsed.reviewID ||
        review.round !== parsed.round ||
        result.requestID !== parsed.requestID ||
        result.reviewID !== parsed.reviewID ||
        result.round !== parsed.round ||
        result.fingerprint !== parsed.fingerprint ||
        !["completed", "completed_with_concerns", "disabled", "unavailable"].includes(
          String(result.status),
        )
      )
        return false

      const storedResultMatches = canonical(review.outcome?.result) === canonical(result)
      if (storedResultMatches) {
        if (!review.outcome) return false
        this.finalizationStatus(review.outcome)
      } else if (!this.isExhaustedReviewResult(db, review, result)) {
        return false
      }

      const authorization = {
        requestID: parsed.requestID,
        draftVersion: parsed.draftVersion,
        reviewID: parsed.reviewID,
        round: parsed.round,
        fingerprint: parsed.fingerprint,
        resultKind: storedResultMatches ? "stored" : "exhausted",
        result,
        authorizedBy: caller,
      }
      const prior = db
        .query<{ data: string }, [string, string, string, string]>(
          `SELECT data FROM recovery_handoff_events
           WHERE project_directory=? AND request_id=? AND kind=? AND record_id=?`,
        )
        .all(
          this.repository.projectDirectory,
          parsed.requestID,
          "review-finalization-authorized",
          this.roundKey(parsed.reviewID, parsed.round),
        )
        .some((event) => canonical(JSON.parse(event.data)) === canonical(authorization))
      if (!prior)
        this.appendEvent(
          db,
          parsed.requestID,
          "review-finalization-authorized",
          this.roundKey(parsed.reviewID, parsed.round),
          authorization,
          this.timestamp(),
        )
      return true
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
        const reportedResult =
          report.reviewResult ?? JsonObjectSchema.safeParse(report.review.outcome?.result).data
        const same =
          report.requestID === parsed.requestID &&
          report.draftVersion === parsed.draftVersion &&
          report.reviewID === parsed.reviewID &&
          report.round === parsed.round &&
          canonical(report.finalizedBy) === canonical(caller) &&
          (parsed.fingerprint === undefined || reportedResult?.fingerprint === parsed.fingerprint)
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
      const reviewMatches =
        review.requestID === parsed.requestID &&
        review.draftVersion === parsed.draftVersion &&
        review.reviewID === parsed.reviewID &&
        review.round === parsed.round &&
        roundRow.outcome_json !== null &&
        !!review.outcome
      const authorization = reviewMatches
        ? this.findReviewFinalizationAuthorization(
            db,
            {
              requestID: parsed.requestID,
              draftVersion: parsed.draftVersion,
              reviewID: parsed.reviewID,
              round: parsed.round,
              ...(parsed.fingerprint ? { fingerprint: parsed.fingerprint } : {}),
            },
            caller,
          )
        : undefined
      const storedResult = JsonObjectSchema.safeParse(review.outcome?.result)
      const storedFingerprint = storedResult.success ? storedResult.data.fingerprint : undefined
      if (
        !reviewMatches ||
        (canonical(review.reviewer) !== canonical(caller) && !authorization) ||
        (!authorization &&
          parsed.fingerprint !== undefined &&
          storedFingerprint !== parsed.fingerprint)
      )
        throw new Error("Review result is missing, stale, or belongs to another draft/caller")

      const finalizationStatus =
        authorization &&
        review.outcome!.status !== "unavailable" &&
        review.outcome!.status !== "disabled"
          ? this.finalizationStatusFromResult(authorization.result)
          : this.finalizationStatus(review.outcome!)
      const concerns = authorization
        ? this.reviewResultConcerns(authorization.result)
        : review.outcome!.concerns
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
        ...finalizationStatus,
        concerns,
        ...(authorization ? { reviewResult: authorization.result } : {}),
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

      const currentVersion = db
        .query<{ version: number }, [string, string, string]>(
          `SELECT COALESCE(MAX(COALESCE(json_extract(payload,'$.version'),1)),0) AS version
           FROM recovery_handoff_dispositions
           WHERE project_directory=? AND request_id=? AND report_id=?`,
        )
        .get(this.repository.projectDirectory, parsed.requestID, parsed.reportID)!.version

      const existing = db
        .query<PayloadRow, [string, string]>(
          `SELECT payload FROM recovery_handoff_dispositions
           WHERE project_directory=? AND disposition_id=?`,
        )
        .get(this.repository.projectDirectory, parsed.dispositionID)
      if (existing) {
        const record = HandoffDispositionRecord.parse(JSON.parse(existing.payload))
        const expected = parsed.expectedVersion ?? record.expectedVersion ?? currentVersion
        const same =
          record.requestID === parsed.requestID &&
          canonical(this.dispositionInput(record)) ===
            canonical({ ...parsed, expectedVersion: expected }) &&
          canonical(record.recordedBy) === canonical(caller)
        return same
          ? { status: "replayed" as const, record }
          : {
              status: "conflict" as const,
              message: "dispositionID already identifies different content",
            }
      }
      if (parsed.expectedVersion !== undefined && parsed.expectedVersion !== currentVersion)
        throw new Error(
          `Handoff disposition version conflict: expected ${parsed.expectedVersion}, current ${currentVersion}`,
        )
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
        expectedVersion: parsed.expectedVersion ?? currentVersion,
        version: currentVersion + 1,
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

  /** Append a bounded Architect concern against the exact task and attempt. */
  recordConcern(input: unknown, callerInput: unknown): Receipt<RecoveryConcernRecordType> {
    const parsed = RecoveryConcernInput.parse(input)
    const caller = HandoffActor.parse(callerInput)
    if (caller.role !== "architect")
      throw new Error("Only the source plan's Architect may attach a recovery concern")
    return this.repository.atomic((db) => {
      const existing = db
        .query<RecoveryPayloadRow, [string, string]>(
          `SELECT payload FROM recovery_concern_versions
           WHERE project_directory=? AND request_id=?`,
        )
        .get(this.repository.projectDirectory, parsed.requestID)
      const row = this.resolveSourceRow(db, { attemptID: parsed.sourceAttemptID })
      if (!row) throw new Error("No project-owned source attempt matches this concern")
      const handoffSource = this.sourceFromRow(row, 1)
      this.assertArchitectOwnsPlan(db, handoffSource, caller)
      const source = this.recoverySourceFromRow(row)
      if (existing) {
        const record = RecoveryConcernRecord.parse(JSON.parse(existing.payload))
        const same =
          record.concernID === parsed.concernID &&
          record.expectedVersion === parsed.expectedVersion &&
          record.ruleID === parsed.ruleID &&
          record.reason === parsed.reason &&
          canonical(record.evidenceBoundary) === canonical(parsed.evidenceBoundary) &&
          canonical(record.evidence) === canonical(parsed.evidence) &&
          canonical(record.source) === canonical(source) &&
          canonical(record.recordedBy) === canonical(caller)
        return same
          ? { status: "replayed" as const, record }
          : {
              status: "conflict" as const,
              message: "requestID already identifies different concern content",
            }
      }

      const latestRow = this.latestConcernRow(db, parsed.concernID)
      const latest = latestRow
        ? RecoveryConcernRecord.parse(JSON.parse(latestRow.payload))
        : undefined
      const currentVersion = latest?.version ?? 0
      if (parsed.expectedVersion !== currentVersion)
        throw new Error(
          `Recovery concern version conflict: expected ${parsed.expectedVersion}, current ${currentVersion}`,
        )
      if (latest && canonical(latest.source) !== canonical(source))
        throw new Error("A recovery concern cannot move to another source task or attempt")
      if (
        latest &&
        parsed.evidenceBoundary.throughSequence < latest.evidenceBoundary.throughSequence
      )
        throw new Error("A recovery concern update cannot move its evidence boundary backwards")

      const record = RecoveryConcernRecord.parse({
        requestID: parsed.requestID,
        concernID: parsed.concernID,
        version: currentVersion + 1,
        expectedVersion: parsed.expectedVersion,
        source,
        ruleID: parsed.ruleID,
        reason: parsed.reason,
        evidenceBoundary: parsed.evidenceBoundary,
        evidence: parsed.evidence,
        lastDispositionID: null,
        recordedBy: caller,
        createdAt: this.timestamp(),
      })
      db.query(
        `INSERT INTO recovery_concern_versions
         (project_directory,concern_id,version,request_id,task_id,plan_id,attempt_id,source_session_id,payload,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        record.concernID,
        record.version,
        record.requestID,
        record.source.taskID,
        record.source.planID,
        record.source.attemptID,
        record.source.sessionID,
        JSON.stringify(record),
        record.createdAt,
      )
      this.appendControlEvent(
        db,
        record.source.attemptID,
        "concern-recorded",
        record.requestID,
        record,
        record.createdAt,
      )
      return { status: "recorded" as const, record }
    })
  }

  /** Read current concerns and their durable Architect decisions without steering a worker. */
  readConcerns(
    input: { attemptID: string; limit?: number; cursor?: string },
    callerInput: unknown,
  ): RecoveryConcernPageType | undefined {
    const attemptID = HandoffRequestInput.shape.sourceAttemptID.parse(input.attemptID)
    const limit = input.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new Error("Use a recovery concern page limit from 1 to 50")
    let afterConcernID: string | undefined
    if (input.cursor !== undefined) {
      try {
        const cursor = RecoveryConcernCursor.parse(
          JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
        )
        if (cursor.attemptID !== attemptID) throw new Error("cursor attempt mismatch")
        afterConcernID = cursor.afterConcernID
      } catch {
        throw new Error("Invalid recovery concern cursor")
      }
    }
    const caller = HandoffActor.parse(callerInput)
    return this.repository.atomic((db) => {
      const row = this.resolveSourceRow(db, { attemptID })
      if (!row) return undefined
      const source = this.sourceFromRow(row, 1)
      this.assertRecoveryReader(db, source, caller)
      const rows = db
        .query<RecoveryPayloadRow, (string | number)[]>(
          `SELECT v.payload FROM recovery_concern_versions v
           JOIN (
             SELECT concern_id,MAX(version) AS version FROM recovery_concern_versions
             WHERE project_directory=? AND attempt_id=? GROUP BY concern_id
           ) latest ON latest.concern_id=v.concern_id AND latest.version=v.version
           WHERE v.project_directory=? AND v.attempt_id=?${afterConcernID ? " AND v.concern_id>?" : ""}
           ORDER BY v.concern_id LIMIT ?`,
        )
        .all(
          this.repository.projectDirectory,
          attemptID,
          this.repository.projectDirectory,
          attemptID,
          ...(afterConcernID ? [afterConcernID] : []),
          limit + 1,
        )
      const visible = rows
        .slice(0, limit)
        .map((item) => RecoveryConcernRecord.parse(JSON.parse(item.payload)))
      const concerns = visible.map((concern) => ({
        concern,
        dispositions: db
          .query<RecoveryPayloadRow, [string, string]>(
            `SELECT payload FROM recovery_concern_dispositions
             WHERE project_directory=? AND concern_id=? ORDER BY version DESC LIMIT 100`,
          )
          .all(this.repository.projectDirectory, concern.concernID)
          .map((item) => RecoveryDispositionRecord.parse(JSON.parse(item.payload))),
      }))
      const nextCursor =
        rows.length > limit && visible.length
          ? Buffer.from(
              JSON.stringify({ attemptID, afterConcernID: visible.at(-1)!.concernID }),
            ).toString("base64url")
          : null
      return RecoveryConcernPage.parse({
        source: this.recoverySourceFromRow(row),
        concerns,
        nextCursor,
      })
    })
  }

  /** Record an append-only Architect decision against precisely reviewed concern evidence. */
  recordRecoveryDisposition(
    input: unknown,
    callerInput: unknown,
  ): Receipt<RecoveryDispositionRecordType> {
    const parsed = RecoveryDispositionInput.parse(input)
    const caller = HandoffActor.parse(callerInput)
    if (caller.role !== "architect")
      throw new Error("Only the source plan's Architect may disposition a recovery concern")
    return this.repository.atomic((db) => {
      const existing = db
        .query<RecoveryPayloadRow, [string, string]>(
          `SELECT payload FROM recovery_concern_dispositions WHERE project_directory=? AND request_id=?`,
        )
        .get(this.repository.projectDirectory, parsed.requestID)
      const row = this.resolveSourceRowForConcern(db, parsed.concernID)
      if (!row) throw new Error("Recovery concern does not exist in this project")
      const source = this.sourceFromRow(row, 1)
      this.assertArchitectOwnsPlan(db, source, caller)
      if (existing) {
        const record = RecoveryDispositionRecord.parse(JSON.parse(existing.payload))
        const same =
          canonical(this.recoveryDispositionInput(record)) === canonical(parsed) &&
          canonical(record.recordedBy) === canonical(caller)
        return same
          ? { status: "replayed" as const, record }
          : {
              status: "conflict" as const,
              message: "requestID already identifies a different disposition",
            }
      }
      const concernRow = db
        .query<RecoveryPayloadRow, [string, string, number]>(
          `SELECT payload FROM recovery_concern_versions
           WHERE project_directory=? AND concern_id=? AND version=?`,
        )
        .get(this.repository.projectDirectory, parsed.concernID, parsed.expectedVersion)
      if (!concernRow) {
        const latest = this.latestConcernRow(db, parsed.concernID)
        const current = latest ? RecoveryConcernRecord.parse(JSON.parse(latest.payload)).version : 0
        throw new Error(
          `Recovery concern version conflict: expected ${parsed.expectedVersion}, current ${current}`,
        )
      }
      const concern = RecoveryConcernRecord.parse(JSON.parse(concernRow.payload))
      const latest = this.latestConcernRow(db, parsed.concernID)
      const latestConcern = latest
        ? RecoveryConcernRecord.parse(JSON.parse(latest.payload))
        : undefined
      if (latestConcern?.version !== parsed.expectedVersion)
        throw new Error(
          `Recovery concern version conflict: expected ${parsed.expectedVersion}, current ${latestConcern?.version ?? 0}`,
        )
      if (
        parsed.evidenceBoundary.fromSequence < concern.evidenceBoundary.fromSequence ||
        parsed.evidenceBoundary.throughSequence > concern.evidenceBoundary.throughSequence
      )
        throw new Error("Disposition evidence must be contained in the recorded concern boundary")
      const record = RecoveryDispositionRecord.parse({
        ...parsed,
        version: parsed.expectedVersion,
        source: concern.source,
        recordedBy: caller,
        createdAt: this.timestamp(),
      })
      db.query(
        `INSERT INTO recovery_concern_dispositions
         (project_directory,disposition_id,request_id,concern_id,version,attempt_id,payload,created_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        record.dispositionID,
        record.requestID,
        record.concernID,
        record.version,
        record.source.attemptID,
        JSON.stringify(record),
        record.createdAt,
      )
      this.appendControlEvent(
        db,
        record.source.attemptID,
        "concern-disposition",
        record.requestID,
        record,
        record.createdAt,
      )
      return { status: "recorded" as const, record }
    })
  }

  /** Prepare one durable, idempotent checkpoint before attempting native steering. */
  prepareCheckpoint(input: unknown, callerInput: unknown): Receipt<RecoveryCheckpointRecordType> {
    const parsed = RecoveryCheckpointInput.parse(input)
    const caller = HandoffActor.parse(callerInput)
    if (caller.role !== "architect")
      throw new Error("Only the current Architect may request a checkpoint")
    return this.repository.atomic((db) => {
      const existing = db
        .query<RecoveryPayloadRow, [string, string]>(
          `SELECT payload FROM recovery_checkpoint_commands WHERE project_directory=? AND request_id=?`,
        )
        .get(this.repository.projectDirectory, parsed.requestID)
      const concernRow = db
        .query<RecoveryPayloadRow, [string, string, number]>(
          `SELECT payload FROM recovery_concern_versions WHERE project_directory=? AND concern_id=? AND version=?`,
        )
        .get(this.repository.projectDirectory, parsed.concernID, parsed.expectedVersion)
      if (!concernRow) throw new Error("Checkpoint concern version is not attached to this project")
      const concern = RecoveryConcernRecord.parse(JSON.parse(concernRow.payload))
      if (concern.source.attemptID !== parsed.attemptID)
        throw new Error("Checkpoint concern does not belong to the requested source attempt")
      const row = this.resolveSourceRow(db, { attemptID: parsed.attemptID })
      if (!row) throw new Error("Checkpoint source attempt is no longer project-owned")
      const handoffSource = this.sourceFromRow(row, 1)
      this.assertArchitectOwnsPlan(db, handoffSource, caller)
      this.assertLatestRunningAttempt(db, row)
      const source = this.recoverySourceFromRow(row)
      if (existing) {
        const record = RecoveryCheckpointRecord.parse(JSON.parse(existing.payload))
        const same =
          record.concernID === parsed.concernID &&
          record.attemptID === parsed.attemptID &&
          record.expectedVersion === parsed.expectedVersion &&
          canonical(record.evidenceBoundary) === canonical(parsed.evidenceBoundary) &&
          record.guidance === parsed.guidance &&
          canonical(record.source) === canonical(source) &&
          canonical(record.requestedBy) === canonical(caller)
        return same
          ? { status: "replayed" as const, record }
          : {
              status: "conflict" as const,
              message: "requestID already identifies a different checkpoint",
            }
      }
      if (source.workerAgent === null)
        throw new Error("Checkpoint source has no recorded admitted worker agent")
      if (
        parsed.evidenceBoundary.fromSequence < concern.evidenceBoundary.fromSequence ||
        parsed.evidenceBoundary.throughSequence > concern.evidenceBoundary.throughSequence
      )
        throw new Error("Checkpoint evidence boundary must be within the selected concern version")
      const record = RecoveryCheckpointRecord.parse({
        ...parsed,
        messageID: SessionMessage.ID.create(),
        source,
        requestedBy: caller,
        createdAt: this.timestamp(),
      })
      const createdAt = record.createdAt
      const prepared = RecoveryCheckpointDelivery.parse({
        requestID: record.requestID,
        status: "prepared",
        messageID: record.messageID,
        observedAt: createdAt,
      })
      db.query(
        `INSERT INTO recovery_checkpoint_commands
         (project_directory,request_id,task_id,plan_id,attempt_id,source_session_id,message_id,payload,created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        record.requestID,
        record.source.taskID,
        record.source.planID,
        record.source.attemptID,
        record.source.sessionID,
        record.messageID,
        JSON.stringify(record),
        createdAt,
      )
      db.query(
        `INSERT INTO recovery_checkpoint_delivery
         (project_directory,request_id,state,payload,created_at) VALUES(?,?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        record.requestID,
        "prepared",
        JSON.stringify(prepared),
        createdAt,
      )
      this.appendControlEvent(
        db,
        record.attemptID,
        "checkpoint-prepared",
        record.requestID,
        record,
        createdAt,
      )
      return { status: "recorded" as const, record }
    })
  }

  /** Claim the only native admission attempt. A crash after this point is deliberately not retried. */
  claimCheckpointDelivery(
    requestID: string,
    callerInput: unknown,
  ): RecoveryCheckpointRecordType | undefined {
    const caller = HandoffActor.parse(callerInput)
    return this.repository.atomic((db) => {
      const record = this.requireCheckpoint(db, requestID)
      const sourceRow = this.resolveSourceRow(db, { attemptID: record.source.attemptID })
      if (!sourceRow) throw new Error("Checkpoint source attempt no longer exists")
      const handoffSource = this.sourceFromRow(sourceRow, 1)
      this.assertArchitectOwnsPlan(db, handoffSource, caller)
      this.assertLatestRunningAttempt(db, sourceRow)
      const deliveryRow = db
        .query<RecoveryPayloadRow, [string, string]>(
          `SELECT payload FROM recovery_checkpoint_delivery WHERE project_directory=? AND request_id=?`,
        )
        .get(this.repository.projectDirectory, requestID)
      if (!deliveryRow) throw new Error("Checkpoint delivery record is missing")
      const delivery = RecoveryCheckpointDelivery.parse(JSON.parse(deliveryRow.payload))
      if (delivery.status !== "prepared") return undefined
      const unknown = RecoveryCheckpointDelivery.parse({
        ...delivery,
        status: "unknown",
        observedAt: this.timestamp(),
        detail:
          "Native admission is in progress; this request will not be resent after an uncertain outcome.",
      })
      db.query(
        `UPDATE recovery_checkpoint_delivery SET state='unknown',payload=?,created_at=?
         WHERE project_directory=? AND request_id=? AND state='prepared'`,
      ).run(
        JSON.stringify(unknown),
        unknown.observedAt,
        this.repository.projectDirectory,
        requestID,
      )
      this.appendControlEvent(
        db,
        record.source.attemptID,
        "checkpoint-admission-unknown",
        requestID,
        unknown,
        unknown.observedAt,
      )
      return record
    })
  }

  /** Recheck source ownership after native session lookup and immediately before steering. */
  assertCheckpointTarget(requestID: string, callerInput: unknown): void {
    const caller = HandoffActor.parse(callerInput)
    this.repository.atomic((db) => {
      const command = this.requireCheckpoint(db, requestID)
      const row = this.resolveSourceRow(db, { attemptID: command.source.attemptID })
      if (!row) throw new Error("Checkpoint source attempt no longer exists")
      const current = this.recoverySourceFromRow(row)
      if (canonical(current) !== canonical(command.source))
        throw new Error("Checkpoint source identity changed before native steering")
      this.assertArchitectOwnsPlan(db, this.sourceFromRow(row, 1), caller)
      this.assertLatestRunningAttempt(db, row)
    })
  }

  finishCheckpointDelivery(
    requestID: string,
    messageID: string,
    admitted: boolean,
    detail?: string,
  ): RecoveryCheckpointStateType {
    const parsedMessageID = SessionMessage.ID.make(messageID)
    return this.repository.atomic((db) => {
      const record = this.requireCheckpoint(db, requestID)
      if (record.messageID !== parsedMessageID)
        throw new Error("Checkpoint message identity does not match")
      const row = db
        .query<RecoveryPayloadRow, [string, string]>(
          `SELECT payload FROM recovery_checkpoint_delivery WHERE project_directory=? AND request_id=?`,
        )
        .get(this.repository.projectDirectory, requestID)
      if (!row) throw new Error("Checkpoint delivery record is missing")
      const current = RecoveryCheckpointDelivery.parse(JSON.parse(row.payload))
      let next = current
      if (current.status === "unknown") {
        const observedAt = this.timestamp()
        next = admitted
          ? RecoveryCheckpointDelivery.parse({
              requestID,
              status: "admitted",
              messageID: record.messageID,
              observedAt,
              ...(detail ? { detail: detail.slice(0, 500) } : {}),
            })
          : RecoveryCheckpointDelivery.parse({
              ...current,
              status: "unknown",
              observedAt,
              ...(detail ? { detail: detail.slice(0, 500) } : {}),
            })
      }
      if (canonical(next) !== canonical(current)) {
        db.query(
          `UPDATE recovery_checkpoint_delivery SET state=?,payload=?,created_at=?
           WHERE project_directory=? AND request_id=?`,
        ).run(
          next.status,
          JSON.stringify(next),
          next.observedAt,
          this.repository.projectDirectory,
          requestID,
        )
        this.appendControlEvent(
          db,
          record.source.attemptID,
          next.status === "admitted" ? "checkpoint-admitted" : "checkpoint-admission-unknown",
          `${requestID}:${next.observedAt}`,
          next,
          next.observedAt,
        )
      }
      return this.checkpointState(db, record)
    })
  }

  checkpointForWorker(
    requestID: string,
    callerInput: unknown,
  ): RecoveryCheckpointStateType | undefined {
    const caller = HandoffActor.parse(callerInput)
    return this.repository.atomic((db) => {
      const row = this.checkpointRow(db, requestID)
      if (!row) return undefined
      const record = RecoveryCheckpointRecord.parse(JSON.parse(row.payload))
      const sourceRow = this.resolveSourceRow(db, { attemptID: record.source.attemptID })
      if (!sourceRow) throw new Error("Checkpoint source attempt is no longer project-owned")
      this.assertWorkerOwnsSource(this.sourceFromRow(sourceRow, 1), caller)
      this.assertLatestRunningAttempt(db, sourceRow)
      return this.checkpointState(db, record)
    })
  }

  recordCheckpointResponse(
    input: unknown,
    callerInput: unknown,
    observedCallID: string,
  ): Receipt<RecoveryCheckpointResponseRecordType> {
    const parsed = RecoveryCheckpointResponseInput.parse(input)
    const caller = HandoffActor.parse(callerInput)
    if (caller.role !== "worker")
      throw new Error("Only the assigned worker may respond to a checkpoint")
    return this.repository.atomic((db) => {
      const command = this.requireCheckpoint(db, parsed.requestID)
      if (parsed.responseID !== observedCallID)
        throw new Error("Checkpoint response identity must match the observed native tool call")
      const sourceRow = this.resolveSourceRow(db, { attemptID: command.source.attemptID })
      if (!sourceRow) throw new Error("Checkpoint source attempt is no longer project-owned")
      const handoffSource = this.sourceFromRow(sourceRow, 1)
      this.assertWorkerOwnsSource(handoffSource, caller)
      this.assertLatestRunningAttempt(db, sourceRow)
      const existing = db
        .query<RecoveryPayloadRow, [string, string]>(
          `SELECT payload FROM recovery_checkpoint_responses WHERE project_directory=? AND request_id=?`,
        )
        .get(this.repository.projectDirectory, parsed.requestID)
      if (existing) {
        const record = RecoveryCheckpointResponseRecord.parse(JSON.parse(existing.payload))
        const same =
          canonical(this.checkpointResponseInput(record)) === canonical(parsed) &&
          record.observedCallID === observedCallID &&
          canonical(record.reportedBy) === canonical(caller)
        return same
          ? { status: "replayed" as const, record }
          : { status: "conflict" as const, message: "Checkpoint already has a different response" }
      }
      if (!observedCallID.trim())
        throw new Error("Checkpoint response must be associated with its native tool call")
      const createdAt = this.timestamp()
      const consumption = RecoveryCheckpointConsumptionRecord.parse({
        requestID: parsed.requestID,
        messageID: command.messageID,
        observedCallID,
        observedBy: caller,
        createdAt,
      })
      const response = RecoveryCheckpointResponseRecord.parse({
        ...parsed,
        source: command.source,
        observedCallID,
        reportedBy: caller,
        createdAt,
      })
      db.query(
        `INSERT INTO recovery_checkpoint_consumptions
         (project_directory,request_id,payload,created_at) VALUES(?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        parsed.requestID,
        JSON.stringify(consumption),
        createdAt,
      )
      db.query(
        `INSERT INTO recovery_checkpoint_responses
         (project_directory,request_id,response_id,payload,created_at) VALUES(?,?,?,?,?)`,
      ).run(
        this.repository.projectDirectory,
        parsed.requestID,
        parsed.responseID,
        JSON.stringify(response),
        createdAt,
      )
      this.appendControlEvent(
        db,
        command.source.attemptID,
        "checkpoint-consumed",
        `${parsed.requestID}:consumed`,
        consumption,
        createdAt,
      )
      this.appendControlEvent(
        db,
        command.source.attemptID,
        "checkpoint-responded",
        `${parsed.requestID}:responded`,
        response,
        createdAt,
      )
      return { status: "recorded" as const, record: response }
    })
  }

  checkpointStateForArchitect(
    requestID: string,
    callerInput: unknown,
  ): RecoveryCheckpointStateType | undefined {
    const caller = HandoffActor.parse(callerInput)
    return this.repository.atomic((db) => {
      const row = this.checkpointRow(db, requestID)
      if (!row) return undefined
      const command = RecoveryCheckpointRecord.parse(JSON.parse(row.payload))
      const sourceRow = this.resolveSourceRow(db, { attemptID: command.source.attemptID })
      if (!sourceRow) throw new Error("Checkpoint source attempt is no longer project-owned")
      this.assertArchitectOwnsPlan(db, this.sourceFromRow(sourceRow, 1), caller)
      return this.checkpointState(db, command)
    })
  }

  /** Permission-checked focused read for durable requests, drafts, reports and corrections. */
  readHandoff(
    input: { requestID: string; limit?: number; cursor?: string },
    callerInput: unknown,
  ):
    | {
        request: HandoffRequestRecordType
        drafts: HandoffDraftRecordType[]
        reports: HandoffReportRecordType[]
        dispositions: HandoffDispositionRecordType[]
        events: HandoffEventRecordType[]
        nextCursor: string | null
      }
    | undefined {
    const requestID = HandoffRequestInput.shape.requestID.parse(input.requestID)
    const caller = HandoffActor.parse(callerInput)
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
      const request = this.requireRequest(db, requestID)
      this.assertHandoffReader(db, request, caller)
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
      const drafts = db
        .query<RecoveryPayloadRow, [string, string, number]>(
          `SELECT payload FROM recovery_handoff_drafts
           WHERE project_directory=? AND request_id=? ORDER BY draft_version DESC LIMIT ?`,
        )
        .all(this.repository.projectDirectory, requestID, limit)
        .map((item) => HandoffDraftRecord.parse(JSON.parse(item.payload)))
      const reports = db
        .query<RecoveryPayloadRow, [string, string, number]>(
          `SELECT payload FROM recovery_handoff_reports
           WHERE project_directory=? AND request_id=? ORDER BY report_version DESC LIMIT ?`,
        )
        .all(this.repository.projectDirectory, requestID, limit)
        .map((item) => HandoffReportRecord.parse(JSON.parse(item.payload)))
      const dispositions = db
        .query<RecoveryPayloadRow, [string, string, number]>(
          `SELECT payload FROM recovery_handoff_dispositions
           WHERE project_directory=? AND request_id=? ORDER BY rowid DESC LIMIT ?`,
        )
        .all(this.repository.projectDirectory, requestID, limit)
        .map((item) => HandoffDispositionRecord.parse(JSON.parse(item.payload)))
      const nextCursor =
        rows.length > limit && visible.length
          ? Buffer.from(JSON.stringify({ requestID, before: visible.at(-1)!.sequence })).toString(
              "base64url",
            )
          : null
      return {
        request,
        drafts,
        reports,
        dispositions,
        events: visible.map((event) => this.eventRecord(event)),
        nextCursor,
      }
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

  private recoverySourceFromRow(row: SourceRow): RecoverySourceType {
    const source = this.sourceFromRow(row, 1)
    return RecoverySource.parse({
      projectDirectory: this.repository.projectDirectory,
      projectID: source.task.provenance.projectID,
      planID: source.attachment.planID,
      taskID: source.attachment.taskID,
      specRevision: source.attachment.specRevision,
      attemptID: source.attachment.attemptID,
      sessionID: source.attachment.sourceSessionID,
      workspace: source.attempt.workspace,
      workerAgent: source.attempt.policyAgent,
      ownerSessionID: source.plan.ownerSessionID,
    })
  }

  private latestConcernRow(db: Database, concernID: string): RecoveryPayloadRow | undefined {
    return (
      db
        .query<RecoveryPayloadRow, [string, string]>(
          `SELECT payload FROM recovery_concern_versions
           WHERE project_directory=? AND concern_id=? ORDER BY version DESC LIMIT 1`,
        )
        .get(this.repository.projectDirectory, concernID) ?? undefined
    )
  }

  private resolveSourceRowForConcern(db: Database, concernID: string): SourceRow | undefined {
    const latest = this.latestConcernRow(db, concernID)
    if (!latest) return undefined
    const concern = RecoveryConcernRecord.parse(JSON.parse(latest.payload))
    const row = this.resolveSourceRow(db, { attemptID: concern.source.attemptID })
    if (!row || canonical(this.recoverySourceFromRow(row)) !== canonical(concern.source))
      throw new Error("Recovery concern source is stale or no longer project-owned")
    return row
  }

  private assertRecoveryReader(
    db: Database,
    source: HandoffSourceType,
    caller: HandoffActorType,
  ): void {
    if (caller.role === "architect") this.assertArchitectOwnsPlan(db, source, caller)
    else this.assertWorkerOwnsSource(source, caller)
  }

  private assertHandoffReader(
    db: Database,
    request: HandoffRequestRecordType,
    caller: HandoffActorType,
  ): void {
    // Read access is attached to the durable source, not its latest request generation.
    // A later request must not make an already reviewed handoff disappear.
    this.assertHandoffSource(db, request)
    if (caller.role === "architect") this.assertArchitectOwnsPlan(db, request.source, caller)
    else this.assertWorkerOwnsSource(request.source, caller)
  }

  private assertLatestRunningAttempt(db: Database, row: SourceRow): void {
    if (row.attempt_state !== "running")
      throw new Error("Checkpoint controls require the source worker's admitted running attempt")
    const current = db
      .query<{ number: number | null }, [string, string]>(
        `SELECT MAX(number) AS number FROM runner_attempts WHERE plan_id=? AND task_id=?`,
      )
      .get(row.plan_id, row.node_task_id)?.number
    if (current !== row.attempt_number)
      throw new Error("Checkpoint source attempt was replaced; no request was delivered")
  }

  private appendControlEvent(
    db: Database,
    attemptID: string,
    kind: string,
    recordID: string,
    data: unknown,
    createdAt: string,
  ): void {
    const value = JsonValueSchema.parse(data)
    db.query(
      `INSERT INTO recovery_control_events
       (project_directory,attempt_id,kind,record_id,data,created_at) VALUES(?,?,?,?,?,?)`,
    ).run(
      this.repository.projectDirectory,
      attemptID,
      kind,
      recordID,
      JSON.stringify(value),
      createdAt,
    )
  }

  private checkpointRow(db: Database, requestID: string): RecoveryPayloadRow | undefined {
    return (
      db
        .query<RecoveryPayloadRow, [string, string]>(
          `SELECT payload FROM recovery_checkpoint_commands WHERE project_directory=? AND request_id=?`,
        )
        .get(this.repository.projectDirectory, requestID) ?? undefined
    )
  }

  private requireCheckpoint(db: Database, requestID: string): RecoveryCheckpointRecordType {
    const row = this.checkpointRow(db, requestID)
    if (!row) throw new Error("Recovery checkpoint request not found in this project")
    return RecoveryCheckpointRecord.parse(JSON.parse(row.payload))
  }

  private checkpointState(
    db: Database,
    command: RecoveryCheckpointRecordType,
  ): RecoveryCheckpointStateType {
    const deliveryRow = db
      .query<RecoveryPayloadRow, [string, string]>(
        `SELECT payload FROM recovery_checkpoint_delivery WHERE project_directory=? AND request_id=?`,
      )
      .get(this.repository.projectDirectory, command.requestID)
    const delivery = deliveryRow
      ? RecoveryCheckpointDelivery.parse(JSON.parse(deliveryRow.payload))
      : RecoveryCheckpointDelivery.parse({
          requestID: command.requestID,
          status: "prepared",
          messageID: command.messageID,
          observedAt: command.createdAt,
        })
    const consumptionRow = db
      .query<RecoveryPayloadRow, [string, string]>(
        `SELECT payload FROM recovery_checkpoint_consumptions WHERE project_directory=? AND request_id=?`,
      )
      .get(this.repository.projectDirectory, command.requestID)
    const responseRow = db
      .query<RecoveryPayloadRow, [string, string]>(
        `SELECT payload FROM recovery_checkpoint_responses WHERE project_directory=? AND request_id=?`,
      )
      .get(this.repository.projectDirectory, command.requestID)
    return RecoveryCheckpointState.parse({
      command,
      delivery,
      consumption: consumptionRow
        ? RecoveryCheckpointConsumptionRecord.parse(JSON.parse(consumptionRow.payload))
        : null,
      response: responseRow
        ? RecoveryCheckpointResponseRecord.parse(JSON.parse(responseRow.payload))
        : null,
    })
  }

  private recoveryDispositionInput(
    record: RecoveryDispositionRecordType,
  ): RecoveryDispositionInputType {
    return RecoveryDispositionInput.parse({
      requestID: record.requestID,
      dispositionID: record.dispositionID,
      concernID: record.concernID,
      expectedVersion: record.expectedVersion,
      decision: record.decision,
      reason: record.reason,
      evidenceBoundary: record.evidenceBoundary,
      ...(record.followUp ? { followUp: record.followUp } : {}),
    })
  }

  private checkpointResponseInput(
    record: RecoveryCheckpointResponseRecordType,
  ): RecoveryCheckpointResponseInputType {
    return RecoveryCheckpointResponseInput.parse({
      requestID: record.requestID,
      responseID: record.responseID,
      completed: record.completed,
      attempted: record.attempted,
      currentBlockers: record.currentBlockers,
      nextApproach: record.nextApproach,
      evidence: record.evidence,
    })
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
    this.assertHandoffSource(db, request)
    const generation = db
      .query<{ generation: number }, [string, string]>(
        `SELECT COALESCE(MAX(request_generation),0) AS generation
         FROM recovery_handoff_requests WHERE project_directory=? AND attempt_id=?`,
      )
      .get(this.repository.projectDirectory, request.source.attachment.attemptID)!.generation
    if (generation !== request.source.attachment.requestGeneration)
      throw new Error("Handoff request generation is stale")
  }

  private assertHandoffSource(db: Database, request: HandoffRequestRecordType): void {
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

  private findReviewFinalizationAuthorization(
    db: Database,
    input: {
      requestID: string
      draftVersion: number
      reviewID: string
      round: number
      fingerprint?: string
    },
    caller: HandoffActorType,
  ): { fingerprint: string; result: Record<string, unknown> } | undefined {
    const events = db
      .query<{ data: string }, [string, string, string, string]>(
        `SELECT data FROM recovery_handoff_events
         WHERE project_directory=? AND request_id=? AND kind=? AND record_id=?`,
      )
      .all(
        this.repository.projectDirectory,
        input.requestID,
        "review-finalization-authorized",
        this.roundKey(input.reviewID, input.round),
      )
    const matches = events.flatMap((event) => {
      const data = JsonObjectSchema.safeParse(JSON.parse(event.data))
      if (!data.success) return []
      const value = data.data
      if (
        value.requestID !== input.requestID ||
        value.draftVersion !== input.draftVersion ||
        value.reviewID !== input.reviewID ||
        value.round !== input.round ||
        typeof value.fingerprint !== "string" ||
        (input.fingerprint !== undefined && value.fingerprint !== input.fingerprint) ||
        canonical(value.authorizedBy) !== canonical(caller) ||
        (value.resultKind !== "stored" && value.resultKind !== "exhausted")
      )
        return []
      const result = JsonObjectSchema.safeParse(value.result)
      if (
        !result.success ||
        result.data.requestID !== input.requestID ||
        result.data.reviewID !== input.reviewID ||
        result.data.round !== input.round ||
        result.data.fingerprint !== value.fingerprint
      )
        return []
      return [{ fingerprint: value.fingerprint, result: result.data }]
    })
    if (!matches.length) return undefined
    const first = matches[0]!
    return matches.every((match) => canonical(match) === canonical(first)) ? first : undefined
  }

  private isExhaustedReviewResult(
    db: Database,
    review: HandoffReviewRoundRecordType,
    result: Record<string, unknown>,
  ): boolean {
    if (review.round !== REVIEW_ROUNDS) return false
    const rounds = db
      .query<ReviewRoundPayloadRow, [string, string, string]>(
        `SELECT payload FROM recovery_handoff_rounds
         WHERE project_directory=? AND request_id=? AND review_id=? ORDER BY round`,
      )
      .all(this.repository.projectDirectory, review.requestID, review.reviewID)
    if (rounds.length !== REVIEW_ROUNDS) return false

    const findings = review.checks.map((check) => ({
      ...JsonObjectSchema.parse(check.definition),
      id: check.id,
      probability: null,
      score: null,
      disposition: "limit",
    }))
    const expected = {
      status: "completed_with_concerns",
      requestID: review.requestID,
      reviewID: review.reviewID,
      version: review.checkVersion,
      round: REVIEW_ROUNDS,
      maxRounds: REVIEW_ROUNDS,
      fingerprint: result.fingerprint,
      answers: {},
      findings,
      focus: null,
      errors: [REVIEW_ROUNDS_EXHAUSTED_ERROR],
      limitation: REVIEW_ROUNDS_EXHAUSTED_LIMITATION,
      elapsedMs: null,
      usage: {
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUSD: null,
      },
      next: {
        action: "continue",
        instruction:
          "Send the draft and its unresolved concerns to the current Architect. This review does not finalize a report or establish task success.",
      },
    }
    return canonical(result) === canonical(expected)
  }

  private finalizationStatusFromResult(result: Record<string, unknown>): {
    reviewStatus: HandoffReportRecordType["reviewStatus"]
    limitation: string | null
  } {
    const status = result.status
    const limitation = typeof result.limitation === "string" ? result.limitation : null
    if (status === "completed" || status === "completed_with_concerns")
      return { reviewStatus: "reviewed", limitation }
    if (status === "disabled" || status === "unavailable") {
      if (!limitation) throw new Error("A limited review result must retain its limitation")
      return { reviewStatus: status, limitation }
    }
    throw new Error("A handoff cannot be finalized from a pending review result")
  }

  private reviewResultConcerns(result: Record<string, unknown>): string[] {
    if (!Array.isArray(result.findings)) return []
    return result.findings.flatMap((finding) => {
      if (typeof finding !== "object" || finding === null || Array.isArray(finding)) return []
      const record = finding as Record<string, unknown>
      if (
        record.disposition === "resolved" ||
        record.disposition === "not_applicable" ||
        typeof record.id !== "string" ||
        typeof record.guidance !== "string"
      )
        return []
      return [`${record.id}: ${record.guidance}`]
    })
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
      ...(record.expectedVersion !== undefined ? { expectedVersion: record.expectedVersion } : {}),
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
