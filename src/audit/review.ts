import type { TaskRepository } from "../storage.ts"
import type { SourceDefinition } from "../context/repo-map.ts"
import { activeProfile } from "../projects/profile-store.ts"
import { buildPackage, DEFAULT_MAX_CRAP, notChecked } from "./audit-findings.ts"
import type { FallowPackage, FallowReviewOutput } from "./contract.ts"
import { staleSuppressionsIntroduced, withExtraFindings } from "./suppression-flow.ts"
import type { FallowFinding } from "./contract.ts"
import { parseEngineAudit, type EngineAudit } from "./engine-audit.ts"
import type { FallowAnalyzer } from "./analyzer.ts"
import { defaultFallowAnalyzer } from "./wasm-analyzer.ts"
import {
  cleanupResolvedFallowConfig,
  resolveFallowConfig,
  thresholdsFrom,
  type ResolvedFallowConfig,
} from "./config.ts"
import { addedRangesForFiles, changedAuditFiles, materialiseBaseArchive } from "./review-git.ts"

/** Two whole-project analyses (head and base) share one call; a large repository needs the time. */
const AUDIT_TIMEOUT_MS = 180_000

/** The typed review result: status, and the one `FallowPackage` of the audit (see contract.ts). */
export type FallowReviewResult = FallowReviewOutput

export type FallowReviewInput = {
  /** The checkout holding the candidate: its working tree is what is audited. */
  workspace: string
  baseCommit: string
  /** The candidate's commit. The audit reads the workspace, which holds exactly this tree. */
  artifact: string
  repository: TaskRepository
  analyzer?: FallowAnalyzer
  signal?: AbortSignal
  /** Which changes matter; defaults to the active profile's `source`, else today's filter. */
  source?: SourceDefinition
}

export async function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: analyzer call exceeded ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([run(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function maxCrapFrom(config: object | null): number {
  const health = (config as { health?: Record<string, unknown> } | null)?.health
  return typeof health?.maxCrap === "number" ? health.maxCrap : DEFAULT_MAX_CRAP
}

async function auditReport(
  input: FallowReviewInput,
  analyzer: FallowAnalyzer,
  resolved: ResolvedFallowConfig,
): Promise<{ report: EngineAudit; stale: FallowFinding[] }> {
  const base = await materialiseBaseArchive(input.workspace, input.baseCommit)
  try {
    const raw = await withTimeout(
      () =>
        analyzer.audit({
          root: input.workspace,
          configPath: resolved.configPath,
          base: input.baseCommit,
          baseRoot: base.directory,
          signal: input.signal,
          timeoutMs: AUDIT_TIMEOUT_MS,
          // The runner's review gates a task: it waits behind tool calls only.
          priority: "verification",
          // The candidate starts from the project's cache and leaves its own there; the base tree
          // starts from the candidate's, because nearly every file is the same.
          cacheSeed: input.repository.projectDirectory,
          cachePublish: input.repository.projectDirectory,
        }),
      AUDIT_TIMEOUT_MS + 5_000,
    )
    const report = parseEngineAudit(raw)
    // Dead code stays on: the consumer of code added ahead of it must be told to drop the comment.
    const stale = report.summary.dead_code_skipped
      ? []
      : await withTimeout(
          () =>
            staleSuppressionsIntroduced({
              analyzer,
              workspace: input.workspace,
              base: input.baseCommit,
              configPath: resolved.configPath,
              cacheSeed: input.repository.projectDirectory,
              signal: input.signal,
              timeoutMs: AUDIT_TIMEOUT_MS,
              priority: "verification",
            }),
          AUDIT_TIMEOUT_MS + 5_000,
        )
    return { report, stale }
  } finally {
    await base.cleanup()
  }
}

function configOf(resolved: ResolvedFallowConfig): FallowPackage["config"] {
  return {
    source: resolved.source,
    ...(resolved.sha256 ? { sha256: resolved.sha256 } : {}),
    classesNotChecked: [],
  }
}

/** A change that touches no file the audit reads: nothing to compare. */
function untouchedPackage(resolved: ResolvedFallowConfig, base: string): FallowPackage {
  return {
    verdict: "pass",
    base,
    config: configOf(resolved),
    thresholds: thresholdsFrom(resolved.config),
    findings: [],
    summary: { errors: 0, warnings: 0, inherited: 0 },
    timings: { elapsedMs: 0 },
  }
}

/**
 * The per-pull-request check of Fallow, `fallow audit`, on a candidate against its base commit.
 * The engine runs the audit itself, in the WebAssembly module: changed files only, the dead code,
 * complexity, duplication and diff-risk analyses, each finding attributed introduced, worsened or
 * inherited against the base tree. The result is one validated `FallowPackage`. Any analyzer, git
 * or schema error is reported as `unavailable`, never thrown.
 */
export async function fallowReview(input: FallowReviewInput): Promise<FallowReviewResult> {
  const analyzer = input.analyzer ?? defaultFallowAnalyzer
  let resolved: ResolvedFallowConfig | undefined
  try {
    resolved = await resolveFallowConfig({
      directory: input.workspace,
      baseCommit: input.baseCommit,
      repository: input.repository,
    })
    const source =
      input.source ??
      activeProfile(input.repository, input.repository.projectDirectory)?.profile.source
    const changed = await changedAuditFiles(input.workspace, input.baseCommit, source)
    if (changed.length === 0)
      return { status: "clean", package: untouchedPackage(resolved, input.baseCommit) }
    const [{ report, stale }, added] = await Promise.all([
      auditReport(input, analyzer, resolved),
      addedRangesForFiles(input.workspace, input.baseCommit, changed),
    ])
    const config = configOf(resolved)
    config.classesNotChecked.push(...notChecked(report))
    const built = buildPackage(report, {
      thresholds: thresholdsFrom(resolved.config),
      maxCrap: maxCrapFrom(resolved.config),
      changed: new Set(changed),
      added,
      config,
    })
    const pkg = withExtraFindings(built, stale)
    return {
      status: pkg.summary.errors + pkg.summary.warnings === 0 ? "clean" : "findings",
      package: pkg,
    }
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) }
  } finally {
    if (resolved) await cleanupResolvedFallowConfig(resolved)
  }
}
