import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, rmSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { makeFixture, repoRoot, runOp, snapshot, wasmModule } from "./test-support.ts"

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
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("no analysis changes the tree: no new, changed or removed file, no .fallow cache", () => {
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
      runOp(op, dir, extra)
    expect(existsSync(join(dir, ".fallow"))).toBe(false)
    expect(snapshot(dir)).toEqual(before)
  }, 120_000)

  test("every write the module attempts is refused", () => {
    const before = snapshot(dir)
    const probe = runOp("fsProbe", dir, { options: { existing: "package.json" } }).report
    for (const name of ["createDir", "writeFile", "overwrite", "append", "removeFile", "rename"])
      expect(probe[name], name).toMatchObject({ ok: false })
    expect(snapshot(dir)).toEqual(before)
  })

  test("reads stay inside the preopened roots, symlinks that leave them included", () => {
    symlinkSync(repoRoot, join(dir, "outside"))
    const probe = runOp("fsProbe", dir, {
      options: {
        existing: "package.json",
        read: [join(dir, "package.json"), join(dir, "outside/package.json"), "/etc/hosts"],
      },
    }).report
    const [inside, escaped, absolute] = probe.reads
    expect(inside.ok).toBe(true)
    expect(escaped.ok).toBe(false)
    expect(absolute.ok).toBe(false)
  })

  test("only read-only git subcommands run, and only under the root", () => {
    const git = (args: string[]) => runOp("gitProbe", dir, { options: { args } }).report
    expect(git(["rev-parse", "--git-dir"])).toMatchObject({ ran: true, code: 0 })
    expect(git(["log", "-1", "--format=%s"])).toMatchObject({ ran: true, stdout: "fixture\n" })
    for (const args of [
      ["commit", "--allow-empty", "-m", "x"],
      ["worktree", "add", "../zz"],
      ["config", "user.name", "x"],
      ["checkout", "-b", "zz"],
      ["push"],
    ])
      expect(git(args), args.join(" ")).toMatchObject({ ran: false })
  })

  test("output is deterministic", () => {
    const first = runOp("health", dir).report
    const second = runOp("health", dir).report
    expect(JSON.stringify({ ...first, elapsed_ms: 0 })).toBe(
      JSON.stringify({ ...second, elapsed_ms: 0 }),
    )
  })
})
