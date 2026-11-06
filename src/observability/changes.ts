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

type AssociationRead = {
  revision: number
  repositoryVersion: number
  sessions: readonly string[]
}
const associationReadsKey = Symbol.for("opencode-lazers.observation-association-reads.v1")
const associationHost = globalThis as typeof globalThis & {
  [associationReadsKey]?: Map<string, AssociationRead>
}
const associationReads: Map<string, AssociationRead> = (associationHost[associationReadsKey] ??=
  new Map<string, AssociationRead>())

/** Loaded locations share a notification stack; every reader still checks its durable revision. */
function readAssociatedSessions(
  db: Database,
  projectDirectory: string,
  repositoryVersion: number,
  revision: number,
) {
  const key = JSON.stringify([db.filename, projectDirectory])
  let entry = associationReads.get(key)
  if (entry?.revision !== revision || entry.repositoryVersion !== repositoryVersion) {
    entry = {
      revision,
      repositoryVersion,
      sessions: [...associatedSessionIDs(db, projectDirectory)],
    }
    associationReads.set(key, entry)
    const captured = entry
    // Drop the shared view when this notification stack yields.
    queueMicrotask(() => {
      if (associationReads.get(key) === captured) associationReads.delete(key)
    })
  }
  return new Set(entry.sessions)
}

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
  const revision =
    db
      .query<{ revision: number }, [string]>(
        "SELECT revision FROM observation_revisions WHERE project_directory=?",
      )
      .get(projectDirectory)?.revision ?? 0

  return {
    repositoryVersion,
    sourceFingerprint: createHmac("sha256", secret).update(String(revision)).digest("hex"),
    sessionIDs: readAssociatedSessions(db, projectDirectory, repositoryVersion, revision),
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
  private scopedSessionIDs = new Set<string>()
  private readonly seenEvents = new Set<string>()
  private readonly durableSequences = new Map<string, number>()
  private readonly liveEventIDs = new Map<string, string>()
  private eventStreamConnected = false
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

  trackScopedSessions(sessionIDs: Iterable<string>) {
    this.scopedSessionIDs = new Set([...sessionIDs].slice(0, 500))
  }

  /** Return only events observed since the last radar projection; history never pulses. */
  peekLiveEvents(sessionIDs: ReadonlySet<string>) {
    return new Set(
      [...this.liveEventIDs].flatMap(([eventID, sessionID]) =>
        sessionIDs.has(sessionID) ? [eventID] : [],
      ),
    )
  }

  /** Return only events observed since the last radar projection; history never pulses. */
  takeLiveEvents(sessionIDs: ReadonlySet<string>) {
    const output = new Set<string>()
    for (const [eventID, sessionID] of this.liveEventIDs) {
      if (!sessionIDs.has(sessionID)) continue
      output.add(eventID)
      this.liveEventIDs.delete(eventID)
    }
    return output
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
    if (!this.sessionIDs.has(sessionID) && !this.scopedSessionIDs.has(sessionID)) {
      this.refreshSource()
      if (!this.sessionIDs.has(sessionID) && !this.scopedSessionIDs.has(sessionID)) return
    }

    const info = object(event)
    const id = typeof info?.id === "string" ? info.id : null
    if (id && this.seenEvents.has(id)) return
    if (id) {
      this.seenEvents.add(id)
      if (this.seenEvents.size > 4096)
        this.seenEvents.delete(this.seenEvents.values().next().value!)
    }

    const durable = object(info?.durable)
    const aggregateID = typeof durable?.aggregateID === "string" ? durable.aggregateID : null
    const sequence = typeof durable?.seq === "number" ? durable.seq : null
    if (aggregateID && sequence !== null && Number.isInteger(sequence)) {
      const previous = this.durableSequences.get(aggregateID)
      if (previous !== undefined && sequence <= previous) return
      // The native subscription filters event types. Missing sequence numbers
      // may belong to omitted events, not transport loss. Disconnects and the
      // projection's own contiguous event sequence provide real gap signals.
      this.durableSequences.set(aggregateID, sequence)
    }
    this.nativeRevision++
    this.eventStreamConnected = true
    if (id) {
      this.liveEventIDs.set(id, sessionID)
      if (this.liveEventIDs.size > 4096)
        this.liveEventIDs.delete(this.liveEventIDs.keys().next().value!)
    }
    this.emit("native", false)
  }

  streamGap() {
    this.nativeRevision++
    this.eventStreamConnected = false
    this.liveEventIDs.clear()
    this.durableSequences.clear()
    this.emit("gap", true)
  }

  get hasConnectedEventStream() {
    return this.eventStreamConnected
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
