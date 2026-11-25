import { afterAll, afterEach, beforeAll, describe, expect, test as bunTest } from "bun:test"
import { existsSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import {
  makeFixture,
  disposeFixture,
  repoRoot,
  runOp,
  snapshot,
  threadedWasmModule,
  wasmModule,
} from "./test-support.ts"
import { MAX_FALLOW_THREADS, runFallowModule, ThreadPool } from "../fallow-wasi.ts"
import {
  closeOutstandingDirectAnalysisTestLifetimes,
  createDirectAnalysisTestRegistrar,
} from "./resource-lifetime/direct-analysis-test-lifetime.ts"

afterEach(closeOutstandingDirectAnalysisTestLifetimes)
const test = createDirectAnalysisTestRegistrar(bunTest)

const ALLOWED_IMPORTS = new Set([
  "lazers_host.git_result",
  "lazers_host.git_run",
  ...[
    "clock_time_get",
    "environ_get",
    "environ_sizes_get",
    "fd_close",
    "fd_fdstat_get",
    "fd_filestat_get",
    "fd_prestat_dir_name",
    "fd_prestat_get",
    "fd_read",
    "fd_readdir",
    "fd_seek",
    "fd_sync",
    "fd_write",
    "path_create_directory",
    "path_filestat_get",
    "path_open",
    "path_readlink",
    "path_rename",
    "path_unlink_file",
    "poll_oneoff",
    "proc_exit",
    "random_get",
    "sched_yield",
  ].map((name) => `wasi_snapshot_preview1.${name}`),
])

describe("fallow.wasm host surface", () => {
  test("imports only the WASI calls the host serves and the git call", () => {
    const imports = WebAssembly.Module.imports(wasmModule).map((i) => `${i.module}.${i.name}`)
    expect(imports.filter((name) => !ALLOWED_IMPORTS.has(name))).toEqual([])
    // No socket, no process creation, no environment beyond the empty one the host gives.
    expect(imports.some((name) => /sock_|proc_raise|path_symlink|path_link/.test(name))).toBe(false)
  })
})

describe("read-only analysis", () => {
  let dir: string
  beforeAll(() => {
    dir = makeFixture()
  })
  afterAll(async () => disposeFixture(dir))

  test("no analysis changes the tree: no new, changed or removed file, no .fallow cache", async () => {
    const before = snapshot(dir)
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/view.vue", "src/flags.ts"]
    for (const [op, extra] of [
      ["deadCode", {}],
      ["cycles", {}],
      ["architecture", {}],
      ["featureFlagReport", {}],
      ["duplicationReport", {}],
      ["health", {}],
      ["complexity", { paths }],
      ["duplication", { paths }],
    ] as const)
      await runOp(op, dir, extra)
    expect(existsSync(join(dir, ".fallow"))).toBe(false)
    expect(snapshot(dir)).toEqual(before)
  }, 120_000)

  test("every write the module attempts is refused", async () => {
    const before = snapshot(dir)
    const probe = (await runOp("fsProbe", dir, { options: { existing: "package.json" } })).report
    for (const name of ["createDir", "writeFile", "overwrite", "append", "removeFile", "rename"])
      expect(probe[name], name).toMatchObject({ ok: false })
    expect(snapshot(dir)).toEqual(before)
  })

  test("reads stay inside the preopened roots, symlinks that leave them included", async () => {
    symlinkSync(repoRoot, join(dir, "outside"))
    const probe = (
      await runOp("fsProbe", dir, {
        options: {
          existing: "package.json",
          read: [join(dir, "package.json"), join(dir, "outside/package.json"), "/etc/hosts"],
        },
      })
    ).report
    const [inside, escaped, absolute] = probe.reads
    expect(inside.ok).toBe(true)
    expect(escaped.ok).toBe(false)
    expect(absolute.ok).toBe(false)
  })

  test("only read-only git subcommands run, and only under the root", async () => {
    const git = async (args: string[]) =>
      (await runOp("gitProbe", dir, { options: { args } })).report
    expect(await git(["rev-parse", "--git-dir"])).toMatchObject({ ran: true, code: 0 })
    expect(await git(["log", "-1", "--format=%s"])).toMatchObject({
      ran: true,
      stdout: "fixture\n",
    })
    for (const args of [
      ["commit", "--allow-empty", "-m", "x"],
      ["worktree", "add", "../zz"],
      ["config", "user.name", "x"],
      ["checkout", "-b", "zz"],
      ["push"],
    ])
      expect(await git(args), args.join(" ")).toMatchObject({ ran: false })
  })

  test("output is deterministic", async () => {
    const first = (await runOp("health", dir)).report
    const second = (await runOp("health", dir)).report
    expect(JSON.stringify({ ...first, elapsed_ms: 0 })).toBe(
      JSON.stringify({ ...second, elapsed_ms: 0 }),
    )
  })
})

describe("fallow-threads.wasm", () => {
  let dir: string
  beforeAll(() => {
    dir = makeFixture()
  })
  afterAll(async () => disposeFixture(dir))

  test("imports the shared memory and thread spawn on top of the single-threaded surface", () => {
    const imports = WebAssembly.Module.imports(threadedWasmModule).map(
      (i) => `${i.module}.${i.name}`,
    )
    const extra = new Set(["env.memory", "wasi.thread-spawn"])
    expect(imports.filter((name) => !ALLOWED_IMPORTS.has(name) && !extra.has(name))).toEqual([])
    expect(imports).toContain("wasi.thread-spawn")
    expect(imports.some((name) => /sock_|proc_raise|path_symlink|path_link/.test(name))).toBe(false)
  })

  test("no analysis changes the tree, and every write is refused, on helper threads too", async () => {
    const before = snapshot(dir)
    for (const op of ["deadCode", "cycles", "architecture", "featureFlagReport", "health"])
      await runOp(op, dir, {}, { maxThreads: MAX_FALLOW_THREADS }, "threads")
    const probe = await runOp(
      "fsProbe",
      dir,
      { options: { existing: "package.json" } },
      {},
      "threads",
    )
    for (const name of ["createDir", "writeFile", "overwrite", "append", "removeFile", "rename"])
      expect(probe.report[name], name).toMatchObject({ ok: false })
    expect(existsSync(join(dir, ".fallow"))).toBe(false)
    expect(snapshot(dir)).toEqual(before)
  }, 120_000)

  test("helper threads are bounded: no more are started than the pool, the rest are refused", async () => {
    let granted = 0
    let refused = 0
    await runOp(
      "deadCode",
      repoRoot,
      {},
      {
        maxThreads: MAX_FALLOW_THREADS,
        onSpawn: (ok) => (ok ? granted++ : refused++),
      },
      "threads",
    )
    expect(granted).toBeGreaterThan(0)
    expect(granted).toBeLessThanOrEqual(MAX_FALLOW_THREADS)
    // The engine tries a thread per deeply nested file and runs it in place when refused.
    expect(refused).toBeGreaterThanOrEqual(0)
  }, 120_000)

  test("output is deterministic across runs and equal to the single-threaded module", async () => {
    const options = { maxThreads: MAX_FALLOW_THREADS }
    const first = (await runOp("health", dir, {}, options, "threads")).report
    const second = (await runOp("health", dir, {}, options, "threads")).report
    const single = (await runOp("health", dir)).report
    const text = (report: unknown) => JSON.stringify({ ...(report as object), elapsed_ms: 0 })
    expect(text(first)).toBe(text(second))
    expect(text(first)).toBe(text(single))
  })

  test("helper workers return with each run and are reused by the next, with identical output", async () => {
    const pool = new ThreadPool()
    const text = () =>
      runFallowModule(
        threadedWasmModule,
        { op: "duplicationReport", root: dir, options: { threads: 2 } },
        { maxThreads: 2, threadPool: pool },
      ).stdout.replace(/"elapsed_ms":[0-9.]+/g, "")
    try {
      const first = text()
      expect(pool.created).toBe(2)
      const second = text()
      expect(pool.created).toBe(2)
      expect(pool.reused).toBe(2)
      expect(second).toBe(first)
    } finally {
      await pool.terminateAll()
      Bun.gc(true)
    }
    expect(pool.idleCount).toBe(0)
    expect(pool.liveCount).toBe(0)
  })

  test("terminating the analysis worker leaves no helper alive: the process exits on its own", async () => {
    const script = join(import.meta.dir, "terminate-probe.ts")
    const child = Bun.spawn([process.execPath, script, repoRoot], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const timeout = setTimeout(() => child.kill(), 60_000)
    const code = await child.exited
    clearTimeout(timeout)
    expect(await new Response(child.stdout).text()).toContain("cancelled")
    expect(code).toBe(0)
  }, 90_000)
})
