import { z } from "zod"

export const MODEL_PRICE_SOURCES = ["openrouter", "opencode"] as const
export const ModelPriceSourceSchema = z.enum(MODEL_PRICE_SOURCES)
export type ModelPriceSource = z.infer<typeof ModelPriceSourceSchema>

const SourceOrderSchema = z
  .array(ModelPriceSourceSchema)
  .max(MODEL_PRICE_SOURCES.length)
  .superRefine((sources, context) => {
    if (new Set(sources).size !== sources.length)
      context.addIssue({ code: "custom", message: "Price sources must be unique" })
  })

export const ModelPriceSourcePolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.int().nonnegative(),
  sources: SourceOrderSchema,
  fallback: z.literal("whole-model"),
})
export type ModelPriceSourcePolicy = z.infer<typeof ModelPriceSourcePolicySchema>

export const ModelPriceSourceUpdateSchema = z.strictObject({
  expectedRevision: z.int().nonnegative(),
  sources: SourceOrderSchema,
})
export type ModelPriceSourceUpdate = z.infer<typeof ModelPriceSourceUpdateSchema>

export const ModelPriceSourceAccessSchema = z.enum([
  "configured",
  "not-configured",
  "reauthentication-required",
  "unknown",
])

export const ModelPriceSourceSettingsSchema = z.strictObject({
  policy: ModelPriceSourcePolicySchema,
  access: z.strictObject({
    openrouter: ModelPriceSourceAccessSchema,
    opencode: ModelPriceSourceAccessSchema,
  }),
})
export type ModelPriceSourceSettings = z.infer<typeof ModelPriceSourceSettingsSchema>

export const ModelPriceSourceWriteOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("updated"),
    policy: ModelPriceSourcePolicySchema,
  }),
  z.strictObject({
    status: z.literal("conflict"),
    expectedRevision: z.int().nonnegative(),
    currentRevision: z.int().nonnegative(),
    current: ModelPriceSourcePolicySchema,
  }),
])
export type ModelPriceSourceWriteOutput = z.infer<typeof ModelPriceSourceWriteOutputSchema>

export interface ModelPriceSourceStorage {
  get(key: string, signal?: AbortSignal): Promise<unknown>
  set(key: string, value: ModelPriceSourcePolicy, signal?: AbortSignal): Promise<void>
}

// Symbol.for survives OpenCode's per-location module reloads, serializing CAS across copies.
const WRITE_QUEUES_KEY = Symbol.for("opencode-lazers.models.price-source-settings.write-queues.v1")

function writeQueues(): Map<string, Promise<void>> {
  const existing = Reflect.get(globalThis, WRITE_QUEUES_KEY) as
    Map<string, Promise<void>> | undefined
  if (existing) return existing
  const created = new Map<string, Promise<void>>()
  Reflect.set(globalThis, WRITE_QUEUES_KEY, created)
  return created
}

const defaultSources: ModelPriceSource[] = [...MODEL_PRICE_SOURCES]

export function defaultModelPriceSourcePolicy(): ModelPriceSourcePolicy {
  return {
    schemaVersion: 1,
    revision: 0,
    sources: [...defaultSources],
    fallback: "whole-model",
  }
}

/** Project-scoped, credential-free settings backed by native plugin storage. */
export class ModelPriceSourceSettingsStore {
  private readonly key: string

  constructor(
    private readonly storage: ModelPriceSourceStorage,
    projectDirectory: string,
  ) {
    this.key = `models.price-source-policy.${encodeURIComponent(projectDirectory)}`
  }

  async read(signal?: AbortSignal): Promise<ModelPriceSourcePolicy> {
    return this.exclusive(() => this.load(signal))
  }

  configure(input: unknown, signal?: AbortSignal): Promise<ModelPriceSourceWriteOutput> {
    const update = ModelPriceSourceUpdateSchema.parse(input)
    return this.exclusive(() => this.configureSerially(update, signal))
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const queues = writeQueues()
    const previous = queues.get(this.key) ?? Promise.resolve()
    const operation = previous.then(run, run)
    const settled = operation.then(
      () => undefined,
      () => undefined,
    )
    queues.set(this.key, settled)
    void settled.then(() => {
      if (queues.get(this.key) === settled) queues.delete(this.key)
    })
    return operation
  }

  private async configureSerially(
    update: ModelPriceSourceUpdate,
    signal?: AbortSignal,
  ): Promise<ModelPriceSourceWriteOutput> {
    const current = await this.load(signal)
    if (update.expectedRevision !== current.revision)
      return {
        status: "conflict",
        expectedRevision: update.expectedRevision,
        currentRevision: current.revision,
        current,
      }
    if (current.revision === Number.MAX_SAFE_INTEGER)
      throw new Error("Model price-source policy revision is exhausted")

    const policy = ModelPriceSourcePolicySchema.parse({
      schemaVersion: 1,
      revision: current.revision + 1,
      sources: update.sources,
      fallback: "whole-model",
    })
    signal?.throwIfAborted()
    try {
      await this.storage.set(this.key, policy, signal)
    } catch {
      signal?.throwIfAborted()
      throw new Error("Model price-source policy could not be saved")
    }
    return { status: "updated", policy }
  }

  private async load(signal?: AbortSignal): Promise<ModelPriceSourcePolicy> {
    signal?.throwIfAborted()
    let stored: unknown
    try {
      stored = await this.storage.get(this.key, signal)
    } catch {
      signal?.throwIfAborted()
      throw new Error("Model price-source policy could not be read")
    }
    signal?.throwIfAborted()
    if (stored === undefined) return defaultModelPriceSourcePolicy()

    const parsed = ModelPriceSourcePolicySchema.safeParse(stored)
    if (!parsed.success) throw new Error("Stored model price-source policy is invalid")
    return parsed.data
  }
}
