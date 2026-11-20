import type { AnalysisPriority } from "./analysis-scheduler.ts"
import type { DeadCodeReport, DuplicationReport, HealthReport } from "./fallow-types.ts"

/** Scope shared by every analyzer call: the root to analyse and an optional file restriction. */
export type AnalyzerScope = {
  root: string
  configPath?: string
  signal?: AbortSignal
  /**
   * Another checkout of the same project whose `.fallow` cache seeds this root's when it has
   * none. Entries are keyed by content, so a file that differs is simply parsed.
   */
  cacheSeed?: string
  /** The canonical checkout that receives this root's cache after a run, for later worktrees. */
  cachePublish?: string
  /**
   * The time limit of the call, from the moment it is queued to its answer. Overrides the default.
   */
  timeoutMs?: number
  /** Who is waiting: tool calls by default, then verification, then background reports. */
  priority?: AnalysisPriority
  /** Workspace-relative or absolute paths. Omitted means the whole root. */
  files?: readonly string[]
}

/** One changed-code audit: `root` (the candidate, with its uncommitted edits) against `base`. */
export type AuditScope = Omit<AnalyzerScope, "files"> & {
  /** The commit the change is measured against. */
  base: string
  /** A directory holding the tree of `base`; the module reads it and never writes it. */
  baseRoot: string
}

/** The Fallow surface the review and tools need. `wasmFallowAnalyzer` implements it. */
export interface FallowAnalyzer {
  complexity(scope: AnalyzerScope): Promise<HealthReport>
  duplication(scope: AnalyzerScope): Promise<DuplicationReport>
  deadCode(scope: AnalyzerScope): Promise<DeadCodeReport>
  /** Import cycles; the report's `circular_dependencies` lists them. */
  cycles(scope: AnalyzerScope): Promise<DeadCodeReport>
  /** The engine's own `fallow audit`: attribution, verdict and diff-risk rules are Fallow's. */
  audit(scope: AuditScope): Promise<unknown>
  /** Detected plugins, entry points and workspaces (`fallow list`), for config suggestions. */
  projectInfo(scope: AnalyzerScope): Promise<Record<string, unknown>>
}
