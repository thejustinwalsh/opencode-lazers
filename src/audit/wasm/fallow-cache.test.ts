import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { publishCache, seedCache } from "../fallow-cache.ts"
import { moduleKinds, makeFixture, runOp, snapshot } from "./test-support.ts"

/**
 * Fallow's own cache, in `<root>/.fallow`. It is the only place the module may write; it carries
 * its own `.gitignore`, so it never shows in `git status`, and it is only ever a speed-up: a
 * missing, foreign or corrupt cache gives the report a cold run gives.
 */
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args],
    { cwd, stdio: "pipe" },
  )
    .toString()
    .trim()
const strip = (value: unknown) => JSON.stringify(value, (key, v) => (key === "elapsed_ms" ? 0 : v))
const outsideCache = (dir: string) =>
  new Map([...snapshot(dir)].filter(([path]) => path !== ".fallow" && !path.startsWith(".fallow/")))

describe("cache writes are confined to .fallow", () => {
  let dir: string
  beforeAll(() => {
    dir = makeFixture()
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("nothing outside .fallow changes, and git sees a clean tree", async () => {
    const before = outsideCache(dir)
    for (const op of [
      "deadCode",
      "health",
      "architecture",
      "featureFlagReport",
      "duplicationReport",
    ])
      await runOp(op, dir, {}, { cache: true })
    expect(outsideCache(dir)).toEqual(before)
    expect(readFileSync(join(dir, ".fallow/.gitignore"), "utf8")).toBe("*\n")
    expect(readdirSync(join(dir, ".fallow")).some((name) => name.endsWith(".bin"))).toBe(true)
    expect(git(dir, "status", "--porcelain")).toBe("")
    // The file lister behind the duplication corpus skips it.
    expect(git(dir, "ls-files", "--cached", "--others", "--exclude-standard")).not.toContain(
      ".fallow/",
    )
  }, 120_000)

  test("with the cache on, writes anywhere else are still refused and writes into .fallow work", async () => {
    const before = outsideCache(dir)
    const probe = (
      await runOp("fsProbe", dir, { options: { existing: "package.json" } }, { cache: true })
    ).report
    for (const name of ["createDir", "writeFile", "overwrite", "append", "removeFile", "rename"])
      expect(probe[name], name).toMatchObject({ ok: false })
    expect(probe.cacheWrite).toMatchObject({ ok: true })
    expect(probe.cacheEscape).toMatchObject({ ok: false })
    expect(existsSync(join(dir, "zz-escape"))).toBe(false)
    expect(outsideCache(dir)).toEqual(before)
  })

  test("a .fallow that is a link to elsewhere is never written through", async () => {
    const fresh = makeFixture()
    const elsewhere = mkdtempSync(join(tmpdir(), "fallow-elsewhere-"))
    try {
      symlinkSync(elsewhere, join(fresh, ".fallow"))
      const cold = (await runOp("deadCode", fresh)).report
      const linked = (await runOp("deadCode", fresh, {}, { cache: true })).report
      expect(strip(linked)).toBe(strip(cold))
      expect(readdirSync(elsewhere)).toEqual([])
    } finally {
      rmSync(fresh, { recursive: true, force: true })
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

for (const kind of moduleKinds)
  describe(`${kind} module: the cache never changes the answer`, () => {
    let dir: string
    beforeAll(() => {
      dir = makeFixture()
    })
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
    const ops = [
      "deadCode",
      "cycles",
      "architecture",
      "featureFlagReport",
      "duplicationReport",
      "health",
    ]

    test("cold, warm and corrupt caches give the uncached report", async () => {
      const uncached: Record<string, string> = {}
      for (const op of ops) uncached[op] = strip((await runOp(op, dir, {}, {}, kind)).report)
      for (const round of ["cold", "warm"])
        for (const op of ops)
          expect(
            strip((await runOp(op, dir, {}, { cache: true }, kind)).report),
            `${round} ${op}`,
          ).toBe(uncached[op]!)
      // Garbage, truncation and a wrong header are misses.
      for (const name of readdirSync(join(dir, ".fallow")).filter((n) => n.endsWith(".bin"))) {
        const file = join(dir, ".fallow", name)
        const good = readFileSync(file)
        for (const bad of [
          Buffer.from("not a cache"),
          good.subarray(0, Math.floor(good.length / 2)),
          Buffer.alloc(good.length, 7),
        ]) {
          writeFileSync(file, bad)
          for (const op of ops)
            expect(
              strip((await runOp(op, dir, {}, { cache: true }, kind)).report),
              `${name} ${op}`,
            ).toBe(uncached[op]!)
        }
      }
    }, 240_000)
  })

describe("sharing a cache between checkouts", () => {
  let canonical: string
  let worktree: string
  beforeAll(() => {
    canonical = makeFixture()
    worktree = join(mkdtempSync(join(tmpdir(), "fallow-wt-")), "wt")
    git(canonical, "worktree", "add", "-q", worktree, "-b", "feature")
  })
  afterAll(() => {
    rmSync(worktree, { recursive: true, force: true })
    rmSync(canonical, { recursive: true, force: true })
  })

  test("a worktree seeded from the canonical checkout answers as a cold run does", async () => {
    await runOp("deadCode", canonical, {}, { cache: true })
    expect(await seedCache(worktree, canonical)).toBeGreaterThan(0)
    expect(readFileSync(join(worktree, ".fallow/.gitignore"), "utf8")).toBe("*\n")
    // The files differ in path and mtime, not in content, so the entries are hits.
    const seeded = (await runOp("deadCode", worktree, {}, { cache: true })).report
    const cold = (await runOp("deadCode", worktree)).report
    expect(strip(seeded)).toBe(strip(cold))
    // Already holding a cache, it is left alone.
    expect(await seedCache(worktree, canonical)).toBe(0)
  }, 120_000)

  test("a worktree carrying only its ignored .fallow is removed without force", () => {
    expect(git(worktree, "status", "--porcelain")).toBe("")
    git(canonical, "worktree", "remove", worktree)
    expect(existsSync(worktree)).toBe(false)
  })

  test("publishing and seeding never write through a link", async () => {
    const target = makeFixture()
    const elsewhere = mkdtempSync(join(tmpdir(), "fallow-elsewhere-"))
    const source = makeFixture()
    try {
      await runOp("deadCode", source, {}, { cache: true })
      symlinkSync(elsewhere, join(target, ".fallow"))
      expect(await publishCache(source, target)).toBe(0)
      expect(await seedCache(target, source)).toBe(0)
      expect(readdirSync(elsewhere)).toEqual([])
      expect(await publishCache(source, source)).toBe(0)
      mkdirSync(join(elsewhere, "x"))
    } finally {
      for (const path of [target, elsewhere, source]) rmSync(path, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("what a module keeps, and what a warm run reads", () => {
  const sinkFile = `import { exec } from "node:child_process"\nexport const run = (command: string) => exec(command)\n`

  for (const kind of moduleKinds)
    test(`${kind} module: a config that turns the security rules on runs without the cache and gives the same findings`, async () => {
      // The security facts are about a third of what a module keeps after extraction, and nothing
      // this module reports reads them, so they are dropped unless a rule asks for them; the
      // cache stores modules without them, so such a config also runs without it.
      const plain = makeFixture({ "src/sink.ts": sinkFile })
      const strict = makeFixture({
        "src/sink.ts": sinkFile,
        ".fallowrc.json": JSON.stringify({
          entry: ["src/index.ts"],
          rules: { "security-sink": "warn" },
        }),
      })
      try {
        const normal = (await runOp("deadCode", plain, {}, { cache: true }, kind)).report
        const withRule = (await runOp("deadCode", strict, {}, { cache: true }, kind)).report
        expect(existsSync(join(plain, ".fallow"))).toBe(true)
        expect(existsSync(join(strict, ".fallow"))).toBe(false)
        expect(withRule.unused_files).toEqual(normal.unused_files)
        expect(withRule.unused_exports).toEqual(normal.unused_exports)
      } finally {
        rmSync(plain, { recursive: true, force: true })
        rmSync(strict, { recursive: true, force: true })
      }
    }, 60_000)

  test("a warm run reads none of the source files it has cached", async () => {
    const dir = makeFixture()
    try {
      // Settled long ago, so the cache may trust a file's size and times without its content.
      for (const [path] of snapshot(dir)) {
        if (path.startsWith(".git/") || path === ".git") continue
        try {
          utimesSync(join(dir, path), 1_700_000_000, 1_700_000_000)
        } catch {}
      }
      const sourceBytes = async () => {
        const names = new Map<number, string>()
        let bytes = 0
        const decoder = new TextDecoder()
        await runOp(
          "deadCode",
          dir,
          {},
          {
            cache: true,
            trace: (name, args, result, memory) => {
              if (name === "path_open" && result === 0)
                names.set(
                  new DataView(memory.buffer).getUint32(args[8] as number, true),
                  decoder.decode(
                    new Uint8Array(memory.buffer, args[2] as number, args[3] as number),
                  ),
                )
              if (
                name === "fd_read" &&
                /^src\/.*\.(ts|vue)$/.test(names.get(args[0] as number) ?? "")
              )
                bytes += new DataView(memory.buffer).getUint32(args[3] as number, true)
            },
          },
        )
        return bytes
      }
      // A fingerprint is trusted once the file has not changed for three seconds.
      await Bun.sleep(3300)
      expect(await sourceBytes()).toBeGreaterThan(0)
      expect(await sourceBytes()).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
