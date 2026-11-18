import { section } from "../diagnostics/stall-probe.ts"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import type { Database } from "bun:sqlite"
import type { TaskRepository } from "../storage.ts"
import { openReadOnlyTrajectoryStore } from "../trajectory/store.ts"
import { privacyStats, safeText } from "../trajectory/privacy.ts"
import { associationIndex } from "./associations.ts"
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

const sourceFingerprintSecretKey = Symbol.for(
  "opencode-lazers.observation-source-fingerprint-key.v1",
)
const sourceFingerprintHost = globalThis as typeof globalThis & {
  [sourceFingerprintSecretKey]?: Uint8Array
}
/** Per-process key keeps source identity opaque while making it stable across location secrets. */
const sourceFingerprintSecret = (sourceFingerprintHost[sourceFingerprintSecretKey] ??=
  randomBytes(32))

/** Loaded locations share membership reads only for the same durable revision and sync batch. */
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
      sessions: [...associationIndex.read(db, projectDirectory)],
    }
    associationReads.set(key, entry)
    // Keyed by durable revision (every membership write bumps it), so the shared view
    // stays valid across the debounce window instead of being dropped when the stack yields.
  }
  return new Set(entry.sessions)
}

const realpathMemo = new Map<string, string>()
function canonicalDatabasePath(filename: string) {
  let resolved = realpathMemo.get(filename)
  if (resolved === undefined) {
    resolved = realpathSync(filename)
    realpathMemo.set(filename, resolved)
    if (realpathMemo.size > 64) realpathMemo.delete(realpathMemo.keys().next().value!)
  }
  return resolved
}

/** A keyed source fingerprint detects runner/check/tool changes not reflected in the task watermark. */
export function sourceStampFromDatabase(
  db: Database,
  projectDirectory: string,
  _readerSecret: Uint8Array,
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
    sourceFingerprint: createHmac("sha256", sourceFingerprintSecret)
      .update(JSON.stringify([canonicalDatabasePath(db.filename), projectDirectory, revision]))
      .digest("hex"),
    sessionIDs: readAssociatedSessions(db, projectDirectory, repositoryVersion, revision),
  }
}

type SourceConnection = {
  identity: string
  connection: ReturnType<typeof openReadOnlyTrajectoryStore>
}
const sourceConnectionsKey = Symbol.for("opencode-lazers.observation-source-connections.v1")
const sourceConnectionsHost = globalThis as typeof globalThis & {
  [sourceConnectionsKey]?: Map<string, SourceConnection>
}
const sourceConnections: Map<string, SourceConnection> = (sourceConnectionsHost[
  sourceConnectionsKey
] ??= new Map())

function fileIdentity(path: string) {
  const stat = statSync(path)
  return `${stat.dev}:${stat.ino}`
}

/** Close pooled source-stamp connections (tests and shutdown). */
export function closeSourceStampConnections() {
  for (const [key, entry] of sourceConnections) {
    sourceConnections.delete(key)
    try {
      entry.connection.close()
    } catch {
      // Already closed.
    }
  }
}

/** One lazily opened read-only connection per database file replaces open-per-call. */
export function readSourceStamp(
  path: string,
  projectDirectory: string,
  secret: Uint8Array,
): SourceStamp {
  const key = JSON.stringify([path, projectDirectory])
  const identity = fileIdentity(path)
  let entry = sourceConnections.get(key)
  if (entry && entry.identity !== identity) {
    sourceConnections.delete(key)
    try {
      entry.connection.close()
    } catch {
      // Replaced file: the old handle is dead anyway.
    }
    entry = undefined
  }
  if (!entry) {
    entry = { identity, connection: openReadOnlyTrajectoryStore(path, projectDirectory) }
    sourceConnections.set(key, entry)
  }
  try {
    return entry.connection.store.atomic((db) =>
      sourceStampFromDatabase(db, projectDirectory, secret),
    )
  } catch (error) {
    // A broken pooled handle must not poison later reads.
    sourceConnections.delete(key)
    try {
      entry.connection.close()
    } catch {
      // Ignore close failures.
    }
    throw error
  }
}

type NativeFact = {
  sessionID: string
  eventID: string | null
  aggregateID: string | null
  durableSequence: number | null
  signal: Omit<NativeSignal, "sourceNativeRevision"> | null
}

export type NativeSignal = {
  sessionID: string
  eventID: string
  eventType: string
  sourceNativeRevision: number
  messageID: string | null
  callID: string | null
  tool: string | null
  agent: string | null
  providerID: string | null
  modelID: string | null
  variant: string | null
  status: string
  observedAt: number
}

type TrackerState = {
  projectID: string
  sequence: number
  sourceRevision: number
  nativeRevision: number
  repositoryVersion: number
  sourceFingerprint: string
  sessionIDs: Set<string>
  seenEvents: Set<string>
  durableSequences: Map<string, number>
  eventStreamConnected: boolean
  gapActive: boolean
  streamEpoch: string
  members: Set<ObservationChangeTracker>
  publishers: Map<ObservationChangeTracker, (change: ObservationChange) => void>
  pendingNative: NativeFact[]
  pendingNativeKeys: Set<string>
  pendingOverflow: boolean
  liveSignals: Map<string, NativeSignal>
  liveSignalBytes: number
  liveSignalsTruncated: boolean
  registryKey?: string
  lastRefreshAt: number
  refreshTimer?: ReturnType<typeof setTimeout>
}

/** Minimum spacing between synchronous source reads triggered by events or invalidations. */
export const SOURCE_REFRESH_DEBOUNCE_MS = 250

const MAX_TRACKED_EVENTS = 4096
export const LIVE_SIGNAL_LIMITS = {
  flowEntries: 256,
  retainedBytes: 256_000,
  truncatedSessions: 500,
} as const
const NATIVE_SIGNAL_STATUS: Record<string, string> = {
  "session.execution.started": "execution-started",
  "session.execution.succeeded": "execution-succeeded",
  "session.execution.failed": "execution-failed",
  "session.execution.interrupted": "execution-interrupted",
  "session.step.started": "request-started",
  "session.step.streamed": "response-streamed",
  "session.step.ended": "response-ended",
  "session.step.failed": "response-failed",
  "session.text.ended": "text-ended",
  "session.tool.called": "called",
  "session.tool.input.started": "input-started",
  "session.tool.progress": "running",
  "session.tool.success": "succeeded",
  "session.tool.failed": "failed",
}
const NATIVE_TOOL_EVENT_TYPES = new Set([
  "session.tool.called",
  "session.tool.input.started",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
])
const projectStatesKey = Symbol.for("opencode-lazers.observation-project-states.v1")
const projectStatesHost = globalThis as typeof globalThis & {
  [projectStatesKey]?: Map<string, TrackerState>
}
const projectStates: Map<string, TrackerState> = (projectStatesHost[projectStatesKey] ??= new Map<
  string,
  TrackerState
>())

function newState(projectID: string): TrackerState {
  return {
    projectID,
    sequence: 0,
    sourceRevision: 0,
    nativeRevision: 0,
    repositoryVersion: 0,
    sourceFingerprint: "",
    sessionIDs: new Set(),
    seenEvents: new Set(),
    durableSequences: new Map(),
    eventStreamConnected: false,
    gapActive: false,
    streamEpoch: randomUUID(),
    members: new Set(),
    publishers: new Map(),
    pendingNative: [],
    pendingNativeKeys: new Set(),
    pendingOverflow: false,
    liveSignals: new Map(),
    liveSignalBytes: 0,
    liveSignalsTruncated: false,
    lastRefreshAt: 0,
  }
}

function rememberBounded<T>(set: Set<T>, value: T) {
  set.add(value)
  if (set.size > MAX_TRACKED_EVENTS) set.delete(set.values().next().value!)
}

function safeSignalText(value: unknown, maximum: number) {
  if (typeof value !== "string" || !value || value.length > maximum) return null
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return null
  }
  const safe = safeText(value, privacyStats(), maximum)
  return safe === value ? safe : null
}

function nativeSignal(
  info: JsonObject | null,
  data: JsonObject | null,
  sessionID: string,
  eventID: string | null,
): Omit<NativeSignal, "sourceNativeRevision"> | null {
  const eventType = typeof info?.type === "string" ? info.type : ""
  const status = Object.hasOwn(NATIVE_SIGNAL_STATUS, eventType)
    ? NATIVE_SIGNAL_STATUS[eventType]
    : null
  const safeEventID = safeSignalText(eventID, 200)
  const observedAt = info?.created
  if (
    typeof status !== "string" ||
    !safeEventID ||
    typeof observedAt !== "number" ||
    !Number.isFinite(observedAt)
  )
    return null

  const model = eventType === "session.step.started" ? object(data?.model) : null
  const messageID = safeSignalText(data?.assistantMessageID, 200)
  const toolEvent = NATIVE_TOOL_EVENT_TYPES.has(eventType)
  const callID = toolEvent ? safeSignalText(data?.id, 200) : null
  const tool = eventType === "session.tool.input.started" ? safeSignalText(data?.name, 160) : null
  const providerID = model ? safeSignalText(model.providerID, 200) : null
  const modelID = model ? safeSignalText(model.id, 300) : null
  const variant = model ? safeSignalText(model.variant, 200) : null
  return {
    sessionID,
    eventID: safeEventID,
    eventType,
    messageID,
    callID,
    tool,
    agent: eventType === "session.step.started" ? safeSignalText(data?.agent, 200) : null,
    providerID,
    modelID,
    variant,
    status:
      eventType === "session.tool.called" && data?.executed === false ? "not-executed" : status,
    observedAt,
  }
}

function nativeFact(event: unknown): NativeFact | null {
  const info = object(event)
  const data = object(info?.data)
  const sessionID = typeof data?.sessionID === "string" ? data.sessionID : null
  if (!sessionID || sessionID.length > 200) return null
  const durable = object(info?.durable)
  const aggregateID =
    typeof durable?.aggregateID === "string" && durable.aggregateID.length <= 200
      ? durable.aggregateID
      : null
  const eventID = typeof info?.id === "string" && info.id.length <= 200 ? info.id : null
  return {
    sessionID,
    eventID,
    aggregateID,
    durableSequence:
      typeof durable?.seq === "number" && Number.isSafeInteger(durable.seq) ? durable.seq : null,
    signal: nativeSignal(info, data, sessionID, eventID),
  }
}

function pendingKey(fact: NativeFact) {
  if (fact.eventID) return `id:${fact.eventID}`
  if (fact.aggregateID && fact.durableSequence !== null)
    return `seq:${fact.aggregateID}:${fact.durableSequence}`
  return null
}

function liveSignalKey(signal: NativeSignal) {
  return JSON.stringify([signal.sessionID, signal.eventID])
}

function liveSignalBytes(signal: NativeSignal) {
  return new TextEncoder().encode(JSON.stringify(signal)).byteLength
}

function pendingScopeSelection(state: TrackerState) {
  for (const member of state.members) if (member.hasPendingScopeSelection()) return true
  return false
}

function hasScopedInterest(state: TrackerState, sessionID: string) {
  for (const member of state.members) if (member.hasScopedSession(sessionID)) return true
  return false
}

function hasInterest(state: TrackerState, sessionID: string) {
  return state.sessionIDs.has(sessionID) || hasScopedInterest(state, sessionID)
}

function emit(state: TrackerState, cause: ObservationChange["cause"], resnapshotRequired: boolean) {
  state.sequence++
  const change: ObservationChange = {
    projectID: state.projectID,
    sequence: state.sequence,
    repositoryVersion: state.repositoryVersion,
    sourceRevision: state.sourceRevision,
    nativeRevision: state.nativeRevision,
    cause,
    resnapshotRequired,
  }
  state.publishers.values().next().value?.(change)
}

function applyNative(state: TrackerState, fact: NativeFact) {
  if (fact.eventID && state.seenEvents.has(fact.eventID)) return
  if (fact.eventID) rememberBounded(state.seenEvents, fact.eventID)
  if (fact.aggregateID && fact.durableSequence !== null) {
    const previous = state.durableSequences.get(fact.aggregateID)
    if (previous !== undefined && fact.durableSequence <= previous) return
    state.durableSequences.delete(fact.aggregateID)
    state.durableSequences.set(fact.aggregateID, fact.durableSequence)
    if (state.durableSequences.size > MAX_TRACKED_EVENTS)
      state.durableSequences.delete(state.durableSequences.keys().next().value!)
  }

  state.nativeRevision++
  state.eventStreamConnected = true
  state.gapActive = false
  if (fact.eventID)
    for (const member of state.members)
      if (state.sessionIDs.has(fact.sessionID) || member.hasScopedSession(fact.sessionID)) {
        member.recordLiveEvent(fact.eventID, fact.sessionID)
        if (fact.signal)
          member.recordLiveSignal({ ...fact.signal, sourceNativeRevision: state.nativeRevision })
      }
  emit(state, "native", false)
}

function streamGap(state: TrackerState, forceResnapshot = false) {
  if (state.gapActive && !forceResnapshot) return
  state.nativeRevision++
  state.eventStreamConnected = false
  state.gapActive = true
  state.streamEpoch = randomUUID()
  state.pendingNative = []
  state.pendingNativeKeys.clear()
  state.pendingOverflow = false
  state.durableSequences.clear()
  for (const member of state.members) member.clearLiveEvents()
  emit(state, "gap", true)
}

function bufferNative(state: TrackerState, fact: NativeFact) {
  const key = pendingKey(fact)
  if (key && state.pendingNativeKeys.has(key)) return
  if (state.pendingNative.length >= MAX_TRACKED_EVENTS) {
    state.pendingOverflow = true
    return
  }
  if (key) state.pendingNativeKeys.add(key)
  state.pendingNative.push(fact)
}

function drainPending(state: TrackerState) {
  const pending = state.pendingNative
  state.pendingNative = []
  state.pendingNativeKeys.clear()
  for (const fact of pending) {
    if (fact.eventID && state.seenEvents.has(fact.eventID)) continue
    if (hasInterest(state, fact.sessionID)) applyNative(state, fact)
    else if (pendingScopeSelection(state)) bufferNative(state, fact)
    else if (fact.eventID) rememberBounded(state.seenEvents, fact.eventID)
  }
  if (!pendingScopeSelection(state) && state.pendingOverflow) streamGap(state)
}

/** One project/source sequence with private session interests and event cursors per reader. */
export class ObservationChangeTracker {
  private state: TrackerState
  private scopedSessionIDs = new Set<string>()
  private readonly liveEventIDs = new Map<string, string>()
  private readonly liveSignals = new Map<string, { signal: NativeSignal; bytes: number }>()
  private liveSignalBytes = 0
  private readonly liveSignalTruncatedSessionIDs = new Set<string>()
  private liveSignalTruncationUnknown = false
  private preferredLiveSessionID: string | null = null
  private scopeSelectionReads = 0

  constructor(
    readonly repository: TaskRepository,
    private readonly secret: Uint8Array,
    private readonly projectID: string,
  ) {
    this.state = newState(projectID)
    this.state.members.add(this)
  }

  get sequence() {
    return this.state.sequence
  }

  get sourceRevision() {
    return this.state.sourceRevision
  }

  get nativeRevision() {
    return this.state.nativeRevision
  }

  get streamEpoch() {
    return this.state.streamEpoch
  }

  initialize(publish?: (change: ObservationChange) => void) {
    section("changes:initialize", () => this.initializeTracker(publish))
  }

  private initializeTracker(publish?: (change: ObservationChange) => void) {
    if (publish) {
      const key = JSON.stringify([
        realpathSync(this.repository.path),
        this.repository.projectDirectory,
        this.projectID,
      ])
      this.state.members.delete(this)
      const existing = projectStates.get(key)
      if (existing) this.state = existing
      else {
        this.state = newState(this.projectID)
        this.state.registryKey = key
        projectStates.set(key, this.state)
        try {
          this.initializeState()
        } catch (error) {
          projectStates.delete(key)
          throw error
        }
      }
      this.state.members.add(this)
      this.state.publishers.set(this, publish)
      return
    }
    this.initializeState()
  }

  private initializeState() {
    const stamp = readSourceStamp(
      this.repository.path,
      this.repository.projectDirectory,
      this.secret,
    )
    this.state.repositoryVersion = stamp.repositoryVersion
    this.state.sourceFingerprint = stamp.sourceFingerprint
    this.state.sessionIDs = stamp.sessionIDs
  }

  boundary(stamp: SourceStamp, transitionSequence: number) {
    this.observeStamp(stamp)
    return {
      repositoryVersion: stamp.repositoryVersion,
      sourceRevision: this.state.sourceRevision,
      sourceFingerprint: stamp.sourceFingerprint,
      nativeRevision: this.state.nativeRevision,
      eventSequence: this.state.sequence,
      transitionSequence,
    }
  }

  refreshSource() {
    section("changes:refreshSource", () => this.refreshSourceNow())
  }

  private refreshSourceNow() {
    const state = this.state
    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer)
      state.refreshTimer = undefined
    }
    state.lastRefreshAt = Date.now()
    this.observeStamp(
      readSourceStamp(this.repository.path, this.repository.projectDirectory, this.secret),
    )
  }

  /**
   * Coalesced refresh: bursts of invalidations (every progress write bumps the revision)
   * share one trailing read at most every SOURCE_REFRESH_DEBOUNCE_MS.
   */
  scheduleRefresh(onError: () => void = () => this.streamGap()) {
    const state = this.state
    if (state.refreshTimer) return
    const wait = Math.max(0, state.lastRefreshAt + SOURCE_REFRESH_DEBOUNCE_MS - Date.now())
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = undefined
      try {
        this.refreshSource()
      } catch {
        onError()
      }
    }, wait)
    state.refreshTimer.unref?.()
  }

  trackScopedSessions(
    sessionIDs: Iterable<string>,
    preferredSessionID?: string,
    options: { retainInterests?: boolean } = {},
  ) {
    const selected = new Set(options.retainInterests ? this.scopedSessionIDs : [])
    for (const sessionID of sessionIDs) {
      selected.delete(sessionID)
      selected.add(sessionID)
    }
    this.scopedSessionIDs = new Set(
      options.retainInterests ? [...selected].slice(-500) : [...selected].slice(0, 500),
    )
    this.preferredLiveSessionID =
      preferredSessionID && this.scopedSessionIDs.has(preferredSessionID)
        ? preferredSessionID
        : null
    drainPending(this.state)
  }

  beginScopeSelection() {
    this.scopeSelectionReads++
    let finished = false
    return () => {
      if (finished) return
      finished = true
      this.scopeSelectionReads--
      drainPending(this.state)
    }
  }

  hasPendingScopeSelection() {
    return this.scopeSelectionReads > 0
  }

  hasScopedSession(sessionID: string) {
    return this.scopedSessionIDs.has(sessionID)
  }

  /** Return only events observed since the last projection; each reader owns its queue. */
  peekLiveEvents(sessionIDs: ReadonlySet<string>) {
    return new Set(
      [...this.liveEventIDs].flatMap(([eventID, sessionID]) =>
        sessionIDs.has(sessionID) ? [eventID] : [],
      ),
    )
  }

  /** Return only events observed since the last projection; each reader owns its queue. */
  takeLiveEvents(sessionIDs: ReadonlySet<string>) {
    const output = new Set<string>()
    for (const [eventID, sessionID] of this.liveEventIDs) {
      if (!sessionIDs.has(sessionID)) continue
      output.add(eventID)
      this.liveEventIDs.delete(eventID)
    }
    return output
  }

  peekLiveSignals(sessionIDs: ReadonlySet<string>) {
    const signals = [...this.liveSignals.values()]
      .map(({ signal }) => signal)
      .filter((signal) => sessionIDs.has(signal.sessionID))
      .toSorted((left, right) => {
        const preferred =
          Number(right.sessionID === this.preferredLiveSessionID) -
          Number(left.sessionID === this.preferredLiveSessionID)
        return preferred || left.sourceNativeRevision - right.sourceNativeRevision
      })
    return {
      signals,
      truncated: this.liveSignalTruncationUnknown || this.hasTruncatedSession(sessionIDs),
    }
  }

  private hasTruncatedSession(sessionIDs: ReadonlySet<string>) {
    for (const sessionID of sessionIDs)
      if (this.liveSignalTruncatedSessionIDs.has(sessionID)) return true
    return false
  }

  private markLiveSignalsTruncated(sessionID: string) {
    this.liveSignalTruncatedSessionIDs.delete(sessionID)
    this.liveSignalTruncatedSessionIDs.add(sessionID)
    while (this.liveSignalTruncatedSessionIDs.size > LIVE_SIGNAL_LIMITS.truncatedSessions) {
      let oldest: string | undefined
      for (const id of this.liveSignalTruncatedSessionIDs) {
        if (id !== this.preferredLiveSessionID) {
          oldest = id
          break
        }
      }
      const eviction = oldest ?? this.liveSignalTruncatedSessionIDs.values().next().value
      if (eviction === undefined) break
      this.liveSignalTruncatedSessionIDs.delete(eviction)
      this.liveSignalTruncationUnknown = true
    }
  }

  recordLiveEvent(eventID: string, sessionID: string) {
    this.liveEventIDs.delete(eventID)
    this.liveEventIDs.set(eventID, sessionID)
    if (this.liveEventIDs.size > MAX_TRACKED_EVENTS)
      this.liveEventIDs.delete(this.liveEventIDs.keys().next().value!)
  }

  recordLiveSignal(signal: NativeSignal) {
    const key = liveSignalKey(signal)
    if (this.liveSignals.has(key)) return
    const bytes = liveSignalBytes(signal)
    if (bytes > LIVE_SIGNAL_LIMITS.retainedBytes) {
      this.markLiveSignalsTruncated(signal.sessionID)
      return
    }
    while (
      this.liveSignals.size >= LIVE_SIGNAL_LIMITS.flowEntries ||
      this.liveSignalBytes + bytes > LIVE_SIGNAL_LIMITS.retainedBytes
    ) {
      const oldest = [...this.liveSignals.entries()].find(
        ([, retained]) => retained.signal.sessionID !== this.preferredLiveSessionID,
      )
      const eviction = oldest ?? this.liveSignals.entries().next().value
      if (!eviction) {
        this.markLiveSignalsTruncated(signal.sessionID)
        return
      }
      this.liveSignals.delete(eviction[0])
      this.liveSignalBytes -= eviction[1].bytes
      this.markLiveSignalsTruncated(eviction[1].signal.sessionID)
    }
    this.liveSignals.set(key, { signal, bytes })
    this.liveSignalBytes += bytes
  }

  clearLiveEvents() {
    this.liveEventIDs.clear()
    this.liveSignals.clear()
    this.liveSignalBytes = 0
    this.liveSignalTruncatedSessionIDs.clear()
    this.liveSignalTruncationUnknown = false
  }

  observeStamp(stamp: SourceStamp) {
    const changed =
      this.state.repositoryVersion !== stamp.repositoryVersion ||
      this.state.sourceFingerprint !== stamp.sourceFingerprint
    this.state.repositoryVersion = stamp.repositoryVersion
    this.state.sourceFingerprint = stamp.sourceFingerprint
    this.state.sessionIDs = stamp.sessionIDs
    drainPending(this.state)
    if (changed) {
      this.state.sourceRevision++
      emit(this.state, "runner", false)
    }
  }

  native(event: unknown) {
    const fact = nativeFact(event)
    if (!fact) return
    if (fact.eventID && this.state.seenEvents.has(fact.eventID)) return
    if (!hasInterest(this.state, fact.sessionID)) {
      if (pendingScopeSelection(this.state)) {
        bufferNative(this.state, fact)
        return
      }
      if (Date.now() - this.state.lastRefreshAt < SOURCE_REFRESH_DEBOUNCE_MS) {
        // A source read just happened: park the fact and let one trailing refresh decide
        // membership for the whole burst instead of reading the database per event.
        bufferNative(this.state, fact)
        this.scheduleRefresh()
        return
      }
      this.refreshSource()
      if (!hasInterest(this.state, fact.sessionID)) {
        if (fact.eventID) rememberBounded(this.state.seenEvents, fact.eventID)
        return
      }
    }
    applyNative(this.state, fact)
  }

  streamGap() {
    streamGap(this.state)
  }

  /** The native event subscription is attached: connected means listening, not "has heard an event". */
  streamAttached() {
    this.state.eventStreamConnected = true
    this.state.gapActive = false
  }

  get hasConnectedEventStream() {
    return this.state.eventStreamConnected
  }

  close() {
    const state = this.state
    const wasPublisher = state.publishers.keys().next().value === this
    state.publishers.delete(this)
    state.members.delete(this)
    this.scopeSelectionReads = 0
    this.scopedSessionIDs.clear()
    this.liveEventIDs.clear()
    this.liveSignals.clear()
    this.liveSignalBytes = 0
    this.liveSignalTruncatedSessionIDs.clear()
    this.liveSignalTruncationUnknown = false
    if (!state.members.size) {
      if (state.refreshTimer) clearTimeout(state.refreshTimer)
      state.refreshTimer = undefined
      if (state.registryKey) projectStates.delete(state.registryKey)
      state.pendingNative = []
      state.pendingNativeKeys.clear()
      return
    }
    // A handoff is a fresh delivery boundary. In particular, don't let a gap
    // whose publisher failed immediately before disposal vanish behind gapActive.
    if (wasPublisher && state.publishers.size) streamGap(state, true)
    drainPending(state)
  }
}

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}
