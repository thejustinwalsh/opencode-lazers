import { section, sectionAsync } from "../diagnostics/stall-probe.ts"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import type { ProgressAssignment } from "./recorder.ts"

export type ReconstructionResult = "complete" | "retry" | "stale"
export type ReconstructionReadKind = "get" | "context"
export type ReconstructionReadOutcome = "succeeded" | "failed"
export type ReconstructionRead = (
  kind: ReconstructionReadKind,
) => (outcome: ReconstructionReadOutcome) => void

export type ReconstructionParticipant = {
  assignments(): ProgressAssignment[]
  assignmentForSession(sessionID: string): ProgressAssignment | undefined
  /** Optional O(1) prefilter: false guarantees no assignment owns the session. */
  mayOwn?(sessionID: string): boolean
  reconstruct(
    assignment: ProgressAssignment,
    isCurrent: () => boolean,
    readStarted: ReconstructionRead,
  ): Promise<ReconstructionResult>
}

export type ReconstructionOptions = {
  databasePath: string
  projectDirectory: string
  projectID: string
  location?: string
  participant: ReconstructionParticipant
  pollIntervalMs?: number
  terminalRefreshMs?: number
  /** Trailing coalescing window per session for native-event nudges. */
  changedDebounceMs?: number
}

export type ReconstructionRegistration = {
  changed(sessionID: string): void
  dispose(): void
}

type Work = { dueAt: number; failures: number }
type Participant = ReconstructionParticipant & {
  id: symbol
  generationID: string
  location: string
  active: boolean
  pollIntervalMs: number
  terminalRefreshMs: number
}
type InFlight = {
  sessionID: string
  participant: Participant
  work: Work
  drainOwner: symbol
}

type NativeReadCounts = Record<
  ReconstructionReadKind,
  Record<ReconstructionReadOutcome, number> & {
    invocations: number
  }
>
type PendingNativeRead = {
  kind: ReconstructionReadKind
  participantID: symbol
  retired: boolean
}

type Coordinator = {
  assignments: Map<string, ProgressAssignment>
  participants: Map<symbol, Participant>
  jobs: Map<string, Work>
  dirty: Set<string>
  lastCompletedAt: Map<string, number>
  baselineCaptured: boolean
  scanAt: number
  pollIntervalMs: number
  terminalRefreshMs: number
  terminalCursor?: string
  inFlight?: InFlight
  drainOwner?: symbol
  timer?: ReturnType<typeof setTimeout>
  assignmentsObservedAt?: number
  nativeReadCounts?: NativeReadCounts
  pendingNativeReads?: Map<symbol, PendingNativeRead>
  diagnosticsStartedAt?: number
  diagnosticsPartial?: boolean
}

type CoordinatorRegistry = Map<string, Coordinator>

const RECONSTRUCTION_IMPLEMENTATION_ID = "lazers.progress.reconstruction.v1"
const moduleGenerationID = crypto.randomUUID()
const MAX_DIAGNOSTIC_GROUPS = 32

const coordinatorRegistryKey = Symbol.for("opencode-lazers.progress-reconstruction.v1")
const coordinatorHost = globalThis as typeof globalThis & {
  [coordinatorRegistryKey]?: CoordinatorRegistry
}
const coordinators: CoordinatorRegistry = (coordinatorHost[coordinatorRegistryKey] ??= new Map())

const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_TERMINAL_REFRESH_MS = 30_000
const DEFAULT_CHANGED_DEBOUNCE_MS = 1_500
const MAX_RETRY_DELAY_MS = 60_000
const ACTIVE_ATTEMPT_STATES = new Set(["preparing", "queued", "ready", "running", "verifying"])

function canonicalPath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

export function progressReconstructionKey(
  databasePath: string,
  projectDirectory: string,
  projectID: string,
): string {
  return JSON.stringify([canonicalPath(databasePath), canonicalPath(projectDirectory), projectID])
}

export function sameProgressAssignment(
  left: ProgressAssignment | undefined,
  right: ProgressAssignment | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.projectID === right.projectID &&
    left.taskID === right.taskID &&
    left.planID === right.planID &&
    left.attemptID === right.attemptID &&
    left.attemptState === right.attemptState &&
    left.sessionID === right.sessionID &&
    left.assignedMessageID === right.assignedMessageID &&
    left.workspace === right.workspace,
  )
}

function assignmentIsTerminal(assignment: ProgressAssignment) {
  return !ACTIVE_ATTEMPT_STATES.has(assignment.attemptState)
}

function activeParticipant(coordinator: Coordinator): Participant | undefined {
  for (const participant of coordinator.participants.values())
    if (participant.active) return participant
  return undefined
}

function updateIntervals(coordinator: Coordinator) {
  const participants = [...coordinator.participants.values()].filter((value) => value.active)
  if (participants.length === 0) return
  coordinator.pollIntervalMs = Math.min(...participants.map((value) => value.pollIntervalMs))
  coordinator.terminalRefreshMs = Math.min(...participants.map((value) => value.terminalRefreshMs))
}

function enqueue(coordinator: Coordinator, sessionID: string, dueAt = Date.now(), failures = 0) {
  if (coordinator.inFlight?.sessionID === sessionID) {
    coordinator.dirty.add(sessionID)
    return
  }
  const existing = coordinator.jobs.get(sessionID)
  if (existing) {
    existing.dueAt = Math.min(existing.dueAt, dueAt)
    existing.failures = Math.min(existing.failures, failures)
    return
  }
  coordinator.jobs.set(sessionID, { dueAt, failures })
}

function scanAssignments(coordinator: Coordinator, participant: Participant) {
  if (!participant.active) return
  let assignments: ProgressAssignment[]
  try {
    assignments = participant.assignments()
  } catch {
    coordinator.scanAt = Date.now() + coordinator.pollIntervalMs
    return
  }
  if (!participant.active) return

  const current = new Map(assignments.map((assignment) => [assignment.sessionID, assignment]))
  for (const [sessionID, assignment] of current) {
    const previous = coordinator.assignments.get(sessionID)
    if (!coordinator.baselineCaptured || !sameProgressAssignment(previous, assignment)) {
      coordinator.lastCompletedAt.delete(sessionID)
      enqueue(coordinator, sessionID)
    }
  }
  for (const sessionID of coordinator.assignments.keys()) {
    if (current.has(sessionID)) continue
    coordinator.jobs.delete(sessionID)
    coordinator.dirty.delete(sessionID)
    coordinator.lastCompletedAt.delete(sessionID)
  }
  coordinator.assignments = current
  coordinator.baselineCaptured = true
  coordinator.assignmentsObservedAt = Date.now()
  scheduleTerminalRefresh(coordinator)
  coordinator.scanAt = Date.now() + coordinator.pollIntervalMs
}

function scheduleTerminalRefresh(coordinator: Coordinator) {
  const now = Date.now()
  const terminal = [...coordinator.assignments.values()]
    .filter((assignment) => assignmentIsTerminal(assignment))
    .sort((left, right) =>
      left.sessionID < right.sessionID ? -1 : left.sessionID > right.sessionID ? 1 : 0,
    )
  if (terminal.length === 0) return

  const start = coordinator.terminalCursor
    ? Math.max(
        0,
        terminal.findIndex((assignment) => assignment.sessionID > coordinator.terminalCursor!),
      )
    : 0
  for (let offset = 0; offset < terminal.length; offset++) {
    const assignment = terminal[(start + offset) % terminal.length]!
    if (
      coordinator.jobs.has(assignment.sessionID) ||
      coordinator.inFlight?.sessionID === assignment.sessionID
    )
      continue
    const lastCompletedAt = coordinator.lastCompletedAt.get(assignment.sessionID)
    if (lastCompletedAt !== undefined && now - lastCompletedAt < coordinator.terminalRefreshMs)
      continue
    coordinator.terminalCursor = assignment.sessionID
    enqueue(coordinator, assignment.sessionID, now)
    break
  }
}

function retryDelay(failures: number) {
  return Math.min(1_000 * 2 ** Math.min(Math.max(failures - 1, 0), 6), MAX_RETRY_DELAY_MS)
}

function newNativeReadCounts(): NativeReadCounts {
  return {
    get: { invocations: 0, succeeded: 0, failed: 0 },
    context: { invocations: 0, succeeded: 0, failed: 0 },
  }
}

function initializeDiagnostics(coordinator: Coordinator) {
  if (!coordinator.nativeReadCounts) coordinator.nativeReadCounts = newNativeReadCounts()
  if (!coordinator.pendingNativeReads) coordinator.pendingNativeReads = new Map()
  coordinator.diagnosticsStartedAt ??= Date.now()
}

function nativeReadStarted(
  coordinator: Coordinator,
  participant: Participant,
  kind: ReconstructionReadKind,
): (outcome: ReconstructionReadOutcome) => void {
  const counts = coordinator.nativeReadCounts
  const pendingReads = coordinator.pendingNativeReads
  if (!counts || !pendingReads) return () => {}

  counts[kind].invocations++
  const id = Symbol("progress-reconstruction-native-read")
  pendingReads.set(id, {
    kind,
    participantID: participant.id,
    retired: !participant.active || coordinator.participants.get(participant.id) !== participant,
  })
  let settled = false
  return (outcome) => {
    if (settled) return
    settled = true
    counts[kind][outcome]++
    pendingReads.delete(id)
  }
}

export type ProgressReconstructionDiagnostics = {
  schemaVersion: 1
  implementationID: typeof RECONSTRUCTION_IMPLEMENTATION_ID
  moduleGenerationID: string
  observedAt: number
  state: "absent" | "uninitialized" | "initialized" | "instrumentation-unavailable"
  coverage: "not-started" | "complete" | "partial"
  coordinator: {
    participantCount: number
    participantGenerations: Array<{ generationID: string | null; participantCount: number }>
    participantGenerationsTruncated: boolean
    locationCount: number
    locationParticipantCounts: number[]
    unknownLocationParticipantCount: number
    locationsTruncated: boolean
    assignments: {
      baselineCaptured: boolean
      cachedCount: number
      activeCount: number
      terminalCount: number
      asOf: number | null
    }
    work: {
      queuedCount: number
      delayedCount: number
      dirtyCount: number
      drainOwned: boolean
      reconstructionActive: boolean
      timerScheduled: boolean
      outstandingRetiredReads: number
    }
    nativeReads: {
      startedAt: number
      get: {
        invocations: number
        succeeded: number
        failed: number
        pending: number
      }
      context: {
        invocations: number
        succeeded: number
        failed: number
        pending: number
      }
    } | null
  }
}

function emptyDiagnostics(
  observedAt: number,
  state: ProgressReconstructionDiagnostics["state"],
  coverage: ProgressReconstructionDiagnostics["coverage"],
): ProgressReconstructionDiagnostics {
  return {
    schemaVersion: 1,
    implementationID: RECONSTRUCTION_IMPLEMENTATION_ID,
    moduleGenerationID,
    observedAt,
    state,
    coverage,
    coordinator: {
      participantCount: 0,
      participantGenerations: [],
      participantGenerationsTruncated: false,
      locationCount: 0,
      locationParticipantCounts: [],
      unknownLocationParticipantCount: 0,
      locationsTruncated: false,
      assignments: {
        baselineCaptured: false,
        cachedCount: 0,
        activeCount: 0,
        terminalCount: 0,
        asOf: null,
      },
      work: {
        queuedCount: 0,
        delayedCount: 0,
        dirtyCount: 0,
        drainOwned: false,
        reconstructionActive: false,
        timerScheduled: false,
        outstandingRetiredReads: 0,
      },
      nativeReads: null,
    },
  }
}

/** Lookup-only project diagnostics. This deliberately never creates or wakes a coordinator. */
export function progressReconstructionDiagnostics(
  databasePath: string,
  projectDirectory: string,
  projectID: string,
): ProgressReconstructionDiagnostics {
  const observedAt = Date.now()
  const coordinator = coordinators.get(
    progressReconstructionKey(databasePath, projectDirectory, projectID),
  )
  if (!coordinator) return emptyDiagnostics(observedAt, "absent", "not-started")

  const participants = [...coordinator.participants.values()].filter(
    (participant) => participant.active,
  )
  const generations = new Map<string | null, number>()
  const locations = new Map<string, number>()
  let unknownLocationParticipantCount = 0
  for (const participant of participants) {
    const generation =
      typeof participant.generationID === "string" ? participant.generationID : null
    generations.set(generation, (generations.get(generation) ?? 0) + 1)
    const location = typeof participant.location === "string" ? participant.location : undefined
    if (location === undefined) unknownLocationParticipantCount++
    else locations.set(location, (locations.get(location) ?? 0) + 1)
  }
  const generationGroups = [...generations.entries()]
    .sort(([left], [right]) => (left ?? "").localeCompare(right ?? ""))
    .slice(0, MAX_DIAGNOSTIC_GROUPS)
    .map(([generationID, participantCount]) => ({ generationID, participantCount }))
  const locationGroups = [...locations.values()].sort((left, right) => right - left)
  const pending = coordinator.pendingNativeReads
  const counts = coordinator.nativeReadCounts
  const countPending = (kind: ReconstructionReadKind) => {
    let count = 0
    for (const read of pending?.values() ?? []) if (read.kind === kind) count++
    return count
  }
  const nativeReads =
    counts && pending && coordinator.diagnosticsStartedAt !== undefined
      ? {
          startedAt: coordinator.diagnosticsStartedAt,
          get: { ...counts.get, pending: countPending("get") },
          context: { ...counts.context, pending: countPending("context") },
        }
      : null
  const assignments = [...coordinator.assignments.values()]
  const activeCount = assignments.filter((assignment) => !assignmentIsTerminal(assignment)).length
  const terminalCount = assignments.length - activeCount
  const now = Date.now()
  const queuedCount = [...coordinator.jobs.values()].filter((work) => work.dueAt <= now).length
  const delayedCount = coordinator.jobs.size - queuedCount
  let outstandingRetiredReads = 0
  for (const read of pending?.values() ?? []) if (read.retired) outstandingRetiredReads++
  const coverage = coordinator.diagnosticsPartial || generations.has(null) ? "partial" : "complete"

  return {
    schemaVersion: 1,
    implementationID: RECONSTRUCTION_IMPLEMENTATION_ID,
    moduleGenerationID,
    observedAt,
    state: nativeReads
      ? coordinator.baselineCaptured
        ? "initialized"
        : "uninitialized"
      : "instrumentation-unavailable",
    coverage,
    coordinator: {
      participantCount: participants.length,
      participantGenerations: generationGroups,
      participantGenerationsTruncated: generations.size > generationGroups.length,
      locationCount: locations.size + (unknownLocationParticipantCount > 0 ? 1 : 0),
      locationParticipantCounts: locationGroups.slice(0, MAX_DIAGNOSTIC_GROUPS),
      unknownLocationParticipantCount,
      locationsTruncated: locationGroups.length > MAX_DIAGNOSTIC_GROUPS,
      assignments: {
        baselineCaptured: coordinator.baselineCaptured,
        cachedCount: assignments.length,
        activeCount,
        terminalCount,
        asOf: coordinator.assignmentsObservedAt ?? null,
      },
      work: {
        queuedCount,
        delayedCount,
        dirtyCount: coordinator.dirty.size,
        drainOwned: coordinator.drainOwner !== undefined,
        reconstructionActive: coordinator.inFlight !== undefined,
        timerScheduled: coordinator.timer !== undefined,
        outstandingRetiredReads,
      },
      nativeReads,
    },
  }
}

function scheduleTimer(coordinator: Coordinator) {
  if (coordinator.timer) clearTimeout(coordinator.timer)
  coordinator.timer = undefined
  if (!activeParticipant(coordinator) || coordinator.drainOwner) return

  let wakeAt = coordinator.scanAt
  for (const work of coordinator.jobs.values()) wakeAt = Math.min(wakeAt, work.dueAt)
  const delay = Math.max(0, wakeAt - Date.now())
  coordinator.timer = setTimeout(() => {
    coordinator.timer = undefined
    drive(coordinator)
  }, delay)
}

function drive(coordinator: Coordinator) {
  if (coordinator.drainOwner) return
  const drainOwner = Symbol("progress-reconstruction-drain")
  coordinator.drainOwner = drainOwner
  void (async () => {
    try {
      while (coordinator.drainOwner === drainOwner) {
        const participant = activeParticipant(coordinator)
        if (!participant) return

        if (Date.now() >= coordinator.scanAt)
          section("reconstruction:scan", () => scanAssignments(coordinator, participant))

        const now = Date.now()
        const next = [...coordinator.jobs.entries()].find(([, work]) => work.dueAt <= now)
        if (!next) return
        const [sessionID, work] = next
        coordinator.jobs.delete(sessionID)
        let assignment: ProgressAssignment | undefined
        try {
          assignment = section("reconstruction:assignmentForSession", () =>
            participant.assignmentForSession(sessionID),
          )
        } catch {
          if (coordinator.drainOwner !== drainOwner) return
          const failures = work.failures + 1
          enqueue(coordinator, sessionID, Date.now() + retryDelay(failures), failures)
          continue
        }
        if (!participant.active || coordinator.participants.get(participant.id) !== participant) {
          enqueue(coordinator, sessionID, Date.now(), work.failures)
          continue
        }
        if (!assignment) continue

        const inFlight = { sessionID, participant, work, drainOwner }
        coordinator.inFlight = inFlight
        coordinator.dirty.delete(sessionID)
        let result: ReconstructionResult = "retry"
        const isCurrent = () =>
          coordinator.drainOwner === drainOwner &&
          participant.active &&
          coordinator.participants.get(participant.id) === participant &&
          coordinator.inFlight === inFlight
        try {
          result = await sectionAsync("reconstruction:reconstruct", () =>
            Promise.resolve(
              participant.reconstruct(assignment, isCurrent, (kind) =>
                nativeReadStarted(coordinator, participant, kind),
              ),
            ),
          )
        } catch {
          result = "retry"
        }

        // A retired drain has already handed its in-flight work to a successor.
        // Its unresolved native read may settle later, but it no longer owns any
        // coordinator state and must not alter the successor's queue or timer.
        if (coordinator.drainOwner !== drainOwner) return

        const retired = !isCurrent()
        const wasDirty = coordinator.dirty.delete(sessionID)
        coordinator.inFlight = undefined
        if (retired || wasDirty || result === "stale") {
          coordinator.scanAt = Math.min(coordinator.scanAt, Date.now())
          enqueue(coordinator, sessionID, Date.now(), retired ? 0 : work.failures)
        } else if (result === "retry") {
          const failures = work.failures + 1
          enqueue(coordinator, sessionID, Date.now() + retryDelay(failures), failures)
        } else {
          coordinator.lastCompletedAt.set(sessionID, Date.now())
        }
      }
    } finally {
      if (coordinator.drainOwner === drainOwner) {
        coordinator.drainOwner = undefined
        scheduleTimer(coordinator)
      }
    }
  })()
}

function coordinatorFor(key: string, options: ReconstructionOptions): Coordinator {
  let coordinator = coordinators.get(key)
  if (!coordinator) {
    coordinator = {
      assignments: new Map(),
      participants: new Map(),
      jobs: new Map(),
      dirty: new Set(),
      lastCompletedAt: new Map(),
      baselineCaptured: false,
      scanAt: 0,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      terminalRefreshMs: options.terminalRefreshMs ?? DEFAULT_TERMINAL_REFRESH_MS,
    }
    coordinators.set(key, coordinator)
    initializeDiagnostics(coordinator)
  } else if (!coordinator.nativeReadCounts || !coordinator.pendingNativeReads) {
    coordinator.diagnosticsPartial = true
    initializeDiagnostics(coordinator)
  }
  return coordinator
}

export function registerProgressReconstruction(
  options: ReconstructionOptions,
): ReconstructionRegistration {
  const key = progressReconstructionKey(
    options.databasePath,
    options.projectDirectory,
    options.projectID,
  )
  const coordinator = coordinatorFor(key, options)
  const participant: Participant = {
    ...options.participant,
    id: Symbol("progress-reconstruction-participant"),
    generationID: moduleGenerationID,
    location: canonicalPath(options.location ?? options.projectDirectory),
    active: true,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    terminalRefreshMs: options.terminalRefreshMs ?? DEFAULT_TERMINAL_REFRESH_MS,
  }
  const debounceMs = Math.max(0, options.changedDebounceMs ?? DEFAULT_CHANGED_DEBOUNCE_MS)
  coordinator.participants.set(participant.id, participant)
  updateIntervals(coordinator)
  coordinator.scanAt = Math.min(coordinator.scanAt, Date.now())
  drive(coordinator)

  let disposed = false
  return {
    changed(sessionID) {
      if (disposed || !sessionID) return
      // Once the assignment baseline exists, sessions outside it are unowned or new. Unowned
      // sessions return in O(1); possibly-new ones request one coalesced assignment scan,
      // which enqueues them. Neither opens a per-session transaction.
      if (coordinator.baselineCaptured && !coordinator.assignments.has(sessionID)) {
        const owner = activeParticipant(coordinator)
        if (owner?.mayOwn?.(sessionID) === false) return
        if (coordinator.scanAt > Date.now()) {
          coordinator.scanAt = Date.now()
          drive(coordinator)
        }
        return
      }
      const wasQueued = coordinator.jobs.has(sessionID)
      enqueue(coordinator, sessionID, Date.now() + debounceMs)
      // A burst shares the first job's due time; wake only when the schedule changed.
      if (!wasQueued || debounceMs === 0) drive(coordinator)
    },
    dispose() {
      if (disposed) return
      disposed = true
      participant.active = false
      coordinator.participants.delete(participant.id)
      for (const read of coordinator.pendingNativeReads?.values() ?? [])
        if (read.participantID === participant.id) read.retired = true
      const inFlight = coordinator.inFlight
      if (inFlight?.participant === participant) {
        coordinator.inFlight = undefined
        coordinator.dirty.delete(inFlight.sessionID)
        enqueue(coordinator, inFlight.sessionID, Date.now(), inFlight.work.failures)
        if (coordinator.drainOwner === inFlight.drainOwner) coordinator.drainOwner = undefined
      }
      updateIntervals(coordinator)
      coordinator.scanAt = Math.min(coordinator.scanAt, Date.now())
      if (!activeParticipant(coordinator) && coordinator.timer) {
        clearTimeout(coordinator.timer)
        coordinator.timer = undefined
      }
      drive(coordinator)
    },
  }
}
