import {
  StructuralCompareRequestSchema,
  StructuralComparisonInputSchema,
  StructuralComparisonResultSchema,
  type StructuralComparisonInput,
  type StructuralComparisonResult,
} from "./contract.ts"
import { compareStructural } from "./worker-client.ts"

type ActiveComparison = {
  controller: AbortController
}

type CompareOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}

function validateCompareOptions(options: CompareOptions): void {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
  )
    throw new RangeError("timeoutMs must be a positive safe integer")
  if (options.signal?.aborted)
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new DOMException("Structural diff was cancelled", "AbortError")
}

function latestResult(
  activeComparisons: Map<string, ActiveComparison>,
  key: string,
  active: ActiveComparison,
  identity: StructuralComparisonInput["identity"],
  diff: Awaited<ReturnType<typeof compareStructural>>,
): StructuralComparisonResult | undefined {
  if (activeComparisons.get(key) !== active) return undefined
  return StructuralComparisonResultSchema.parse({ identity, diff })
}

function latestError(
  activeComparisons: Map<string, ActiveComparison>,
  key: string,
  active: ActiveComparison,
  error: unknown,
): undefined {
  if (activeComparisons.get(key) !== active) return undefined
  throw error
}

/**
 * Runs one structural comparison per active identity. A newer source for the same comparison
 * aborts the old worker and never returns its result to the producer.
 */
export class StructuralDiffService {
  private readonly active = new Map<string, ActiveComparison>()

  async compare(
    input: StructuralComparisonInput,
    options: CompareOptions = {},
  ): Promise<StructuralComparisonResult | undefined> {
    const comparison = StructuralComparisonInputSchema.parse(input)
    const request = StructuralCompareRequestSchema.parse(comparison.request)
    validateCompareOptions(options)

    const key = JSON.stringify([comparison.identity.comparisonID, request.path])
    const active: ActiveComparison = { controller: new AbortController() }
    this.active.get(key)?.controller.abort()
    this.active.set(key, active)

    const abortFromCaller = () => active.controller.abort(options.signal?.reason)
    options.signal?.addEventListener("abort", abortFromCaller, { once: true })
    try {
      const diff = await compareStructural(request, {
        signal: active.controller.signal,
        timeoutMs: options.timeoutMs,
      })
      return latestResult(this.active, key, active, comparison.identity, diff)
    } catch (error) {
      return latestError(this.active, key, active, error)
    } finally {
      options.signal?.removeEventListener("abort", abortFromCaller)
      if (this.active.get(key) === active) this.active.delete(key)
    }
  }
}

export function createStructuralDiffService(): StructuralDiffService {
  return new StructuralDiffService()
}
