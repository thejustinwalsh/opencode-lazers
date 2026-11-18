import type { ModelCandidate } from "./comparison-state.ts"
import { EPOCH_ATTRIBUTION } from "./source-schema.ts"

/**
 * Which public score ranks the catalog. Two families exist and their scales differ, so one basis
 * is chosen for the whole set, never mixed row by row:
 *
 *   Artificial Analysis Coding Index   from OpenRouter benchmark access (exact slug or name match)
 *   Epoch AI benchmark                 keyless; one coding benchmark, the best covered
 *
 * The basis with the larger coverage among the loaded models wins; a tie keeps the Coding Index.
 */
export type ScoreBasis =
  | { source: "artificial-analysis"; label: "Coding index"; caption: string; benchmarkID: null }
  | {
      source: "epoch"
      /** e.g. "SWE-bench Verified (%)": the axis and column title. */
      label: string
      /** The source line, with attribution. */
      caption: string
      benchmarkID: string
    }

/** Preference between equally covered Epoch benchmarks: the software-engineering one first. */
const EPOCH_BENCHMARK_ORDER = [
  "swe-bench-verified",
  "aider-polyglot",
  "terminal-bench",
  "deepswe",
  "gso",
  "frontierswe",
]

/** The preferred benchmark keeps the lead while it reaches at least this share of the best's coverage. */
const PREFERRED_COVERAGE_SHARE = 0.8

export const AA_BASIS: ScoreBasis = {
  source: "artificial-analysis",
  label: "Coding index",
  caption: "Artificial Analysis Coding Index",
  benchmarkID: null,
}

type Route = { providerID: string; modelID: string }
const routeKey = (route: Route) => `${route.providerID}\u0000${route.modelID}`

/** The route's best score on one Epoch benchmark, as a percent; the rows behind it. */
export function epochScore(candidate: ModelCandidate, benchmarkID: string) {
  const rows = (candidate.publicBenchmarks ?? []).filter((row) => row.benchmarkID === benchmarkID)
  if (!rows.length) return null
  const best = rows.reduce((left, right) => (right.score > left.score ? right : left))
  return { value: Math.round(best.score * 1000) / 10, best, rows }
}

export type ScoreChoice = {
  basis: ScoreBasis
  /** Routes with an Artificial Analysis score. */
  aaRoutes: number
  /** Routes with a score, per Epoch benchmark. */
  epochRoutes: Record<string, number>
}

export function chooseScoreBasis(candidates: readonly ModelCandidate[]): ScoreChoice {
  const aa = new Set<string>()
  const epoch = new Map<string, Set<string>>()
  for (const candidate of candidates) {
    const key = routeKey(candidate.identity)
    if (
      candidate.benchmarkCorrespondence.status === "exact" &&
      candidate.externalBenchmark?.codingIndex != null
    )
      aa.add(key)
    for (const row of candidate.publicBenchmarks ?? [])
      epoch.set(row.benchmarkID, (epoch.get(row.benchmarkID) ?? new Set()).add(key))
  }
  const epochRoutes = Object.fromEntries([...epoch].map(([id, keys]) => [id, keys.size]))
  const order = (id: string) => {
    const at = EPOCH_BENCHMARK_ORDER.indexOf(id)
    return at < 0 ? EPOCH_BENCHMARK_ORDER.length : at
  }
  const ranked = Object.entries(epochRoutes).toSorted(
    ([a, left], [b, right]) => right - left || order(a) - order(b),
  )
  // SWE-bench Verified is the recognised software-engineering score: it leads unless another
  // benchmark covers clearly more of the loaded models.
  const preferred = ranked.find(([id]) => id === EPOCH_BENCHMARK_ORDER[0])
  const best =
    preferred && preferred[1] >= (ranked[0]?.[1] ?? 0) * PREFERRED_COVERAGE_SHARE
      ? preferred
      : ranked[0]
  if (best && best[1] > aa.size) {
    const name =
      candidates.flatMap((c) => c.publicBenchmarks ?? []).find((row) => row.benchmarkID === best[0])
        ?.benchmark ?? best[0]
    return {
      basis: {
        source: "epoch",
        label: `${name} (%)`,
        caption: `${name} · ${EPOCH_ATTRIBUTION}`,
        benchmarkID: best[0],
      },
      aaRoutes: aa.size,
      epochRoutes,
    }
  }
  return { basis: AA_BASIS, aaRoutes: aa.size, epochRoutes }
}

/** A route's score on the chosen basis: the value, and what it is called. */
export function scoreOn(candidate: ModelCandidate, basis: ScoreBasis) {
  if (basis.source === "epoch") {
    const score = epochScore(candidate, basis.benchmarkID!)
    return score
      ? {
          value: score.value,
          displayName: score.best.modelVersion,
          permaslug: score.best.modelVersion,
        }
      : null
  }
  const external = candidate.externalBenchmark
  if (
    candidate.benchmarkCorrespondence.status !== "exact" ||
    !external ||
    external.codingIndex === null
  )
    return null
  return {
    value: external.codingIndex,
    displayName: external.displayName,
    permaslug: external.modelPermaslug,
  }
}
