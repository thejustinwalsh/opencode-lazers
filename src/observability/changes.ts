import { createHmac } from "node:crypto"
import type { Database } from "bun:sqlite"
import type { TaskRepository } from "../storage.ts"
import { openReadOnlyTrajectoryStore } from "../trajectory/store.ts"
import { associatedSessionIDs } from "./associations.ts"
import type { ObservationChange } from "./contract.ts"

export type SourceStamp = {
  repositoryVersion: number
  sourceFingerprint: string
  sessionIDs: Set<string>
}

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

/** A keyed source fingerprint detects runner/check/tool changes not reflected in the task watermark. */
export function sourceStampFromDatabase(
  db: Database,
  projectDirectory: string,
  secret: Uint8Array,
): SourceStamp {
  const repositoryVersion = db
    .query<{ version: number }, [string]>(
      "SELECT COALESCE(MAX(id),0) AS version FROM task_changes WHERE project_directory=?",
    )
    .get(projectDirectory)!.version
  const source = {
    tasks: db
      .query("SELECT id,created_version,body FROM tasks WHERE project_directory=? ORDER BY rowid")
      .all(projectDirectory),
    dispositions: db
      .query(
        "SELECT task_id,payload,disposition,reason FROM task_dispositions WHERE project_directory=? ORDER BY id",
      )
      .all(projectDirectory),
    plans: db
      .query(
        "SELECT id,owner,revision,version,state,body,reason,artifact FROM runner_plans WHERE project_directory=? ORDER BY rowid",
      )
      .all(projectDirectory),
    nodes: db
      .query(
        "SELECT n.plan_id,n.task_id,n.ordinal,n.state,n.version,n.reason,n.artifact,n.snapshot,n.machine_version FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id WHERE p.project_directory=? ORDER BY p.rowid,n.ordinal",
      )
      .all(projectDirectory),
    dependencies: db
      .query(
        "SELECT d.plan_id,d.prerequisite,d.successor FROM runner_dependencies d JOIN runner_plans p ON p.id=d.plan_id WHERE p.project_directory=? ORDER BY d.plan_id,d.prerequisite,d.successor",
      )
      .all(projectDirectory),
    attempts: db
      .query(
        "SELECT a.id,a.plan_id,a.task_id,a.number,a.session_id,a.state,a.started_at,a.token_count,a.tool_count,a.retry_count,a.cost,a.artifact,a.policy FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id WHERE p.project_directory=? ORDER BY a.started_at,a.number",
      )
      .all(projectDirectory),
    effects: db
      .query(
        "SELECT e.id,e.plan_id,e.task_id,e.attempt_id,e.kind,e.state,e.receipt,e.fence FROM runner_effects e JOIN runner_plans p ON p.id=e.plan_id WHERE p.project_directory=? ORDER BY e.rowid",
      )
      .all(projectDirectory),
    transitions: db
      .query(
        "SELECT t.id,t.plan_id,t.task_id,t.version,t.event,t.payload,t.created_at FROM runner_transitions t JOIN runner_plans p ON p.id=t.plan_id WHERE p.project_directory=? ORDER BY t.id",
      )
      .all(projectDirectory),
  }
  return {
    repositoryVersion,
    sourceFingerprint: createHmac("sha256", secret).update(JSON.stringify(source)).digest("hex"),
    sessionIDs: associatedSessionIDs(db, projectDirectory),
  }
}

export function readSourceStamp(
  path: string,
  projectDirectory: string,
  secret: Uint8Array,
): SourceStamp {
  const connection = openReadOnlyTrajectoryStore(path, projectDirectory)
  try {
    return connection.store.atomic((db) => sourceStampFromDatabase(db, projectDirectory, secret))
  } finally {
    connection.close()
  }
}

export class ObservationChangeTracker {
  sequence = 0
  sourceRevision = 0
  nativeRevision = 0
  private repositoryVersion = 0
  private sourceFingerprint = ""
  private sessionIDs = new Set<string>()
  private readonly seenEvents = new Set<string>()
  private readonly durableSequences = new Map<string, number>()
  private publish?: (change: ObservationChange) => void

  constructor(
    readonly repository: TaskRepository,
    private readonly secret: Uint8Array,
    private readonly projectID: string,
  ) {}

  initialize(publish?: (change: ObservationChange) => void) {
    this.publish = publish
    const stamp = readSourceStamp(
      this.repository.path,
      this.repository.projectDirectory,
      this.secret,
    )
    this.repositoryVersion = stamp.repositoryVersion
    this.sourceFingerprint = stamp.sourceFingerprint
    this.sessionIDs = stamp.sessionIDs
  }

  boundary(stamp: SourceStamp, transitionSequence: number) {
    this.observeStamp(stamp)
    return {
      repositoryVersion: stamp.repositoryVersion,
      sourceRevision: this.sourceRevision,
      sourceFingerprint: stamp.sourceFingerprint,
      nativeRevision: this.nativeRevision,
      eventSequence: this.sequence,
      transitionSequence,
    }
  }

  refreshSource() {
    this.observeStamp(
      readSourceStamp(this.repository.path, this.repository.projectDirectory, this.secret),
    )
  }

  observeStamp(stamp: SourceStamp) {
    const changed =
      this.repositoryVersion !== stamp.repositoryVersion ||
      this.sourceFingerprint !== stamp.sourceFingerprint
    this.repositoryVersion = stamp.repositoryVersion
    this.sourceFingerprint = stamp.sourceFingerprint
    this.sessionIDs = stamp.sessionIDs
    if (changed) {
      this.sourceRevision++
      this.emit("runner", false)
    }
  }

  native(event: unknown) {
    const data = object(object(event)?.data)
    const sessionID = typeof data?.sessionID === "string" ? data.sessionID : null
    if (!sessionID) return
    if (!this.sessionIDs.has(sessionID)) {
      this.refreshSource()
      if (!this.sessionIDs.has(sessionID)) return
    }

    const info = object(event)
    const id = typeof info?.id === "string" ? info.id : null
    if (id && this.seenEvents.has(id)) return
    if (id) {
      this.seenEvents.add(id)
      if (this.seenEvents.size > 4096) this.seenEvents.clear()
    }

    const durable = object(info?.durable)
    const aggregateID = typeof durable?.aggregateID === "string" ? durable.aggregateID : null
    const sequence = typeof durable?.seq === "number" ? durable.seq : null
    let gap = false
    if (aggregateID && sequence !== null && Number.isInteger(sequence)) {
      const previous = this.durableSequences.get(aggregateID)
      if (previous !== undefined && sequence <= previous) return
      gap = previous !== undefined && sequence !== previous + 1
      this.durableSequences.set(aggregateID, sequence)
    }
    this.nativeRevision++
    this.emit(gap ? "gap" : "native", gap)
  }

  streamGap() {
    this.nativeRevision++
    this.durableSequences.clear()
    this.emit("gap", true)
  }

  private emit(cause: ObservationChange["cause"], resnapshotRequired: boolean) {
    this.sequence++
    this.publish?.({
      projectID: this.projectID,
      sequence: this.sequence,
      repositoryVersion: this.repositoryVersion,
      sourceRevision: this.sourceRevision,
      nativeRevision: this.nativeRevision,
      cause,
      resnapshotRequired,
    })
  }
}
