import type { TaskRepository } from "../storage.ts"
import {
  ModelPriceSourcePolicySchema,
  type ModelPriceSourcePolicy,
} from "./price-source-settings.ts"

const TABLE = "model_price_source_policy"
const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    project_directory TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK(revision >= 0),
    sources TEXT NOT NULL
  );
`

type Producer = { refresh(): Promise<void> }
const producersKey = Symbol.for("opencode-lazers.models.price-source-producers.v1")
const host = globalThis as typeof globalThis & {
  [producersKey]?: Map<string, Producer[]>
}
const producers = () => (host[producersKey] ??= new Map())

function registerProducer(projectDirectory: string, producer: Producer) {
  const list = producers().get(projectDirectory) ?? []
  list.push(producer)
  producers().set(projectDirectory, list)
  return () => {
    const index = list.indexOf(producer)
    if (index >= 0) list.splice(index, 1)
    if (!list.length && producers().get(projectDirectory) === list)
      producers().delete(projectDirectory)
  }
}

/** Update the stored stream row before a policy stream opens. */
export async function refreshModelPriceSourcePolicyFor(projectDirectory: string) {
  const producer = producers().get(projectDirectory)?.at(-1)
  if (!producer) throw new Error("Model price-source settings are unavailable")
  await producer.refresh()
}

/** A privacy-safe, project-local row the Models policy stream can read. */
function installModelPriceSourcePolicyProjection(repository: Pick<TaskRepository, "atomic">) {
  repository.atomic((db) => db.exec(TABLE_SQL))
}

function writeModelPriceSourcePolicyProjection(
  repository: Pick<TaskRepository, "atomic">,
  projectDirectory: string,
  input: ModelPriceSourcePolicy,
) {
  const policy = ModelPriceSourcePolicySchema.parse(input)
  repository.atomic((db) => {
    db.query(
      `INSERT INTO ${TABLE}(project_directory,revision,sources) VALUES(?,?,?)
       ON CONFLICT(project_directory) DO UPDATE SET
         revision=excluded.revision,sources=excluded.sources
       WHERE revision<>excluded.revision OR sources<>excluded.sources`,
    ).run(projectDirectory, policy.revision, JSON.stringify(policy.sources))
  })
}

/**
 * Keeps the policy stream row in step with host storage. Opens and successful configure calls ask
 * for an immediate refresh; the timer notices writes from another loaded location. Disposal
 * unregisters the producer and stops that timer.
 */
export function startModelPriceSourcePolicyProjection(options: {
  repository: Pick<TaskRepository, "atomic">
  projectDirectory: string
  read(): Promise<ModelPriceSourcePolicy>
  refreshMs: number
  onError?(error: unknown): void
}) {
  installModelPriceSourcePolicyProjection(options.repository)
  let closed = false
  let again = false
  let operation: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const refresh = () => {
    if (closed) return Promise.resolve()
    if (operation) {
      again = true
      return operation
    }
    operation = (async () => {
      try {
        do {
          again = false
          const policy = ModelPriceSourcePolicySchema.parse(await options.read())
          if (closed) return
          writeModelPriceSourcePolicyProjection(
            options.repository,
            options.projectDirectory,
            policy,
          )
        } while (again && !closed)
      } finally {
        operation = undefined
      }
    })()
    return operation
  }

  const schedule = () => {
    if (closed) return
    timer = setTimeout(() => {
      timer = undefined
      void refresh()
        .catch((error: unknown) => options.onError?.(error))
        .finally(schedule)
    }, options.refreshMs)
    timer.unref?.()
  }
  const producer = { refresh }
  const unregister = registerProducer(options.projectDirectory, producer)
  // The policy is first read after a stream's authorization check. The timer observes subsequent
  // host-storage changes while the service is live.
  schedule()

  return {
    refresh,
    stop() {
      if (closed) return
      closed = true
      if (timer) clearTimeout(timer)
      unregister()
    },
  }
}
