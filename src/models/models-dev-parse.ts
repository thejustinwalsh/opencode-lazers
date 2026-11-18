import type { ModelsDevModelRecordSchema } from "./source-schema.ts"

type ModelsDevRecord = typeof ModelsDevModelRecordSchema._output

/** Records one snapshot may hold (the evidence schema's cap). */
export const MODELS_DEV_MAX_RECORDS = 2_000

/** Providers whose lineups are always kept: the BYOK ones, whatever the install routes. */
export const MODELS_DEV_ALWAYS_PROVIDERS = ["anthropic", "openai"] as const

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown, maximum = 512) =>
  typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null

const amount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null

const flag = (value: unknown) => (typeof value === "boolean" ? value : null)

const modalities = (value: unknown) => {
  if (!Array.isArray(value)) return null
  const items = value.flatMap((item) => (text(item) ? [item as string] : []))
  return items.length ? items.slice(0, 100) : null
}

/**
 * The models.dev database (`api.json`: providers keyed by id, each with its models) reduced to
 * the fields the catalog uses. `cost` is USD per million tokens, so prices carry over unchanged.
 * The file lists thousands of gateway copies; `providers` keeps the ones this install routes
 * (plus the always-kept BYOK providers), and the rest fill what room is left, newest first.
 */
export function parseModelsDev(
  payload: unknown,
  providers: ReadonlySet<string> = new Set(),
): ModelsDevRecord[] {
  if (!isObject(payload)) throw new Error("models.dev: not an object")
  const wanted = new Set([...providers, ...MODELS_DEV_ALWAYS_PROVIDERS])
  const records: ModelsDevRecord[] = []
  for (const [providerKey, provider] of Object.entries(payload)) {
    if (!isObject(provider) || !isObject(provider.models)) continue
    const providerID = text(provider.id) ?? text(providerKey)
    if (!providerID) continue
    for (const [modelKey, value] of Object.entries(provider.models)) {
      if (!isObject(value)) continue
      const id = text(value.id) ?? text(modelKey)
      if (!id) continue
      const output = modalities(isObject(value.modalities) ? value.modalities.output : null)
      // A model whose published outputs lack text cannot do coding work.
      if (output && !output.includes("text")) continue
      const cost = isObject(value.cost) ? value.cost : null
      const limit = isObject(value.limit) ? value.limit : null
      records.push({
        kind: "models-dev-model",
        providerID,
        id,
        name: text(value.name),
        canonicalModelID: text(value.canonical_model_id),
        releaseDate: text(value.release_date, 32),
        lastUpdated: text(value.last_updated, 32),
        status: text(value.status, 64),
        contextTokens: amount(limit?.context),
        outputTokens: amount(limit?.output),
        toolCall: flag(value.tool_call),
        reasoning: flag(value.reasoning),
        inputModalities: modalities(isObject(value.modalities) ? value.modalities.input : null),
        outputModalities: output,
        prices: cost
          ? {
              unit: "USD per million tokens",
              input: amount(cost.input),
              output: amount(cost.output),
              cacheRead: amount(cost.cache_read),
              cacheWrite: amount(cost.cache_write),
            }
          : null,
      })
    }
  }
  const kept = records.filter((record) => wanted.has(record.providerID))
  const rest = records
    .filter((record) => !wanted.has(record.providerID))
    .toSorted((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""))
  return [...kept, ...rest].slice(0, MODELS_DEV_MAX_RECORDS)
}
