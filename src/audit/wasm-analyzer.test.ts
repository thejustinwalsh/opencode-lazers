import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { wasmFallowAnalyzer } from "./wasm-analyzer.ts"

const root = fileURLToPath(new URL("../..", import.meta.url))
const configPath = join(root, ".fallowrc.json")

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

  test("dead code and cycles run in the module", async () => {
    const dead = await wasmFallowAnalyzer.deadCode({ root: dir })
    expect(Array.isArray(dead.unused_files)).toBe(true)
    const cycles = await wasmFallowAnalyzer.cycles({ root: dir })
    expect(cycles.circular_dependencies).toEqual([])
  }, 60_000)
})
