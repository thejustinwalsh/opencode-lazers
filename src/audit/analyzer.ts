import type { DeadCodeReport, DuplicationReport, HealthReport } from "./fallow-types.ts"

/** Scope shared by every analyzer call: the root to analyse and an optional file restriction. */
export type AnalyzerScope = {
  root: string
  configPath?: string
  signal?: AbortSignal
  /** Overrides the default per-call time limit. */
  timeoutMs?: number
  /** Workspace-relative or absolute paths. Omitted means the whole root. */
  files?: readonly string[]
}

/** The Fallow surface the review and tools need. `wasmFallowAnalyzer` implements it. */
export interface FallowAnalyzer {
  complexity(scope: AnalyzerScope): Promise<HealthReport>
  duplication(scope: AnalyzerScope): Promise<DuplicationReport>
  deadCode(scope: AnalyzerScope): Promise<DeadCodeReport>
  /** Import cycles; the report's `circular_dependencies` lists them. */
  cycles(scope: AnalyzerScope): Promise<DeadCodeReport>
}
