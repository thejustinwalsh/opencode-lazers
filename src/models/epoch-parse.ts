import { parseCSV } from "./csv.ts"
import { parseModelName } from "./name-identity.ts"
import { readZipEntries } from "./zip-reader.ts"
import type { EpochBenchmarkRecordSchema } from "./source-schema.ts"

type EpochRecord = typeof EpochBenchmarkRecordSchema._output

/**
 * The coding benchmarks read from the Epoch AI hub archive, one file each. `scale` converts the
 * file's score column to a fraction (the hub lists Aider polyglot in percent).
 */
export const EPOCH_CODING_BENCHMARKS = [
  {
    benchmarkID: "swe-bench-verified",
    benchmark: "SWE-bench Verified",
    file: "swe_bench_verified.csv",
    score: "Best score (across scorers)",
    scale: 1,
    stderr: "stderr",
    agent: null,
    effort: null,
    origin: "Epoch AI",
  },
  {
    benchmarkID: "aider-polyglot",
    benchmark: "Aider polyglot",
    file: "aider_polyglot_external.csv",
    score: "Percent correct",
    scale: 0.01,
    stderr: null,
    agent: null,
    effort: null,
    origin: "Aider LLM Leaderboards",
  },
  {
    benchmarkID: "terminal-bench",
    benchmark: "Terminal-Bench 2.0",
    file: "terminalbench_external.csv",
    score: "Accuracy mean",
    scale: 1,
    stderr: "Accuracy SE",
    agent: "Agent",
    effort: null,
    origin: "Terminal-Bench v2 Leaderboard",
  },
  {
    benchmarkID: "deepswe",
    benchmark: "DeepSWE",
    file: "deepswe_external.csv",
    score: "Pass@1",
    scale: 1,
    stderr: null,
    agent: "Harness",
    effort: "Reasoning effort",
    origin: "DeepSWE (Datacurve)",
  },
  {
    benchmarkID: "gso",
    benchmark: "GSO-Bench",
    file: "gso_external.csv",
    score: "Score OPT@1",
    scale: 1,
    stderr: null,
    agent: "Scaffold",
    effort: null,
    origin: "GSO Leaderboard",
  },
  {
    benchmarkID: "frontierswe",
    benchmark: "FrontierSWE",
    file: "frontierswe_external.csv",
    score: "Score",
    scale: 1,
    stderr: null,
    agent: "Harness",
    effort: null,
    origin: "FrontierSWE",
  },
] as const

const finite = (text: string | undefined) => {
  if (text === undefined || text.trim() === "") return null
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 ? value : null
}

const clean = (text: string | undefined) => {
  const value = (text ?? "").replace(/\s+/g, " ").trim()
  return value === "" ? null : value.slice(0, 200)
}

/** Parse the coding rows out of the hub archive; rows without a usable model id or score drop. */
export function parseEpochArchive(bytes: Uint8Array): EpochRecord[] {
  const entries = readZipEntries(bytes, new Set(EPOCH_CODING_BENCHMARKS.map((item) => item.file)))
  const records: EpochRecord[] = []
  for (const benchmark of EPOCH_CODING_BENCHMARKS) {
    const file = entries.get(benchmark.file)
    if (!file) continue
    for (const row of parseCSV(new TextDecoder().decode(file))) {
      const modelVersion = clean(row["Model version"])
      const raw = finite(row[benchmark.score])
      if (!modelVersion || raw === null) continue
      const identity = parseModelName(modelVersion)
      const score = raw * benchmark.scale
      if (score > 1.0001) continue
      records.push({
        kind: "epoch-benchmark",
        benchmarkID: benchmark.benchmarkID,
        benchmark: benchmark.benchmark,
        origin: benchmark.origin,
        modelVersion,
        modelKey: identity.key,
        effort: (benchmark.effort ? clean(row[benchmark.effort]) : null) ?? identity.effort,
        score: Math.min(score, 1),
        stderr: benchmark.stderr ? finite(row[benchmark.stderr]) : null,
        agent: benchmark.agent ? clean(row[benchmark.agent]) : null,
        releaseDate: clean(row["Release date"]),
      })
    }
  }
  return records
}
