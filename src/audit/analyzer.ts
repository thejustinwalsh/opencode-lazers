import type { DeadCodeReport, DuplicationReport, HealthReport } from "@fallow-cli/fallow-node"

/** Scope shared by every analyzer call: the root to analyse and an optional file restriction. */
export type AnalyzerScope = {
  root: string
  configPath?: string
  signal?: AbortSignal
  /** Workspace-relative or absolute paths. Omitted means the whole root. */
  files?: readonly string[]
}

/**
 * The minimum Fallow surface the review and tools need. One implementation runs the native
 * binding; a WASM module can replace it without any caller change.
 */
export interface FallowAnalyzer {
  complexity(scope: AnalyzerScope): Promise<HealthReport>
  duplication(scope: AnalyzerScope): Promise<DuplicationReport>
  deadCode(scope: AnalyzerScope): Promise<DeadCodeReport>
  /** Import cycles; the report's `circular_dependencies` lists them. Native only. */
  cycles(scope: AnalyzerScope): Promise<DeadCodeReport>
}

const NATIVE_DEFAULTS = { noCache: true, threads: 1 } as const

/** The native binding takes no abort signal; this is the one cooperative check before a call starts. */
function checkAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted()
}

/** Native `@fallow-cli/fallow-node` binding, loaded lazily so a WASM swap needs no import change. */
export const nativeFallowAnalyzer: FallowAnalyzer = {
  async complexity({ root, configPath, signal, files }) {
    checkAborted(signal)
    const fallow = await import("@fallow-cli/fallow-node")
    return fallow.computeHealth({
      ...NATIVE_DEFAULTS,
      root,
      configPath,
      css: true,
      ...(files ? { files: [...files] } : {}),
    })
  },
  async duplication({ root, configPath, signal, files }) {
    checkAborted(signal)
    const fallow = await import("@fallow-cli/fallow-node")
    return fallow.detectDuplication({
      ...NATIVE_DEFAULTS,
      root,
      configPath,
      ...(files ? { files: [...files] } : {}),
    })
  },
  async deadCode({ root, configPath, signal, files }) {
    checkAborted(signal)
    const fallow = await import("@fallow-cli/fallow-node")
    return fallow.detectDeadCode({
      ...NATIVE_DEFAULTS,
      root,
      configPath,
      ...(files ? { files: [...files] } : {}),
    })
  },
  async cycles({ root, configPath, signal, files }) {
    checkAborted(signal)
    const fallow = await import("@fallow-cli/fallow-node")
    return fallow.detectCircularDependencies({
      ...NATIVE_DEFAULTS,
      root,
      configPath,
      ...(files ? { files: [...files] } : {}),
    })
  },
}
