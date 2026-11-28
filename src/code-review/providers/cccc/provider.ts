import { ccccFailure } from "./provider-result.ts"
import {
  analyzeComparisonSources,
  collectComparisonSources,
  compareAnalyzedSources,
  prepareComparison,
} from "./provider-stages.ts"
import { ccccSettings } from "./settings.ts"
import type { CcccProviderOptions, CcccProviderResult, CcccSnapshotReader } from "./types.ts"

const NEVER_ABORTED = new AbortController().signal

/** Analyze one immutable, captured comparison. Source text is consumed only by the WASM worker. */
export async function analyzeCcccComparison(
  reader: CcccSnapshotReader,
  comparisonID: string,
  options: CcccProviderOptions = {},
): Promise<CcccProviderResult> {
  const signal = options.signal ?? NEVER_ABORTED
  let settings
  try {
    settings = ccccSettings(options.settings)
  } catch {
    return ccccFailure(comparisonID, "invalid-settings")
  }
  const prepared = await prepareComparison(reader, comparisonID, signal)
  if (prepared.status === "failed") return prepared.result
  const sources = await collectComparisonSources(reader, prepared.value, signal)
  if (sources.status === "failed") return sources.result
  const analyzed = await analyzeComparisonSources(reader, options, settings, sources.value, signal)
  if (analyzed.status === "failed") return analyzed.result
  const compared = await compareAnalyzedSources(reader, analyzed.value, settings, signal)
  return compared.status === "failed" ? compared.result : compared.value
}
