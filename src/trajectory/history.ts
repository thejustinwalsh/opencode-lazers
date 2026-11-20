import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import type {
  ObservationScope,
  ObservationScopeView,
  TrajectoryHistoryErrorReason,
} from "../observability/contract.ts"

/**
 * A memory-budgeted LRU. It never refuses a read: older captures are evicted, least recently
 * used first, to make room, and a capture larger than the whole budget is served in one page
 * without being cached. A forgotten capture is recaptured on demand ("evicted" / "expired").
 * - TTL_MS: how long a cursor stays valid; a product choice (a person reading one panel), not
 *   measured.
 * - DEFAULT_HISTORY_CACHE_MB: the `historyCacheMB` plugin option's default. Measured on the
 *   owner's live data: the largest task (LZ-200, 3 attempts, ~92M tokens) projects to about
 *   22 MB (5.6 MB of progress facts in tasks.sqlite plus 16.5 MB of native session messages
 *   in opencode.db; the next largest has 11 MB of progress facts). 128 MB keeps about five of
 *   those warm.
 */
const TTL_MS = 5 * 60_000
export const DEFAULT_HISTORY_CACHE_MB = 128

/** The `historyCacheMB` plugin option in bytes; anything but a positive number is the default. */
export function historyCacheBytes(option: unknown): number {
  const megabytes =
    typeof option === "number" && Number.isFinite(option) && option > 0
      ? option
      : DEFAULT_HISTORY_CACHE_MB
  return Math.floor(megabytes * 1024 * 1024)
}

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

/**
 * One capture, stored serialized once: each event is its own JSON string and the report
 * without its events is another. A page parses only the events it returns, so a read never
 * clones or restringifies the whole capture, and `bytes` is the sum of the string sizes
 * counted once at capture.
 */
type HistoryEntry = {
  id: string
  identity: TrajectoryHistoryIdentity
  /** The report with `trajectory.events` removed, serialized. */
  rest: string
  events: string[]
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

  private readonly limits: { ttlMs: number; maxBytes: number }

  constructor(
    private readonly secret: Uint8Array,
    limits: { ttlMs?: number; maxBytes?: number } = {},
  ) {
    this.limits = {
      ttlMs: limits.ttlMs ?? TTL_MS,
      maxBytes: limits.maxBytes ?? historyCacheBytes(undefined),
    }
  }

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

    const serializedEvents = events.map((event) => JSON.stringify(event))
    const rest = JSON.stringify({ ...report, trajectory: { ...trajectory, events: [] } })
    const safeBoundary: Boundary = { ...boundary }
    let bytes = Buffer.byteLength(rest) + Buffer.byteLength(JSON.stringify(safeBoundary))
    for (const [index, value] of serializedEvents.entries())
      bytes += Buffer.byteLength(value) + Buffer.byteLength(eventIDs[index]!)

    const entry: HistoryEntry = {
      id: randomUUID(),
      identity: { ...identity, scope: { ...identity.scope } },
      rest,
      events: serializedEvents,
      boundary: safeBoundary,
      eventIDs,
      capturedAt: now,
      expiresAt: now + this.limits.ttlMs,
      bytes,
    }
    // Larger than the whole budget: serve every event in one page and keep nothing.
    if (entry.bytes > this.limits.maxBytes) return this.page(entry, 0, true, true, events)
    // Least recently used first (the map is in recency order; `continue` refreshes it).
    while (this.entries.size > 0 && this.bytes + entry.bytes > this.limits.maxBytes)
      this.evictOldest()
    this.entries.set(entry.id, entry)
    this.bytes += entry.bytes
    // The caller's own objects are the first page; the cache holds only the strings.
    return this.page(entry, 0, true, false, events)
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
      parsed.offset >= entry.events.length
    )
      throw new TrajectoryHistoryUnavailableError("invalid-cursor")
    this.entries.delete(entry.id)
    this.entries.set(entry.id, entry)
    return this.page(entry, parsed.offset, false)
  }

  /** Raise or lower the byte budget; shrinking evicts least recently used captures at once. */
  setMaxBytes(maxBytes: number) {
    this.limits.maxBytes = maxBytes
    while (this.entries.size > 0 && this.bytes > maxBytes) this.evictOldest()
  }

  /** Bytes held now; exposed for measurement. */
  get size() {
    return this.bytes
  }

  private page(
    entry: HistoryEntry,
    offset: number,
    includeEventIDs: boolean,
    whole = false,
    original?: readonly unknown[],
  ): TrajectoryHistoryPage {
    const report = JSON.parse(entry.rest) as TrajectoryHistoryProjection
    const trajectory = object(report.trajectory)
    if (!trajectory) throw new Error("Cached trajectory history is invalid")
    const total = entry.events.length
    const size = whole ? Math.max(total, entry.identity.limit) : entry.identity.limit
    const end = Math.min(total, offset + size)
    const pageEvents: unknown[] = original
      ? original.slice(offset, end)
      : entry.events.slice(offset, end).map((value) => JSON.parse(value) as unknown)
    const nextOffset = offset + pageEvents.length
    const nextCursor =
      nextOffset < total
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
      boundary: { ...entry.boundary },
      capturedAt: entry.capturedAt,
      expiresAt: entry.expiresAt,
      ...(includeEventIDs ? { eventIDs: [...entry.eventIDs] } : {}),
      report: {
        ...report,
        trajectory: {
          ...trajectory,
          page: Math.floor(offset / size) + 1,
          limit: size,
          totalEvents: total,
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
