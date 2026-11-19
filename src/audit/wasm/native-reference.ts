import type { FallowAnalyzer } from "../analyzer.ts"
import type { DeadCodeReport, DuplicationReport, HealthReport } from "../fallow-types.ts"

/**
 * The native `@fallow-cli/fallow-node` binding, for parity tests only. It is a dev dependency:
 * nothing under `src/` outside tests loads it, and the specifier is not statically typed so
 * `bun check` passes without the package installed.
 */
const specifier: string = "@fallow-cli/fallow-node"

export type NativeFallow = Record<string, (options: Record<string, unknown>) => Promise<unknown>>

/** The binding, or undefined when the package is not installed. */
export async function loadNativeFallow(): Promise<NativeFallow | undefined> {
  try {
    return (await import(specifier)) as NativeFallow
  } catch {
    return undefined
  }
}

const DEFAULTS = { noCache: true, threads: 1 } as const

/** A `FallowAnalyzer` backed by the native binding. */
export function nativeFallowAnalyzer(fallow: NativeFallow): FallowAnalyzer {
  const common = ({ root, configPath, files }: Parameters<FallowAnalyzer["deadCode"]>[0]) => ({
    ...DEFAULTS,
    root,
    configPath,
    ...(files ? { files: [...files] } : {}),
  })
  return {
    complexity: (scope) =>
      fallow.computeHealth!({ ...common(scope), css: true }) as Promise<HealthReport>,
    duplication: (scope) => fallow.detectDuplication!(common(scope)) as Promise<DuplicationReport>,
    deadCode: (scope) => fallow.detectDeadCode!(common(scope)) as Promise<DeadCodeReport>,
    cycles: (scope) => fallow.detectCircularDependencies!(common(scope)) as Promise<DeadCodeReport>,
  }
}
