import type { ModelsDevModelRecordSchema } from "./source-schema.ts"

type ModelsDevRecord = typeof ModelsDevModelRecordSchema._output

/** Records one snapshot may hold (the evidence schema's cap). */
const MODELS_DEV_MAX_RECORDS = 2_000

/** Providers whose lineups are always kept: the BYOK ones, whatever the install routes. */
const MODELS_DEV_ALWAYS_PROVIDERS = ["anthropic", "openai"] as const

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
 * Collects the records of a models.dev database one provider at a time, so nothing but the
 * kept records outlives the provider being read. `kept` (the install's routed providers plus
 * the BYOK ones) stay whole; the rest compete for the room left, newest release first, and
 * only the best MODELS_DEV_MAX_RECORDS of them are ever held.
 */
class ModelsDevCollector {
  private readonly wanted: Set<string>
  private readonly kept: ModelsDevRecord[] = []
  private rest: ModelsDevRecord[] = []

  constructor(providers: ReadonlySet<string>) {
    this.wanted = new Set([...providers, ...MODELS_DEV_ALWAYS_PROVIDERS])
  }

  add(providerKey: string, provider: unknown) {
    if (!isObject(provider) || !isObject(provider.models)) return
    const providerID = text(provider.id) ?? text(providerKey)
    if (!providerID) return
    const target = this.wanted.has(providerID) ? this.kept : this.rest
    for (const [modelKey, value] of Object.entries(provider.models)) {
      if (!isObject(value)) continue
      const id = text(value.id) ?? text(modelKey)
      if (!id) continue
      const output = modalities(isObject(value.modalities) ? value.modalities.output : null)
      // A model whose published outputs lack text cannot do coding work.
      if (output && !output.includes("text")) continue
      const cost = isObject(value.cost) ? value.cost : null
      const limit = isObject(value.limit) ? value.limit : null
      target.push({
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
    // A stable sort of the suffix-pruned list keeps exactly the records a full stable sort of
    // everything would keep in its first MODELS_DEV_MAX_RECORDS places.
    if (this.rest.length > MODELS_DEV_MAX_RECORDS * 2) this.rest = newestFirst(this.rest)
  }

  records(): ModelsDevRecord[] {
    return [...this.kept, ...newestFirst(this.rest)].slice(0, MODELS_DEV_MAX_RECORDS)
  }
}

const newestFirst = (records: ModelsDevRecord[]) =>
  records
    .toSorted((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""))
    .slice(0, MODELS_DEV_MAX_RECORDS)

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
  const collector = new ModelsDevCollector(providers)
  for (const [providerKey, provider] of Object.entries(payload))
    collector.add(providerKey, provider)
  return collector.records()
}

/**
 * The same reduction from the response text as it arrives. The top-level object is split into its
 * providers as the text streams in; each provider is parsed, reduced and dropped before the next
 * is read, so the 24 MB body is never held as one string nor as one parsed object. `chunks` is the
 * decoded text in any split; the caller awaits between chunks, which yields the event loop.
 */
export async function parseModelsDevStream(
  chunks: AsyncIterable<string>,
  providers: ReadonlySet<string> = new Set(),
): Promise<ModelsDevRecord[]> {
  const collector = new ModelsDevCollector(providers)
  let depth = 0
  let inString = false
  let escaped = false
  let started = false
  let finished = false
  /** Pieces of the member being read (`"key": value`), from the object's start or last comma. */
  let member: string[] = []
  const flush = (piece: string) => {
    const source = (member.join("") + piece).trim()
    member = []
    if (!source) return
    const parsed = JSON.parse(`{${source}}`) as Record<string, unknown>
    for (const [providerKey, provider] of Object.entries(parsed))
      collector.add(providerKey, provider)
  }
  for await (const chunk of chunks) {
    let from = 0
    for (let at = 0; at < chunk.length; at++) {
      const code = chunk.charCodeAt(at)
      if (finished) {
        if (code > 32) throw new Error("models.dev: trailing data")
        continue
      }
      if (!started) {
        if (code === 123) {
          started = true
          depth = 1
          from = at + 1
        } else if (code > 32 && code !== 0xfeff) throw new Error("models.dev: not an object")
        continue
      }
      if (inString) {
        if (escaped) escaped = false
        else if (code === 92) escaped = true
        else if (code === 34) inString = false
        continue
      }
      if (code === 34) inString = true
      else if (code === 123 || code === 91) depth++
      else if (code === 125 || code === 93) {
        depth--
        if (depth === 0) {
          flush(chunk.slice(from, at))
          from = at + 1
          finished = true
        }
      } else if (code === 44 && depth === 1) {
        flush(chunk.slice(from, at))
        from = at + 1
      }
    }
    if (started && !finished) member.push(chunk.slice(from))
  }
  if (!started || !finished || inString) throw new Error("models.dev: truncated")
  return collector.records()
}
