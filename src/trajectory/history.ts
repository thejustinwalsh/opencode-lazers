import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import type {
  ObservationScope,
  ObservationScopeView,
  TrajectoryHistoryErrorReason,
} from "../observability/contract.ts"

/**
 * The cache never refuses a capture. These only decide what it forgets, and a forgotten capture
 * is recaptured on demand ("evicted" / "expired"). None was measured; each is a product choice:
 * - TTL_MS: how long a cursor stays valid (a person reading one panel).
 * - MAX_ENTRIES: captures kept at once (one per open Trajectory panel, with headroom).
 * - RETAIN_BYTES: the serialised size the cache keeps warm beyond the newest capture. LZ-200
 *   (3 attempts, ~92M tokens) projects to roughly 22 MB (1,856 progress facts at 5.6 MB in
 *   tasks.sqlite plus 768 native messages at 16.5 MB), so this holds about three such tasks.
 *   A single capture larger than this is still served; it only evicts every other entry.
 */
const TTL_MS = 5 * 60_000
const MAX_ENTRIES = 16
const RETAIN_BYTES = 64 * 1024 * 1024

type Boundary = {
  repositoryVersion: number
  sourceRevision: number
  sourceFingerprint: string
  nativeRevision: number
  eventSequence: number
  transitionSequence: number
}

export type TrajectoryHistoryIdentity = {
  projectID: string
  projectDirectory: string
  scope: ObservationScope
  taskID: string
  limit: number
}

type HistoryEntry = {
  id: string
  identity: TrajectoryHistoryIdentity
  report: TrajectoryHistoryProjection
  boundary: Boundary
  eventIDs: string[]
  capturedAt: number
  expiresAt: number
  bytes: number
}

type HistoryCursor = {
  v: 1
  id: string
  offset: number
  expiresAt: number
  binding: string
}

export type TrajectoryHistoryPage = {
  schemaVersion: 1
  projectID: string
  scope: ObservationScopeView
  boundary: Boundary
  capturedAt: number
  expiresAt: number
  eventIDs?: string[]
  report: TrajectoryHistoryProjection
}

export type TrajectoryHistoryProjection = Record<string, unknown> & {
  trajectory: Record<string, unknown> & {
    page: number
    limit: number
    totalEvents: number
    events: unknown[]
    nextCursor: string | null
    hasMore: boolean
  }
}

const historyFailureMessage = {
  expired: "Trajectory history expired; recapture explicitly",
  evicted: "Trajectory history expired or was evicted; recapture explicitly",
  "invalid-cursor": "Invalid or stale trajectory history cursor; recapture explicitly",
} satisfies Record<TrajectoryHistoryErrorReason, string>

export class TrajectoryHistoryUnavailableError extends Error {
  constructor(readonly reason: TrajectoryHistoryErrorReason) {
    super(historyFailureMessage[reason])
    this.name = "TrajectoryHistoryUnavailableError"
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function identityKey(identity: TrajectoryHistoryIdentity) {
  return JSON.stringify([
    identity.projectID,
    identity.projectDirectory,
    identity.scope.kind,
    identity.scope.sessionID,
    identity.taskID,
    identity.limit,
  ])
}

function identityBinding(secret: Uint8Array, identity: TrajectoryHistoryIdentity) {
  return createHmac("sha256", secret).update(identityKey(identity)).digest("hex")
}

function viewScope(scope: ObservationScope): ObservationScopeView {
  return scope.kind === "session"
    ? { kind: "session", sessionID: scope.sessionID }
    : { kind: "project" }
}

/** Holds only the sanitized report projection, never native session context. */
export class TrajectoryHistoryCache {
  private readonly entries = new Map<string, HistoryEntry>()
  private bytes = 0

  constructor(
    private readonly secret: Uint8Array,
    private readonly limits = {
      ttlMs: TTL_MS,
      maxEntries: MAX_ENTRIES,
      maxBytes: RETAIN_BYTES,
    },
  ) {}

  capture(
    identity: TrajectoryHistoryIdentity,
    report: TrajectoryHistoryProjection,
    boundary: Boundary,
    now = Date.now(),
  ): TrajectoryHistoryPage {
    this.sweep(now)
    const trajectory = object(report.trajectory)
    const events = trajectory?.events
    if (!Array.isArray(events)) throw new Error("Trajectory history has no event list")
    const eventIDs = events.flatMap((event) => {
      const id = object(event)?.id
      return typeof id === "string" ? [id] : []
    })
    if (eventIDs.length !== events.length || new Set(eventIDs).size !== eventIDs.length)
      throw new Error("Trajectory history contains invalid event identities")

    const safeReport = structuredClone(report)
    const safeBoundary = structuredClone(boundary)
    const bytes = Buffer.byteLength(
      JSON.stringify({ report: safeReport, boundary: safeBoundary, eventIDs }),
      "utf8",
    )

    const entry: HistoryEntry = {
      id: randomUUID(),
      identity: structuredClone(identity),
      report: safeReport,
      boundary: safeBoundary,
      eventIDs,
      capturedAt: now,
      expiresAt: now + this.limits.ttlMs,
      bytes,
    }
    // Eviction only: a capture of any size is admitted, older ones make room for it.
    while (
      this.entries.size > 0 &&
      (this.entries.size >= this.limits.maxEntries ||
        this.bytes + entry.bytes > this.limits.maxBytes)
    )
      this.evictOldest()
    this.entries.set(entry.id, entry)
    this.bytes += entry.bytes
    return this.page(entry, 0, true)
  }

  continue(
    identity: TrajectoryHistoryIdentity,
    cursor: string,
    now = Date.now(),
  ): TrajectoryHistoryPage {
    const parsed = this.readCursor(cursor)
    if (parsed.binding !== identityBinding(this.secret, identity))
      throw new TrajectoryHistoryUnavailableError("invalid-cursor")
    if (parsed.expiresAt <= now) {
      this.remove(parsed.id)
      throw new TrajectoryHistoryUnavailableError("expired")
    }

    const entry = this.entries.get(parsed.id)
    if (!entry || entry.expiresAt <= now) {
      if (entry) this.remove(entry.id)
      throw new TrajectoryHistoryUnavailableError(entry ? "expired" : "evicted")
    }
    if (
      entry.expiresAt !== parsed.expiresAt ||
      identityKey(entry.identity) !== identityKey(identity) ||
      parsed.offset < identity.limit ||
      parsed.offset >= entry.eventIDs.length
    )
      throw new TrajectoryHistoryUnavailableError("invalid-cursor")
    return this.page(entry, parsed.offset, false)
  }

  private page(
    entry: HistoryEntry,
    offset: number,
    includeEventIDs: boolean,
  ): TrajectoryHistoryPage {
    const report = structuredClone(entry.report)
    const trajectory = object(report.trajectory)
    const events = trajectory?.events
    if (!trajectory || !Array.isArray(events))
      throw new Error("Cached trajectory history is invalid")
    const pageEvents = events.slice(offset, offset + entry.identity.limit)
    const nextOffset = offset + pageEvents.length
    const nextCursor =
      nextOffset < events.length
        ? this.makeCursor({
            v: 1,
            id: entry.id,
            offset: nextOffset,
            expiresAt: entry.expiresAt,
            binding: identityBinding(this.secret, entry.identity),
          })
        : null
    return {
      schemaVersion: 1,
      projectID: entry.identity.projectID,
      scope: viewScope(entry.identity.scope),
      boundary: structuredClone(entry.boundary),
      capturedAt: entry.capturedAt,
      expiresAt: entry.expiresAt,
      ...(includeEventIDs ? { eventIDs: [...entry.eventIDs] } : {}),
      report: {
        ...report,
        trajectory: {
          ...trajectory,
          page: Math.floor(offset / entry.identity.limit) + 1,
          limit: entry.identity.limit,
          totalEvents: events.length,
          events: pageEvents,
          nextCursor,
          hasMore: nextCursor !== null,
        },
      },
    }
  }

  private makeCursor(cursor: HistoryCursor) {
    const body = Buffer.from(JSON.stringify(cursor)).toString("base64url")
    const signature = createHmac("sha256", this.secret).update(body).digest("base64url")
    return `${body}.${signature}`
  }

  private readCursor(cursor: string): HistoryCursor {
    const invalid = () => new TrajectoryHistoryUnavailableError("invalid-cursor")
    if (cursor.length > 4096) throw invalid()
    const [body, signature, extra] = cursor.split(".")
    if (!body || !signature || extra !== undefined) throw invalid()
    const expected = createHmac("sha256", this.secret).update(body).digest("base64url")
    const providedBytes = Buffer.from(signature)
    const expectedBytes = Buffer.from(expected)
    if (
      providedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(providedBytes, expectedBytes)
    )
      throw invalid()
    try {
      const parsed = object(JSON.parse(Buffer.from(body, "base64url").toString("utf8")))
      if (
        !parsed ||
        parsed.v !== 1 ||
        typeof parsed.id !== "string" ||
        !Number.isInteger(parsed.offset) ||
        (parsed.offset as number) < 0 ||
        !Number.isFinite(parsed.expiresAt) ||
        typeof parsed.binding !== "string" ||
        !/^[a-f0-9]{64}$/.test(parsed.binding)
      )
        throw invalid()
      return parsed as unknown as HistoryCursor
    } catch {
      throw invalid()
    }
  }

  private sweep(now: number) {
    for (const entry of this.entries.values()) if (entry.expiresAt <= now) this.remove(entry.id)
  }

  private evictOldest() {
    const first = this.entries.keys().next().value as string | undefined
    if (first) this.remove(first)
  }

  private remove(id: string) {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    this.bytes -= entry.bytes
  }
}
