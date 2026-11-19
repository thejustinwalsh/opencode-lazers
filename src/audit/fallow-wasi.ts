import { realpathSync } from "node:fs"
import { sep } from "node:path"
import { WASI } from "node:wasi"

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

export class WasiTrap extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message)
  }
}

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

export type RunOptions = {
  /** Extra directories to preopen, read-only. Each must exist. */
  extraRoots?: readonly string[]
  /** Observe each git call that was allowed to run (tests, diagnostics). */
  onGit?: (call: GitCall) => void
}

/** Instantiate `module` and run one request to completion. Throws `WasiTrap` on a trap. */
export function runFallowModule(
  module: WebAssembly.Module,
  request: WasiRequest,
  options: RunOptions = {},
): WasiOutcome {
  const roots = [request.root, ...(options.extraRoots ?? [])].map((root) => realpathSync(root))
  const preopens: Record<string, string> = Object.fromEntries(roots.map((root) => [root, root]))
  const wasi = new WASI({
    version: "preview1",
    args: ["fallow"],
    env: {},
    preopens,
    returnOnExit: true,
  })
  const imports: Record<string, (...args: never[]) => number> = {
    ...(wasi.wasiImport as unknown as Record<string, (...args: never[]) => number>),
  }
  let memory: WebAssembly.Memory | undefined
  const view = () => new DataView(memory!.buffer)
  const input = new TextEncoder().encode(JSON.stringify({ ...request, root: roots[0] }))
  let inputOffset = 0
  const out: Uint8Array[] = []
  const err: Uint8Array[] = []

  const original = wasi.wasiImport as unknown as Record<string, (...args: number[]) => number>
  const bind = (name: string, fn: (...args: never[]) => number) => {
    imports[name] = fn
  }
  bind("proc_exit", ((code: number) => {
    throw new WasiExit(code)
  }) as never)
  for (const name of WRITE_IMPORTS) if (name in original) bind(name, () => ERRNO_ROFS)

  bind("fd_read", ((fd: number, iovs: number, count: number, nread: number) => {
    if (fd !== 0) return original.fd_read!(fd, iovs, count, nread)
    const dv = view()
    let total = 0
    for (let i = 0; i < count; i++) {
      const pointer = dv.getUint32(iovs + i * 8, true)
      const length = dv.getUint32(iovs + i * 8 + 4, true)
      const chunk = Math.min(length, input.length - inputOffset)
      new Uint8Array(memory!.buffer, pointer, chunk).set(
        input.subarray(inputOffset, inputOffset + chunk),
      )
      inputOffset += chunk
      total += chunk
    }
    dv.setUint32(nread, total, true)
    return 0
  }) as never)

  bind("fd_write", ((fd: number, iovs: number, count: number, nwritten: number) => {
    if (fd !== 1 && fd !== 2) return fd < 3 ? ERRNO_BADF : ERRNO_ROFS
    const dv = view()
    let total = 0
    for (let i = 0; i < count; i++) {
      const pointer = dv.getUint32(iovs + i * 8, true)
      const length = dv.getUint32(iovs + i * 8 + 4, true)
      ;(fd === 1 ? out : err).push(new Uint8Array(memory!.buffer, pointer, length).slice())
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
    if (
      oflags & (OFLAGS_CREAT | OFLAGS_EXCL | OFLAGS_TRUNC) ||
      fdflags & FDFLAGS_APPEND ||
      rightsBase & WRITE_RIGHTS
    )
      return ERRNO_ROFS
    return original.path_open!(
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
  }) as never)

  // Deterministic entropy: hash maps and other seeds must not vary between runs.
  bind("random_get", ((buffer: number, length: number) => {
    const bytes = new Uint8Array(memory!.buffer, buffer, length)
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
      const text = decoder.decode(new Uint8Array(memory!.buffer, requestPtr, requestLen))
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
      options.onGit?.({ ...call, cwd })
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
      new Uint8Array(memory!.buffer, destination, result.length).set(result)
      return result.length
    },
  }

  const instance = new WebAssembly.Instance(module, {
    wasi_snapshot_preview1: imports,
    lazers_host: host,
  } as WebAssembly.Imports)
  memory = instance.exports.memory as WebAssembly.Memory
  let exitCode: number | undefined
  try {
    exitCode = wasi.start(instance as never) as number | undefined
  } catch (error) {
    if (error instanceof WasiExit) exitCode = error.code
    else
      throw new WasiTrap(
        error instanceof Error ? error.message : String(error),
        decoder.decode(Buffer.concat(err)),
      )
  }
  return {
    stdout: decoder.decode(Buffer.concat(out)),
    stderr: decoder.decode(Buffer.concat(err)),
    exitCode,
  }
}
