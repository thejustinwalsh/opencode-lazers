import { MAX_FALLOW_THREADS } from "./fallow-wasi.ts"

/**
 * The `fallowThreads` plugin option: whether Fallow analyses run on the threaded WebAssembly
 * module (a pool of `MAX_FALLOW_THREADS`) or on the single-threaded one. On by default; anything
 * but "off" is "on".
 */
export type FallowThreads = "on" | "off"

export const parseFallowThreads = (value: unknown): FallowThreads =>
  value === "off" ? "off" : "on"

export type ModuleLoader = () => Promise<WebAssembly.Module>

export type Executed<T> = {
  result: T
  /** Set when the threaded module could not be used for this call, with the reason. */
  fallback?: string
}

/**
 * Chooses the module for each call. "off" never loads the threaded module. "on" tries it, and if
 * it cannot be loaded or a threaded call traps, runs the call on the single-threaded module and
 * stays on that module for every later call, so analysis never fails because threads did.
 */
export class FallowModules {
  private disabled: string | undefined
  private threaded: Promise<WebAssembly.Module> | undefined

  constructor(
    private readonly single: ModuleLoader,
    private readonly loadThreaded: ModuleLoader,
  ) {}

  /** Why the threaded module is off for the rest of this process, if it is. */
  get disabledReason(): string | undefined {
    return this.disabled
  }

  async execute<T>(
    mode: FallowThreads,
    run: (module: WebAssembly.Module, threads: number) => T,
  ): Promise<Executed<T>> {
    let fallback: string | undefined
    if (mode === "on" && this.disabled === undefined) {
      try {
        this.threaded ??= this.loadThreaded()
        return { result: run(await this.threaded, MAX_FALLOW_THREADS) }
      } catch (error) {
        fallback = error instanceof Error ? error.message : String(error)
        this.disabled = fallback
      }
    }
    const result = run(await this.single(), 1)
    return fallback === undefined ? { result } : { result, fallback }
  }
}

/** Shared memory and atomic waits, which the threaded module needs, work in this runtime. */
export function sharedMemoryAvailable(): boolean {
  try {
    new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })
    return typeof Atomics.wait === "function" && typeof SharedArrayBuffer === "function"
  } catch {
    return false
  }
}
