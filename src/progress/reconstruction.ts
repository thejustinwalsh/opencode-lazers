import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import type { ProgressAssignment } from "./recorder.ts"

export type ReconstructionResult = "complete" | "retry" | "stale"

export type ReconstructionParticipant = {
  assignments(): ProgressAssignment[]
  assignmentForSession(sessionID: string): ProgressAssignment | undefined
  reconstruct(
    assignment: ProgressAssignment,
    isCurrent: () => boolean,
  ): Promise<ReconstructionResult>
}

export type ReconstructionOptions = {
  databasePath: string
  projectDirectory: string
  projectID: string
  participant: ReconstructionParticipant
  pollIntervalMs?: number
  terminalRefreshMs?: number
}

export type ReconstructionRegistration = {
  changed(sessionID: string): void
  dispose(): void
}

type Work = { dueAt: number; failures: number }
type Participant = ReconstructionParticipant & {
  id: symbol
  active: boolean
  pollIntervalMs: number
  terminalRefreshMs: number
}
type InFlight = { sessionID: string; participant: Participant }

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
  draining: boolean
  timer?: ReturnType<typeof setTimeout>
}

type CoordinatorRegistry = Map<string, Coordinator>

const coordinatorRegistryKey = Symbol.for("opencode-lazers.progress-reconstruction.v1")
const coordinatorHost = globalThis as typeof globalThis & {
  [coordinatorRegistryKey]?: CoordinatorRegistry
}
const coordinators: CoordinatorRegistry = (coordinatorHost[coordinatorRegistryKey] ??= new Map())

const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_TERMINAL_REFRESH_MS = 30_000
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
  scheduleTerminalRefresh(coordinator)
  coordinator.scanAt = Date.now() + coordinator.pollIntervalMs
}

function scheduleTerminalRefresh(coordinator: Coordinator) {
  const now = Date.now()
  const terminal = [...coordinator.assignments.values()]
    .filter((assignment) => assignmentIsTerminal(assignment))
    .sort((left, right) => left.sessionID.localeCompare(right.sessionID))
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

function scheduleTimer(coordinator: Coordinator) {
  if (coordinator.timer) clearTimeout(coordinator.timer)
  coordinator.timer = undefined
  if (!activeParticipant(coordinator) || coordinator.draining) return

  let wakeAt = coordinator.scanAt
  for (const work of coordinator.jobs.values()) wakeAt = Math.min(wakeAt, work.dueAt)
  const delay = Math.max(0, wakeAt - Date.now())
  coordinator.timer = setTimeout(() => {
    coordinator.timer = undefined
    drive(coordinator)
  }, delay)
}

function drive(coordinator: Coordinator) {
  if (coordinator.draining) return
  coordinator.draining = true
  void (async () => {
    try {
      while (true) {
        const participant = activeParticipant(coordinator)
        if (!participant) return

        if (Date.now() >= coordinator.scanAt) scanAssignments(coordinator, participant)

        const now = Date.now()
        const next = [...coordinator.jobs.entries()].find(([, work]) => work.dueAt <= now)
        if (!next) return
        const [sessionID, work] = next
        coordinator.jobs.delete(sessionID)
        let assignment: ProgressAssignment | undefined
        try {
          assignment = participant.assignmentForSession(sessionID)
        } catch {
          const failures = work.failures + 1
          enqueue(coordinator, sessionID, Date.now() + retryDelay(failures), failures)
          continue
        }
        if (!participant.active) {
          enqueue(coordinator, sessionID, Date.now(), work.failures)
          return
        }
        if (!assignment) continue

        const inFlight = { sessionID, participant }
        coordinator.inFlight = inFlight
        coordinator.dirty.delete(sessionID)
        let result: ReconstructionResult = "retry"
        const isCurrent = () =>
          participant.active &&
          coordinator.participants.get(participant.id) === participant &&
          coordinator.inFlight === inFlight
        try {
          result = await participant.reconstruct(assignment, isCurrent)
        } catch {
          result = "retry"
        }

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
      coordinator.draining = false
      scheduleTimer(coordinator)
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
      draining: false,
    }
    coordinators.set(key, coordinator)
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
    active: true,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    terminalRefreshMs: options.terminalRefreshMs ?? DEFAULT_TERMINAL_REFRESH_MS,
  }
  coordinator.participants.set(participant.id, participant)
  updateIntervals(coordinator)
  coordinator.scanAt = Math.min(coordinator.scanAt, Date.now())
  drive(coordinator)

  let disposed = false
  return {
    changed(sessionID) {
      if (disposed || !sessionID) return
      enqueue(coordinator, sessionID)
      drive(coordinator)
    },
    dispose() {
      if (disposed) return
      disposed = true
      participant.active = false
      coordinator.participants.delete(participant.id)
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
