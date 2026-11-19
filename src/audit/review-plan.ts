import { isAbsolute, relative } from "node:path"
import type { DeadCodeReport } from "./fallow-types.ts"
import { attributeCycles, cycleKey } from "./attribution.ts"
import type { AnalyzerScope, FallowAnalyzer } from "./analyzer.ts"
import {
  cleanupResolvedFallowConfig,
  resolveFallowConfig,
  type ResolvedFallowConfig,
} from "./config.ts"
import { materialiseBaseArchive } from "./review-git.ts"
import {
  fallowReview,
  newDeadCodeFindings,
  withTimeout,
  type FallowReviewInput,
  type FallowReviewResult,
  type Finding,
} from "./review.ts"
import { defaultFallowAnalyzer } from "./wasm-analyzer.ts"

/** Whole-tree dead code and cycle scans are slower than the changed-file review. */
const STRUCTURE_TIMEOUT_MS = 120_000
const CYCLE_MEMBER_LIMIT = 5

function cycleFinding(files: readonly string[]): Finding {
  const members = [...new Set(files)].sort()
  return {
    id: `cycle:${cycleKey(members)}`,
    check: "cycle",
    status: "introduced",
    file: members[0]!,
    line: 1,
    subject: `${members.length} files import each other: ${members.join(", ")}`,
    others: members.slice(1, CYCLE_MEMBER_LIMIT + 1).map((file) => ({ file, line: 1, endLine: 1 })),
    fix: "Break the cycle: move what the files share into a module that both import.",
  }
}

function cycleMembers(report: DeadCodeReport, root: string): string[][] {
  return report.circular_dependencies.map((cycle) =>
    cycle.files.map((file) => (isAbsolute(file) ? relative(root, file) : file)),
  )
}

/** Resolves to `undefined` when native analysis fails; extras are omitted, never reported as zero. */
async function attempt<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await withTimeout(run, STRUCTURE_TIMEOUT_MS)
  } catch {
    return undefined
  }
}

type ScopeFor = (root: string) => AnalyzerScope
type Roots = { candidate: string; base: string }

async function deadCodeConcerns(
  analyzer: FallowAnalyzer,
  scope: ScopeFor,
  roots: Roots,
): Promise<Finding[]> {
  const reports = await attempt(() =>
    Promise.all([analyzer.deadCode(scope(roots.candidate)), analyzer.deadCode(scope(roots.base))]),
  )
  return reports ? newDeadCodeFindings(reports[1], reports[0]) : []
}

async function cycleConcerns(
  analyzer: FallowAnalyzer,
  scope: ScopeFor,
  roots: Roots,
): Promise<Finding[]> {
  const reports = await attempt(() =>
    Promise.all([analyzer.cycles(scope(roots.candidate)), analyzer.cycles(scope(roots.base))]),
  )
  if (!reports) return []
  const introduced = attributeCycles(
    cycleMembers(reports[1], roots.base),
    cycleMembers(reports[0], roots.candidate),
  )
  return introduced.map(cycleFinding)
}

async function structureConcerns(
  input: FallowReviewInput,
  analyzer: FallowAnalyzer,
  resolved: ResolvedFallowConfig,
): Promise<Finding[]> {
  const base = await materialiseBaseArchive(input.workspace, input.baseCommit).catch(
    () => undefined,
  )
  if (!base) return []
  try {
    const scope = (root: string) => ({
      root,
      configPath: resolved.configPath,
      signal: input.signal,
      ...(root === input.workspace
        ? {
            cacheSeed: input.repository.projectDirectory,
            cachePublish: input.repository.projectDirectory,
          }
        : { cacheSeed: input.workspace }),
    })
    const roots: Roots = { candidate: input.workspace, base: base.directory }
    const dead = resolved.deadCodeEnabled ? await deadCodeConcerns(analyzer, scope, roots) : []
    return [...dead, ...(await cycleConcerns(analyzer, scope, roots))]
  } finally {
    await base.cleanup()
  }
}

/**
 * Fallow review of a combined plan artifact against the plan's base commit. Complexity and
 * duplication come from the task review's rules, applied to the whole combined change, so a
 * clone between two tasks is found. Dead code (when the config enables it) and import cycles
 * introduced since the base are concerns only, and are omitted when the native binding cannot
 * run them.
 */
export async function fallowPlanReview(input: FallowReviewInput): Promise<FallowReviewResult> {
  const analyzer = input.analyzer ?? defaultFallowAnalyzer
  const review = await fallowReview({ ...input, analyzer, deadCode: false })
  if (review.status === "unavailable") return review
  let resolved: ResolvedFallowConfig | undefined
  try {
    resolved = await resolveFallowConfig({
      directory: input.workspace,
      baseCommit: input.baseCommit,
      repository: input.repository,
    })
    const extra = await structureConcerns(input, analyzer, resolved)
    const concerns = [...review.concerns, ...extra]
    return {
      ...review,
      concerns,
      status: review.introduced.length + concerns.length === 0 ? "clean" : "findings",
    }
  } catch {
    return review
  } finally {
    if (resolved) await cleanupResolvedFallowConfig(resolved)
  }
}
