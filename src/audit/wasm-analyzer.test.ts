import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { nativeFallowAnalyzer } from "./analyzer.ts"
import { wasmFallowAnalyzer } from "./wasm-analyzer.ts"

const root = fileURLToPath(new URL("../..", import.meta.url))
const configPath = join(root, ".fallowrc.json")

const complexKey = (f: {
  path: string
  name: string
  line: number
  cyclomatic: number
  cognitive: number
}) => `${f.path}:${f.line}:${f.name}:${f.cyclomatic}:${f.cognitive}`
const groupKey = (g: { instances: { file: string; start_line: number; end_line: number }[] }) =>
  g.instances
    .map((i) => `${i.file}:${i.start_line}-${i.end_line}`)
    .sort()
    .join("|")

describe("wasmFallowAnalyzer matches nativeFallowAnalyzer on this repository", () => {
  test("complexity findings, whole root and a file subset", async () => {
    const scope = { root, configPath }
    const [wasm, native] = await Promise.all([
      wasmFallowAnalyzer.complexity(scope),
      nativeFallowAnalyzer.complexity(scope),
    ])
    // CRAP-only findings are native-only: the module has no coverage model.
    const expected = native.findings.filter((f) => f.exceeded !== "crap")
    expect(wasm.findings.map(complexKey).sort()).toEqual(expected.map(complexKey).sort())
    expect(expected.length).toBeGreaterThan(100)

    // The native binding ignores `files` for health, so a subset is the whole report filtered.
    // Pick the subset from files that have findings today, so a later cleanup of any one
    // file cannot empty it.
    const files = [...new Set(expected.map((f) => f.path))].slice(0, 3)
    const wasmSub = await wasmFallowAnalyzer.complexity({ ...scope, files })
    expect(wasmSub.findings.map(complexKey).sort()).toEqual(
      expected
        .filter((f) => files.includes(f.path))
        .map(complexKey)
        .sort(),
    )
    expect(wasmSub.findings.length).toBeGreaterThan(0)
    for (const f of wasmSub.findings) expect(files).toContain(f.path)
  }, 90_000)

  test("clone groups and the duplication percentage, whole root and a changed set", async () => {
    const scope = { root, configPath }
    const [wasm, native] = await Promise.all([
      wasmFallowAnalyzer.duplication(scope),
      nativeFallowAnalyzer.duplication(scope),
    ])
    expect(wasm.clone_groups.map(groupKey).sort()).toEqual(native.clone_groups.map(groupKey).sort())
    expect(wasm.stats.duplication_percentage).toBeCloseTo(native.stats.duplication_percentage, 6)
    const byTokens = (g: { token_count: number; line_count: number }) =>
      `${g.token_count}/${g.line_count}`
    expect(wasm.clone_groups.map(byTokens).sort()).toEqual(native.clone_groups.map(byTokens).sort())

    // The native binding ignores `files` for duplication; a changed set keeps the groups that
    // touch it, every file staying in the corpus.
    const touched = [...new Set(native.clone_groups.flatMap((g) => g.instances.map((i) => i.file)))]
    const files = touched.slice(0, 10)
    const wasmSub = await wasmFallowAnalyzer.duplication({ ...scope, files })
    expect(wasmSub.clone_groups.map(groupKey).sort()).toEqual(
      native.clone_groups
        .filter((g) => g.instances.some((i) => files.includes(i.file)))
        .map(groupKey)
        .sort(),
    )
    expect(wasmSub.clone_groups.length).toBeGreaterThan(0)
  }, 90_000)
})

describe("worker behaviour", () => {
  let dir: string
  let outside: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lz-wasm-root-"))
    outside = mkdtempSync(join(tmpdir(), "lz-wasm-outside-"))
    writeFileSync(join(dir, "package.json"), '{"name":"fixture"}')
    writeFileSync(join(dir, "small.ts"), "export const small = (a: number) => a + 1\n")
    const branches = Array.from({ length: 25 }, (_, i) => `  if (a === ${i}) return ${i}`).join(
      "\n",
    )
    writeFileSync(
      join(outside, "secret.ts"),
      `export function secret(a: number) {\n${branches}\n  return -1\n}\n`,
    )
    symlinkSync(join(outside, "secret.ts"), join(dir, "link.ts"))
    mkdirSync(join(dir, "sub"))
    symlinkSync(outside, join(dir, "sub", "escape"))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  test("an already-aborted request rejects and the next request succeeds", async () => {
    const controller = new AbortController()
    controller.abort(new Error("stop"))
    await expect(
      wasmFallowAnalyzer.complexity({ root: dir, signal: controller.signal }),
    ).rejects.toThrow()
    const report = await wasmFallowAnalyzer.complexity({ root: dir })
    expect(report.findings).toEqual([])
  })

  test("aborting a request in flight terminates the worker and the next request starts a new one", async () => {
    const controller = new AbortController()
    const pending = wasmFallowAnalyzer.duplication({ root, configPath, signal: controller.signal })
    const settled = pending.then(
      () => "resolved",
      () => "rejected",
    )
    queueMicrotask(() => controller.abort(new Error("stop")))
    expect(await settled).toBe("rejected")
    const report = await wasmFallowAnalyzer.complexity({ root: dir })
    expect(report.findings).toEqual([])
  }, 60_000)

  test("a symlink pointing outside the root is not read", async () => {
    const report = await wasmFallowAnalyzer.complexity({
      root: dir,
      files: ["link.ts", "sub/escape/secret.ts", "small.ts"],
    })
    expect(report.findings.map((f) => f.path)).toEqual([])
    // Control: the same function inside the root is reported.
    writeFileSync(join(dir, "inside.ts"), await Bun.file(join(outside, "secret.ts")).text())
    const inside = await wasmFallowAnalyzer.complexity({ root: dir, files: ["inside.ts"] })
    expect(inside.findings.map((f) => f.name)).toEqual(["secret"])
  })

  test("analysis never writes a .fallow directory", async () => {
    await wasmFallowAnalyzer.complexity({ root: dir })
    await wasmFallowAnalyzer.duplication({ root: dir })
    expect(existsSync(join(dir, ".fallow"))).toBe(false)
    expect(existsSync(join(root, ".fallow"))).toBe(false)
  })

  test("dead code is delegated to the native binding", async () => {
    const report = await wasmFallowAnalyzer.deadCode({ root: dir })
    expect(Array.isArray(report.unused_files)).toBe(true)
  }, 60_000)
})
