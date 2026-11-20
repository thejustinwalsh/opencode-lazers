import { realpathSync } from "node:fs"
import { resolve } from "node:path"

export type VerificationActivityState = "running" | "completed" | "failed"

export type VerificationActivity<T = unknown> = {
  key: string
  identity: string
  owner: string
  metadata: Record<string, unknown>
  controller: AbortController
  state: VerificationActivityState
  /**
   * What the activity keeps of its result once it completes: the small fact later ticks need, never
   * the result itself. The full result is written to the journal by `run`.
   */
  summary?: unknown
  error?: unknown
  /** Settles when the run does; carries no result, so a finished activity pins none. */
  promise: Promise<void>
  settled: Promise<void>
}

type ActivityRegistry = Map<string, VerificationActivity>
const registryKey = Symbol.for("opencode-lazers.verification-activities.v1")
const registryHost = globalThis as typeof globalThis & { [registryKey]?: ActivityRegistry }
const activities = (registryHost[registryKey] ??= new Map())
export function verificationActivityKey(databasePath: string, id: string): string {
  const database = canonicalVerificationDatabasePath(databasePath)
  return JSON.stringify([database, id])
}

export function canonicalVerificationDatabasePath(databasePath: string): string {
  try {
    return realpathSync(databasePath)
  } catch {
    return resolve(databasePath)
  }
}

export function verificationActivitiesForDatabase(databasePath: string): VerificationActivity[] {
  const database = canonicalVerificationDatabasePath(databasePath)
  return [...activities.values()].filter((activity) => activity.metadata.databasePath === database)
}

export function verificationActivity<T = unknown>(
  key: string,
  identity?: string,
): VerificationActivity<T> | undefined {
  const activity = activities.get(key)
  if (!activity || (identity !== undefined && activity.identity !== identity)) return undefined
  return activity as VerificationActivity<T>
}

export function startVerificationActivity<T>(input: {
  databasePath: string
  key: string
  identity: string
  owner: string
  metadata: Record<string, unknown>
  signal?: AbortSignal
  run(signal: AbortSignal): Promise<T>
  /** Reduce a completed result to the pointer the activity keeps. */
  summarize?(result: T): unknown
  onSettled?(): void | Promise<void>
}): { activity: VerificationActivity<T>; created: boolean } {
  const existing = activities.get(input.key)
  if (existing) {
    if (existing.identity !== input.identity)
      throw new Error("A different verification activity already owns this durable check identity")
    return { activity: existing as VerificationActivity<T>, created: false }
  }

  const controller = new AbortController()
  const abort = () => controller.abort()
  if (input.signal?.aborted) abort()
  else input.signal?.addEventListener("abort", abort, { once: true })

  const activity: VerificationActivity<T> = {
    key: input.key,
    identity: input.identity,
    owner: input.owner,
    metadata: {
      ...input.metadata,
      databasePath: canonicalVerificationDatabasePath(input.databasePath),
    },
    controller,
    state: "running" as const,
    promise: Promise.resolve(),
    settled: Promise.resolve(),
  }
  activities.set(input.key, activity)

  let settle!: () => void
  activity.settled = new Promise<void>((resolveSettled) => (settle = resolveSettled))
  activity.promise = Promise.resolve()
    .then(() => input.run(controller.signal))
    .then(
      (result) => {
        activity.summary = input.summarize?.(result)
        activity.state = "completed"
      },
      (error: unknown) => {
        activity.error = error
        activity.state = "failed"
        throw error
      },
    )
    .finally(async () => {
      input.signal?.removeEventListener("abort", abort)
      try {
        void Promise.resolve(input.onSettled?.()).catch(() => undefined)
      } finally {
        settle()
      }
    })
  // Activities can outlive the tick that started them. Their outcome is read from
  // the journal/receipt on a later tick, so a rejection must not become unhandled.
  void activity.promise.catch(() => undefined)
  return { activity, created: true }
}

export async function abortVerificationActivities(
  predicate: (activity: VerificationActivity) => boolean,
): Promise<VerificationActivity[]> {
  const selected = [...activities.values()].filter(predicate)
  for (const activity of selected) activity.controller.abort()
  await Promise.all(selected.map((activity) => activity.settled))
  return selected
}

export function forgetVerificationActivity(key: string, identity: string): void {
  const activity = activities.get(key)
  if (activity?.identity === identity && activity.state !== "running") activities.delete(key)
}
