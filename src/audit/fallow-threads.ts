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
 * What shows that threads cannot be used here, as opposed to one analysis failing: the threaded
 * module could not be loaded or compiled, this runtime has no shared memory, or the module
 * does not instantiate against it. Any other error belongs to the analysis that raised it.
 */
export class ThreadsUnsupported extends Error {}

function showsThreadsUnsupported(error: unknown): boolean {
  return (
    error instanceof ThreadsUnsupported ||
    error instanceof WebAssembly.CompileError ||
    error instanceof WebAssembly.LinkError
  )
}

/**
 * Chooses the module for each call. "off" never loads the threaded module. "on" tries it. If the
 * threaded module cannot be loaded, or the runtime shows it cannot run it (`ThreadsUnsupported`,
 * a compile or link error), the call runs on the single-threaded module and every later call stays
 * there. Any other error, a trap or a failed allocation included, fails that call alone: threads
 * stay on for the next one, and the error reaches the caller.
 */
export class FallowModules {
  private disabled: string | undefined
  private threaded: Promise<WebAssembly.Module> | undefined
  private singleModule: Promise<WebAssembly.Module> | undefined

  constructor(
    private readonly single: ModuleLoader,
    private readonly loadThreaded: ModuleLoader,
  ) {}

  /** Why the threaded module is off for the rest of this process, if it is. */
  get disabledReason(): string | undefined {
    return this.disabled
  }

  private disable(error: unknown): string {
    this.disabled = error instanceof Error ? error.message : String(error)
    return this.disabled
  }

  async execute<T>(
    mode: FallowThreads,
    run: (module: WebAssembly.Module, threads: number) => T,
  ): Promise<Executed<T>> {
    let fallback: string | undefined
    if (mode === "on" && this.disabled === undefined) {
      let module: WebAssembly.Module | undefined
      try {
        this.threaded ??= this.loadThreaded()
        module = await this.threaded
      } catch (error) {
        fallback = this.disable(error)
      }
      if (module) {
        try {
          return { result: run(module, MAX_FALLOW_THREADS) }
        } catch (error) {
          if (!showsThreadsUnsupported(error)) throw error
          fallback = this.disable(error)
        }
      }
    }
    // Compiled once: the single-threaded module is 24 MB of wasm, and a rejected load is retried.
    this.singleModule ??= this.single().catch((error) => {
      this.singleModule = undefined
      throw error
    })
    const result = run(await this.singleModule, 1)
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
