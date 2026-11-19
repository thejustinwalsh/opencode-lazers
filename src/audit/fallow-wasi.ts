import { lstatSync, realpathSync } from "node:fs"
import { join, normalize, sep } from "node:path"
import { WASI } from "node:wasi"
import { Worker } from "node:worker_threads"
import { workerURL } from "../worker-url.ts"

/**
 * Host for the Fallow WebAssembly module (a `wasm32-wasip1` command, `crates/fallow-wasm`).
 *
 * The module reads the project through WASI preview 1 calls. This host gives it:
 *  - one preopened directory per root (the project root, plus roots the caller names), served
 *    by Bun's `node:wasi`, which refuses paths and symlinks that leave a preopen;
 *  - no write path: every write-capable import is replaced by one that returns EROFS, so the
 *    analysed tree is never modified, no `.fallow/` cache included;
 *  - stdin, stdout and stderr as in-memory buffers (the request, the JSON report, diagnostics);
 *  - a fixed random seed, so output is deterministic;
 *  - `lazers_host.git_run`: read-only `git` invocations the engine asks for (churn, HEAD),
 *    run here because a module cannot spawn a process.
 * There is no network, no process other than that `git` call, and no environment.
 */
export type WasiRequest = Record<string, unknown> & { op: string; root: string }

export type WasiOutcome = { stdout: string; stderr: string; exitCode: number | undefined }

export type GitCall = { cwd: string; args: string[]; env: Record<string, string | null> }

/** Thrown by the `proc_exit` import: Bun's own `proc_exit` would end the whole process. */
class WasiExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

/**
 * The size of the allocation that failed when a trap's stderr says the module ran out of linear
 * memory (a wasm32 module has 4 GiB at most), else undefined.
 */
export function memoryExhausted(stderr: string): number | undefined {
  const match = /memory allocation of (\d+) bytes failed/.exec(stderr)
  return match ? Number(match[1]) : undefined
}

export class WasiTrap extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message)
  }
}

/** Size cap of the cache file, in MB; Fallow evicts the least recently seen entries beyond it. */
export const FALLOW_CACHE_MAX_MB = 128

const ERRNO_ROFS = 69
const ERRNO_BADF = 8
// Rights that only a writer asks for (wasi preview 1 `rights`): FD_WRITE, FD_ALLOCATE and
// FD_FILESTAT_SET_SIZE. A read-only open never needs them.
const WRITE_RIGHTS = (1n << 6n) | (1n << 8n) | (1n << 22n)
const OFLAGS_CREAT = 1
const OFLAGS_EXCL = 4
const OFLAGS_TRUNC = 8
const FDFLAGS_APPEND = 1

/** Imports that can change the tree. Each returns EROFS. */
const WRITE_IMPORTS = [
  "path_create_directory",
  "path_unlink_file",
  "path_remove_directory",
  "path_rename",
  "path_symlink",
  "path_link",
  "path_filestat_set_times",
  "fd_pwrite",
  "fd_allocate",
  "fd_filestat_set_size",
  "fd_filestat_set_times",
  "fd_datasync",
  "fd_sync",
] as const

/** Git subcommands that only read. Anything else is refused as if git were not installed. */
const GIT_READ_ONLY = new Set([
  "rev-parse",
  "log",
  "merge-base",
  "diff",
  "ls-files",
  "ls-tree",
  "show",
  "cat-file",
  "rev-list",
  "for-each-ref",
  "status",
  "describe",
  "name-rev",
  "show-ref",
  "symbolic-ref",
])
const GIT_ENV_DROP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
]
const GIT_TIMEOUT_MS = 30_000

const decoder = new TextDecoder()

const inside = (path: string, roots: readonly string[]) =>
  roots.some((root) => path === root || path.startsWith(root + sep))

/** The git subcommand after leading `-c key=value` and `--no-pager` style options, if allowed. */
function gitSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "-c") {
      i++
      continue
    }
    if (arg.startsWith("-")) continue
    return GIT_READ_ONLY.has(arg) ? arg : undefined
  }
  return undefined
}

/** Observes every import call after it ran, with the module's memory (measurement only). */
export type HostTrace = (
  name: string,
  args: readonly unknown[],
  result: unknown,
  memory: WebAssembly.Memory,
) => void

export type RunOptions = {
  /** Measurement only: called after every host import. */
  trace?: HostTrace
  /** Measurement only: called with the instance once it exists. */
  onInstance?: (instance: WebAssembly.Instance) => void
  /**
   * Let the module write Fallow's cache, and nothing else: `<root>/.fallow` (never a link).
   * Everything outside it stays read-only.
   */
  cache?: boolean
  /** Extra directories to preopen, read-only. Each must exist. */
  extraRoots?: readonly string[]
  /** Observe each git call that was allowed to run (tests, diagnostics). */
  onGit?: (call: GitCall) => void
  /**
   * Threaded modules only: how many helper threads the module may start, normally the size of
   * its rayon pool (at most `MAX_FALLOW_THREADS`). A thread costs a Bun worker, and the engine
   * also tries a thread per file where it can fall back to running in place, so further spawns
   * are refused.
   */
  maxThreads?: number
  /** Threaded modules only: observe each spawn request and whether it was granted. */
  onSpawn?: (granted: boolean) => void
  /** Threaded modules only: the worker script a helper thread runs. Defaults to `fallow-thread`. */
  threadScript?: URL
  /** Threaded modules only: helper workers kept between runs. Without it each run starts its own. */
  threadPool?: ThreadPool
}

type Helper = { worker: Worker; flag: Int32Array }
const HELPER_RUNNING = 0
const HELPER_DONE = 1
const HELPER_WAIT_MS = 100

/**
 * Helper workers of the threaded module, kept between runs when a run's pool threads return
 * (`wasi_thread_start` ends) by the time the run does. A helper that is still inside the module
 * cannot be reused and is terminated. Idle helpers are unref'd, so they never keep the process
 * alive, and `terminateAll` ends every one of them.
 */
export class ThreadPool {
  private readonly idle: Helper[] = []
  /** Helpers created and helpers reused, for tests and measurements. */
  created = 0
  reused = 0

  constructor(private readonly script?: URL) {}

  take(script?: URL): Helper {
    const idle = this.idle.pop()
    if (idle) {
      this.reused++
      return idle
    }
    this.created++
    const worker = new Worker(
      script ?? this.script ?? workerURL("./fallow-thread", import.meta.url),
    )
    // An idle helper must not keep the process alive.
    worker.unref()
    // A helper that traps cannot be reported from here, the main thread being inside the module;
    // the request's timeout ends the run.
    worker.on("error", () => {})
    return { worker, flag: new Int32Array(new SharedArrayBuffer(4)) }
  }

  /** After a run: keep the helpers that left the module, end the others. */
  settle(helpers: readonly Helper[], keep: boolean): void {
    for (const helper of helpers) {
      let done = false
      if (keep) {
        try {
          Atomics.wait(helper.flag, 0, HELPER_RUNNING, HELPER_WAIT_MS)
        } catch {}
        done = Atomics.load(helper.flag, 0) === HELPER_DONE
      }
      if (done) this.idle.push(helper)
      else void helper.worker.terminate()
    }
  }

  terminateAll(): void {
    for (const helper of this.idle.splice(0)) void helper.worker.terminate()
  }

  get idleCount(): number {
    return this.idle.length
  }
}

/** Most helper threads a module may start. The analyzer chooses 1 or 2 within this bound. */
export const MAX_FALLOW_THREADS = 2

/** Initial and maximum size, in 64 KiB pages, of the shared memory a threaded module imports. */
export const SHARED_MEMORY = { initial: 65535, maximum: 65536 } as const

/** True for a module built for `wasm32-wasip1-threads`: it imports its (shared) memory. */
export function isThreadedModule(module: WebAssembly.Module): boolean {
  return WebAssembly.Module.imports(module).some((entry) => entry.kind === "memory")
}

type Sinks = { input: Uint8Array; inputOffset: number; out: Uint8Array[]; err: Uint8Array[] }

/**
 * The imports a module asks of its host, for the main thread and for each helper thread. Every
 * thread has its own WASI instance (its own descriptor table) over the same preopens, and all
 * of them are read-only.
 */
export function hostImports(
  roots: readonly string[],
  getMemory: () => WebAssembly.Memory,
  sinks: Sinks,
  onGit?: (call: GitCall) => void,
  trace?: HostTrace,
  /** The one directory the module may write: `<root>/.fallow`, Fallow's own cache. */
  cacheDir?: string,
): { wasi: WASI; imports: Record<string, Record<string, (...args: never[]) => number>> } {
  const preopens: Record<string, string> = Object.fromEntries(roots.map((root) => [root, root]))
  const wasi = new WASI({
    version: "preview1",
    args: ["fallow"],
    env: cacheDir ? { FALLOW_CACHE_MAX_SIZE: String(FALLOW_CACHE_MAX_MB) } : {},
    preopens,
    returnOnExit: true,
  })
  const original = wasi.wasiImport as unknown as Record<string, (...args: number[]) => number>
  const imports: Record<string, (...args: never[]) => number> = { ...original } as Record<
    string,
    (...args: never[]) => number
  >
  const view = () => new DataView(getMemory().buffer)
  const bind = (name: string, fn: (...args: never[]) => number) => {
    imports[name] = fn
  }
  bind("proc_exit", ((code: number) => {
    throw new WasiExit(code)
  }) as never)
  for (const name of WRITE_IMPORTS) if (name in original) bind(name, () => ERRNO_ROFS)

  // Writes are confined to `cacheDir`. Directory descriptors are followed so a write relative to
  // one is judged by where it lands; a link anywhere inside the cache tree refuses the write.
  const dirOf = new Map<number, string>()
  const writable = new Set<number>()
  const text = (pointer: number, length: number) =>
    decoder.decode(new Uint8Array(getMemory().buffer, pointer, length).slice())
  const target = (fd: number, pointer: number, length: number): string | undefined => {
    const base = dirOf.get(fd)
    return base === undefined ? undefined : normalize(join(base, text(pointer, length)))
  }
  const confined = (path: string | undefined): boolean => {
    if (!cacheDir || path === undefined) return false
    if (path !== cacheDir && !path.startsWith(cacheDir + sep)) return false
    let current = cacheDir
    for (const part of ["", ...path.slice(cacheDir.length).split(sep).filter(Boolean)]) {
      current = part ? join(current, part) : current
      try {
        if (lstatSync(current).isSymbolicLink()) return false
      } catch {
        return true
      }
    }
    return true
  }
  if (cacheDir) {
    bind("fd_prestat_dir_name", ((fd: number, pointer: number, length: number) => {
      const rc = original.fd_prestat_dir_name!(fd, pointer, length)
      if (rc === 0) dirOf.set(fd, text(pointer, length))
      return rc
    }) as never)
    bind("fd_close", ((fd: number) => {
      dirOf.delete(fd)
      writable.delete(fd)
      return original.fd_close!(fd)
    }) as never)
    bind("path_create_directory", ((fd: number, pointer: number, length: number) =>
      confined(target(fd, pointer, length))
        ? original.path_create_directory!(fd, pointer, length)
        : ERRNO_ROFS) as never)
    bind("path_unlink_file", ((fd: number, pointer: number, length: number) =>
      confined(target(fd, pointer, length))
        ? original.path_unlink_file!(fd, pointer, length)
        : ERRNO_ROFS) as never)
    bind("path_remove_directory", ((fd: number, pointer: number, length: number) =>
      confined(target(fd, pointer, length))
        ? original.path_remove_directory!(fd, pointer, length)
        : ERRNO_ROFS) as never)
    bind("path_rename", ((
      fd: number,
      pointer: number,
      length: number,
      toFd: number,
      toPointer: number,
      toLength: number,
    ) =>
      confined(target(fd, pointer, length)) && confined(target(toFd, toPointer, toLength))
        ? original.path_rename!(fd, pointer, length, toFd, toPointer, toLength)
        : ERRNO_ROFS) as never)
    for (const name of [
      "fd_pwrite",
      "fd_allocate",
      "fd_filestat_set_size",
      "fd_filestat_set_times",
      "fd_datasync",
      "fd_sync",
    ] as const)
      if (name in original)
        bind(name, ((fd: number, ...rest: number[]) =>
          writable.has(fd) ? original[name]!(fd, ...rest) : ERRNO_ROFS) as never)
  }

  bind("fd_read", ((fd: number, iovs: number, count: number, nread: number) => {
    if (fd !== 0) return original.fd_read!(fd, iovs, count, nread)
    const dv = view()
    let total = 0
    for (let i = 0; i < count; i++) {
      const pointer = dv.getUint32(iovs + i * 8, true)
      const length = dv.getUint32(iovs + i * 8 + 4, true)
      const chunk = Math.min(length, sinks.input.length - sinks.inputOffset)
      new Uint8Array(getMemory().buffer, pointer, chunk).set(
        sinks.input.subarray(sinks.inputOffset, sinks.inputOffset + chunk),
      )
      sinks.inputOffset += chunk
      total += chunk
    }
    dv.setUint32(nread, total, true)
    return 0
  }) as never)

  bind("fd_write", ((fd: number, iovs: number, count: number, nwritten: number) => {
    if (fd !== 1 && fd !== 2) {
      if (fd < 3) return ERRNO_BADF
      return writable.has(fd) ? original.fd_write!(fd, iovs, count, nwritten) : ERRNO_ROFS
    }
    const dv = view()
    let total = 0
    for (let i = 0; i < count; i++) {
      const pointer = dv.getUint32(iovs + i * 8, true)
      const length = dv.getUint32(iovs + i * 8 + 4, true)
      ;(fd === 1 ? sinks.out : sinks.err).push(
        new Uint8Array(getMemory().buffer, pointer, length).slice(),
      )
      total += length
    }
    dv.setUint32(nwritten, total, true)
    return 0
  }) as never)

  bind("path_open", ((
    fd: number,
    dirflags: number,
    pathPtr: number,
    pathLen: number,
    oflags: number,
    rightsBase: bigint,
    rightsInheriting: bigint,
    fdflags: number,
    opened: number,
  ) => {
    const where = target(fd, pathPtr, pathLen)
    const writes =
      oflags & (OFLAGS_CREAT | OFLAGS_EXCL | OFLAGS_TRUNC) ||
      fdflags & FDFLAGS_APPEND ||
      rightsBase & WRITE_RIGHTS
    if (writes && !confined(where)) return ERRNO_ROFS
    const rc = original.path_open!(
      fd,
      dirflags,
      pathPtr,
      pathLen,
      oflags,
      rightsBase as never,
      rightsInheriting as never,
      fdflags,
      opened,
    )
    if (rc === 0 && cacheDir) {
      const newFd = view().getUint32(opened, true)
      if (where !== undefined) dirOf.set(newFd, where)
      if (writes) writable.add(newFd)
    }
    return rc
  }) as never)

  // Deterministic entropy: hash maps and other seeds must not vary between runs.
  bind("random_get", ((buffer: number, length: number) => {
    const bytes = new Uint8Array(getMemory().buffer, buffer, length)
    let state = 0x9e3779b9
    for (let i = 0; i < length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      bytes[i] = state >>> 24
    }
    return 0
  }) as never)

  let pendingGit: Uint8Array | undefined
  const host = {
    git_run(requestPtr: number, requestLen: number): number {
      const text = decoder.decode(
        new Uint8Array(getMemory().buffer, requestPtr, requestLen).slice(),
      )
      let call: GitCall
      try {
        call = JSON.parse(text) as GitCall
      } catch {
        return -1
      }
      let cwd: string
      try {
        cwd = realpathSync(call.cwd)
      } catch {
        return -1
      }
      if (!inside(cwd, roots) || gitSubcommand(call.args) === undefined) return -1
      onGit?.({ ...call, cwd })
      const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: "/nonexistent" }
      for (const [key, value] of Object.entries(call.env ?? {})) {
        if (value !== null && !GIT_ENV_DROP.includes(key)) env[key] = value
      }
      env.GIT_OPTIONAL_LOCKS = "0"
      env.GIT_TERMINAL_PROMPT = "0"
      env.GIT_PAGER = "cat"
      const run = Bun.spawnSync(
        [
          "git",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
          "--no-pager",
          ...call.args,
        ],
        { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: GIT_TIMEOUT_MS },
      )
      const stdout = run.stdout ?? new Uint8Array()
      const stderr = run.stderr ?? new Uint8Array()
      const result = new Uint8Array(8 + stdout.length + stderr.length)
      const dv = new DataView(result.buffer)
      dv.setInt32(0, run.exitCode ?? 128, true)
      dv.setUint32(4, stdout.length, true)
      result.set(stdout, 8)
      result.set(stderr, 8 + stdout.length)
      pendingGit = result
      return result.length
    },
    git_result(destination: number, capacity: number): number {
      const result = pendingGit
      pendingGit = undefined
      if (!result || result.length > capacity) return -1
      new Uint8Array(getMemory().buffer, destination, result.length).set(result)
      return result.length
    },
  }
  // Pointers and lengths reach the host as signed 32-bit numbers; past 2 GiB of linear memory
  // they would be negative. Every import sees them unsigned.
  const unsigned = <T extends Record<string, (...args: never[]) => number>>(table: T): T =>
    Object.fromEntries(
      Object.entries(table).map(([name, fn]) => [
        name,
        (...args: unknown[]) => {
          const values = args.map((arg) => (typeof arg === "number" ? arg >>> 0 : arg))
          const result = (fn as (...values: unknown[]) => number)(...values)
          trace?.(name, values, result, getMemory())
          return result
        },
      ]),
    ) as unknown as T
  return {
    wasi,
    imports: {
      wasi_snapshot_preview1: unsigned(imports),
      lazers_host: unsigned(host as never),
    },
  }
}

/** What a helper thread needs to join a run (sent to its worker as a message). */
export type ThreadStart = {
  module: WebAssembly.Module
  memory: WebAssembly.Memory
  roots: string[]
  tid: number
  arg: number
  /** Set to 1 (and notified) when the thread's entry point returns. */
  flag: Int32Array
}

/** Instantiate `module` and run one request to completion. Throws `WasiTrap` on a trap. */
export function runFallowModule(
  module: WebAssembly.Module,
  request: WasiRequest,
  options: RunOptions = {},
): WasiOutcome {
  const roots = [request.root, ...(options.extraRoots ?? [])].map((root) => realpathSync(root))
  const sinks: Sinks = {
    input: new TextEncoder().encode(JSON.stringify({ ...request, root: roots[0] })),
    inputOffset: 0,
    out: [],
    err: [],
  }
  const threaded = isThreadedModule(module)
  let memory: WebAssembly.Memory | undefined = threaded
    ? new WebAssembly.Memory({ ...SHARED_MEMORY, shared: true })
    : undefined
  const { wasi, imports } = hostImports(
    roots,
    () => memory!,
    sinks,
    options.onGit,
    options.trace,
    options.cache ? join(roots[0]!, ".fallow") : undefined,
  )
  const helpers: Helper[] = []
  const pool = options.threadPool ?? new ThreadPool(options.threadScript)
  const allowed = Math.min(options.maxThreads ?? 1, MAX_FALLOW_THREADS)
  let nextTid = 1
  const instanceImports: Record<string, Record<string, unknown>> = { ...imports }
  if (threaded) {
    instanceImports.env = { memory }
    instanceImports.wasi = {
      "thread-spawn": (arg: number) => {
        if (nextTid > allowed) return (options.onSpawn?.(false), -1)
        const tid = nextTid++
        try {
          const helper = pool.take(options.threadScript)
          helper.flag = new Int32Array(new SharedArrayBuffer(4))
          const start: ThreadStart = {
            module,
            memory: memory!,
            roots,
            tid,
            arg,
            flag: helper.flag,
          }
          helper.worker.postMessage(start)
          helpers.push(helper)
        } catch {
          nextTid--
          return (options.onSpawn?.(false), -1)
        }
        options.onSpawn?.(true)
        return tid
      },
    }
  }
  const instance = new WebAssembly.Instance(module, instanceImports as WebAssembly.Imports)
  memory = (instance.exports.memory as WebAssembly.Memory | undefined) ?? memory
  options.onInstance?.(instance)
  let exitCode: number | undefined
  try {
    // A threaded module imports its memory; `start` wants it as an export, so hand it an
    // instance-shaped object.
    exitCode = wasi.start(
      (threaded
        ? { exports: { memory, _start: () => (instance.exports._start as () => void)() } }
        : instance) as never,
    ) as number | undefined
  } catch (error) {
    if (error instanceof WasiExit) exitCode = error.code
    else
      throw new WasiTrap(
        error instanceof Error ? error.message : String(error),
        decoder.decode(Buffer.concat(sinks.err)),
      )
  } finally {
    pool.settle(helpers, options.threadPool !== undefined)
  }
  return {
    stdout: decoder.decode(Buffer.concat(sinks.out)),
    stderr: decoder.decode(Buffer.concat(sinks.err)),
    exitCode,
  }
}
