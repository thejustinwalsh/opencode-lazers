import { realpathSync } from "node:fs"
import { resolve } from "node:path"

export const PROJECT_RECONCILIATION_INTERVAL_MS = 5 * 60_000

type Clock = {
  now(): number
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

type Participant = {
  intervalMs: number
  run(): Promise<void> | void
  onError?(error: unknown): Promise<void> | void
}

type Waiter = { owner: symbol; resolve(): void; reject(error: unknown): void }
type Group = {
  participants: Map<symbol, Participant>
  dueAt: number
  waiters: Waiter[]
  running?: { owner: symbol; done: Promise<void>; waiters: Waiter[] }
}

export type SchedulerProjectStatus = {
  status: "scheduled" | "draining" | "registered" | "absent" | "unknown"
  participants: number
}

const systemClock: Clock = {
  now: () => performance.now(),
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** One process timer; one non-overlapping drain per shared job. */
export class SchedulerCoordinator {
  private readonly generation = crypto.randomUUID()
  private groups = new Map<string, Group>()
  private timer: { handle: unknown; dueAt: number } | undefined
  private runs = 0
  private errors = 0
  private wakeups = 0

  constructor(private clock: Clock = systemClock) {}

  register(key: string, participant: Participant, initialDelayMs = 0) {
    if (!Number.isFinite(participant.intervalMs) || participant.intervalMs <= 0)
      throw new Error("Scheduler interval must be positive and finite")
    this.delay(initialDelayMs)
    let group = this.groups.get(key)
    if (!group) {
      group = { participants: new Map(), dueAt: this.clock.now() + initialDelayMs, waiters: [] }
      this.groups.set(key, group)
    } else if (!group.participants.size) {
      group.dueAt = Math.min(group.dueAt, this.clock.now() + initialDelayMs)
    } else if (!group.running) {
      group.dueAt = Math.min(group.dueAt, this.clock.now() + participant.intervalMs)
    }
    const owner = Symbol(key)
    group.participants.set(owner, participant)
    this.arm()
    let disposed: Promise<void> | undefined
    return {
      runNow: () => {
        if (!group.participants.has(owner))
          return Promise.reject(new Error("Scheduler registration was disposed"))
        const done = new Promise<void>((resolve, reject) => {
          group.waiters.push({ owner, resolve, reject })
        })
        group.dueAt = Math.min(group.dueAt, this.clock.now())
        this.arm()
        return done
      },
      request: (delayMs = 0) => {
        this.delay(delayMs)
        if (!group.participants.has(owner)) return
        group.dueAt = Math.min(group.dueAt, this.clock.now() + delayMs)
        this.arm()
      },
      dispose: () => {
        if (disposed) return disposed
        group.participants.delete(owner)
        this.rejectOwnedWaiters(group.waiters, owner)
        if (group.running) this.rejectOwnedWaiters(group.running.waiters, owner)
        const running = group.running
        if (!running && !group.participants.size) this.groups.delete(key)
        else if (running?.owner === owner && group.participants.size)
          group.dueAt = Math.min(group.dueAt, this.clock.now())
        this.arm()
        disposed = running?.owner === owner ? running.done : Promise.resolve()
        return disposed
      },
    }
  }

  snapshot() {
    return {
      implementation: "scheduler/v2" as const,
      generation: this.generation,
      timerCount: this.timer ? 1 : 0,
      groups: this.groups.size,
      participants: [...this.groups.values()].reduce((n, group) => n + group.participants.size, 0),
      running: [...this.groups.values()].filter((group) => group.running).length,
      runs: this.runs,
      errors: this.errors,
      wakeups: this.wakeups,
    }
  }

  /** Read only the exact project-key group; process-wide totals stay diagnostic-only. */
  projectStatus(key: string): SchedulerProjectStatus {
    const group = this.groups.get(key)
    if (!group) return { status: "absent", participants: 0 }
    const participants = group.participants.size
    if (group.running) return { status: "draining", participants }
    if (participants > 0 && Number.isFinite(group.dueAt))
      return { status: "scheduled", participants }
    if (participants > 0) return { status: "registered", participants }
    return { status: "unknown", participants: 0 }
  }

  private delay(value: number) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error("Scheduler delay must be nonnegative and finite")
  }

  private rejectOwnedWaiters(waiters: Waiter[], owner: symbol) {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]!
      if (waiter.owner !== owner) continue
      waiters.splice(i, 1)
      waiter.reject(new Error("Scheduler registration was disposed"))
    }
  }

  private arm() {
    let dueAt = Infinity
    for (const group of this.groups.values())
      if (!group.running && group.participants.size) dueAt = Math.min(dueAt, group.dueAt)
    if (this.timer?.dueAt === dueAt) return
    if (this.timer) this.clock.clear(this.timer.handle)
    this.timer = undefined
    if (dueAt === Infinity) return
    this.timer = {
      dueAt,
      handle: this.clock.set(() => this.drain(), Math.max(0, dueAt - this.clock.now())),
    }
  }

  private drain() {
    this.timer = undefined
    this.wakeups++
    for (const [key, group] of this.groups) {
      if (group.running || group.dueAt > this.clock.now()) continue
      const selected = group.participants.entries().next().value
      if (!selected) continue
      const [owner, participant] = selected
      const waiters = group.waiters.splice(0)
      group.dueAt = Infinity
      this.runs++
      let failed = false
      let failure: unknown
      const done = Promise.resolve()
        .then(() => participant.run())
        .catch((error: unknown) => {
          this.errors++
          failed = true
          failure = error
          void Promise.resolve()
            .then(() => participant.onError?.(error))
            .catch(() => undefined)
        })
        .finally(() => {
          for (const waiter of waiters)
            if (failed) waiter.reject(failure)
            else waiter.resolve()
          group.running = undefined
          if (!group.participants.size) this.groups.delete(key)
          else {
            const interval = Math.min(...[...group.participants.values()].map((p) => p.intervalMs))
            group.dueAt = Math.min(group.dueAt, this.clock.now() + interval)
          }
          this.arm()
        })
      group.running = { owner, done, waiters }
    }
    this.arm()
  }
}

function canonical(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export function schedulerProjectKey(database: string, directory: string, projectID: string) {
  return JSON.stringify(["project", canonical(database), canonical(directory), projectID])
}

const registryKey = Symbol.for("opencode-lazers.scheduler-coordinator.v2")
const registryHost = globalThis as typeof globalThis & {
  [registryKey]?: SchedulerCoordinator
}
export const sharedScheduler = (registryHost[registryKey] ??= new SchedulerCoordinator())
