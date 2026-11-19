import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadNativeFallow, type NativeFallow } from "./native-reference.ts"
import { makeFixture, repoRoot, runOp, trackedSources } from "./test-support.ts"

/**
 * Parity of the WebAssembly module against native Fallow (the pinned `@fallow-cli/fallow-node`,
 * a dev dependency; the file skips when it is not installed), on this repository and on a
 * fixture whose dependency is reached through a symlink.
 *
 * The dead-code, import-cycle, architecture, feature-flag, duplication and health reports must
 * equal native field for field, apart from `elapsed_ms`. The two lighter operations the review
 * uses (in-memory complexity and clone detection) are compared by finding location.
 * Known, intended difference of those two: CRAP-only complexity findings are not reported, as
 * CRAP needs the coverage model.
 */
const native: NativeFallow | undefined = await loadNativeFallow()
const parity = native ? describe : describe.skip

const strip = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(strip)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== "elapsed_ms")
            .map(([key, entry]) => [key, strip(entry)]),
        )
      : value

const sections = [
  ["deadCode", "deadCode", "detectDeadCode", {}],
  ["duplication", "duplicationReport", "detectDuplication", {}],
  ["health", "health", "computeHealth", { css: true }],
  ["architecture", "architecture", "detectArchitecture", {}],
  ["featureFlags", "featureFlagReport", "detectFeatureFlags", {}],
  ["cycles", "cycles", "detectCircularDependencies", {}],
] as const

/** Wall-clock milliseconds per analysis, recorded for the plan. */
export const timings: Record<string, { wasm: number; native: number }> = {}

async function compareSections(root: string, label: string) {
  for (const [name, op, nativeFn, extra] of sections) {
    const options = { root, threads: 1, noCache: true, explain: name !== "cycles", ...extra }
    const startNative = performance.now()
    const expected = await native![nativeFn]!(options)
    const nativeMs = performance.now() - startNative
    const startWasm = performance.now()
    const { report } = runOp(op, root, { options: { threads: 1, explain: true, css: true } })
    const wasmMs = performance.now() - startWasm
    timings[`${label}:${name}`] = { wasm: Math.round(wasmMs), native: Math.round(nativeMs) }
    // `cycles` with explain differs only in `_meta`, which native omits without the flag.
    // Native keeps a process-wide registry of workspace diagnostics, so a `change-coupling-skipped`
    // note from an earlier health call on the same root also shows up in the later sections of
    // that process. Every module call starts clean and reports it only in health.
    const normalize = (value: unknown) => {
      const base = strip(value) as { workspace_diagnostics?: { kind: string }[] }
      const diagnostics =
        name === "health"
          ? base.workspace_diagnostics
          : base.workspace_diagnostics?.filter((d) => d.kind !== "change-coupling-skipped")
      return {
        ...base,
        ...(diagnostics ? { workspace_diagnostics: diagnostics } : {}),
        ...(name === "cycles" ? { _meta: undefined } : {}),
      }
    }
    expect(normalize(report), `${label} ${name}`).toEqual(normalize(expected))
  }
}

parity("this repository", () => {
  test("dead code, cycles, architecture, feature flags, duplication and health equal native", async () => {
    await compareSections(repoRoot, "repo")
    console.log("fallow timings (ms)", JSON.stringify(timings))
  }, 300_000)

  test("in-memory complexity and clone groups match native by location", async () => {
    const paths = trackedSources(repoRoot)
    const nativeHealth = (await native!.computeComplexity!({
      root: repoRoot,
      noCache: true,
      threads: 1,
    })) as {
      findings: {
        path: string
        name: string
        line: number
        cyclomatic: number
        cognitive: number
        exceeded: string
      }[]
    }
    const wasmHealth = runOp("complexity", repoRoot, { paths, options: {} }).report as {
      functions: {
        file: string
        name: string
        line: number
        cyclomatic: number
        cognitive: number
      }[]
    }
    const key = (
      file: string,
      f: { name: string; line: number; cyclomatic: number; cognitive: number },
    ) => `${file}:${f.line}:${f.name}:${f.cyclomatic}:${f.cognitive}`
    expect(wasmHealth.functions.map((f) => key(f.file, f)).sort()).toEqual(
      nativeHealth.findings
        .filter((f) => f.exceeded !== "crap")
        .map((f) => key(f.path, f))
        .sort(),
    )

    const nativeDupes = (await native!.detectDuplication!({
      root: repoRoot,
      noCache: true,
      threads: 1,
    })) as {
      clone_groups: { instances: { file: string; start_line: number; end_line: number }[] }[]
    }
    const wasmDupes = runOp("duplication", repoRoot, {
      paths,
      configPath: join(repoRoot, ".fallowrc.json"),
      options: {},
    }).report as { groups: { instances: { file: string; startLine: number; endLine: number }[] }[] }
    const keys = (groups: { instances: { file: string; s: number; e: number }[] }[]) =>
      groups
        .map((g) =>
          g.instances
            .map((i) => `${i.file}:${i.s}-${i.e}`)
            .sort()
            .join("|"),
        )
        .sort()
    expect(
      keys(
        wasmDupes.groups.map((g) => ({
          instances: g.instances.map((i) => ({ file: i.file, s: i.startLine, e: i.endLine })),
        })),
      ),
    ).toEqual(
      keys(
        nativeDupes.clone_groups.map((g) => ({
          instances: g.instances.map((i) => ({ file: i.file, s: i.start_line, e: i.end_line })),
        })),
      ),
    )
  }, 120_000)
})

parity("fixture with a symlinked dependency", () => {
  let dir: string
  beforeAll(() => {
    dir = makeFixture()
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("every section equals native", async () => {
    await compareSections(dir, "fixture")
  }, 120_000)

  test("findings are the expected ones, so equality is not between two empty reports", () => {
    const dead = runOp("deadCode", dir).report
    // `dep-a` resolves through node_modules/dep-a -> ../packages/dep-a, so it is not unresolved,
    // and the declared dependency nobody imports is reported.
    expect(dead.unresolved_imports).toEqual([])
    expect(dead.unused_files.map((f: { path: string }) => f.path)).toContain("src/orphan.ts")
    expect(dead.unused_exports.map((f: { export_name: string }) => f.export_name)).toContain(
      "unusedExport",
    )
    expect(dead.unused_dependencies.map((f: { package_name: string }) => f.package_name)).toEqual([
      "never-used",
    ])
    const cycles = runOp("cycles", dir).report
    expect(cycles.circular_dependencies.length).toBe(1)
    const flags = runOp("featureFlagReport", dir).report
    expect(flags.total_flags).toBeGreaterThan(0)
  })

  test("in-memory complexity, clone groups and flags match native", async () => {
    const paths = trackedSources(dir)
    const config = join(dir, ".fallowrc.json")
    const nativeDupes = (await native!.detectDuplication!({
      root: dir,
      noCache: true,
      threads: 1,
      configPath: config,
    })) as { clone_groups: unknown[] }
    const wasmDupes = runOp("duplication", dir, { paths, configPath: config, options: {} }).report
    expect(nativeDupes.clone_groups.length).toBeGreaterThan(0)
    expect(wasmDupes.groups.length).toBe(nativeDupes.clone_groups.length)

    const nativeHealth = (await native!.computeComplexity!({
      root: dir,
      noCache: true,
      threads: 1,
      configPath: config,
    })) as { findings: { exceeded: string; name: string }[] }
    const wasmHealth = runOp("complexity", dir, { paths, configPath: config, options: {} }).report
    expect(wasmHealth.functions.map((f: { name: string }) => f.name).sort()).toEqual(
      nativeHealth.findings
        .filter((f) => f.exceeded !== "crap")
        .map((f) => f.name)
        .sort(),
    )
    expect(wasmHealth.functions.length).toBeGreaterThan(0)

    // Only files the changed set touches come back, grouped as in the full run.
    const only = runOp("duplication", dir, {
      paths,
      files: ["src/a.ts"],
      configPath: config,
      options: {},
    }).report
    expect(only.groups.length).toBeGreaterThan(0)
    expect(
      only.groups.every((g: { instances: { file: string }[] }) =>
        g.instances.some((i) => i.file === "src/a.ts"),
      ),
    ).toBe(true)
  }, 60_000)
})

describe("config files", () => {
  let dir: string
  beforeAll(() => {
    dir = makeFixture()
    mkdirSync(join(dir, "config"), { recursive: true })
    writeFileSync(
      join(dir, "config/base.json"),
      JSON.stringify({ ignorePatterns: ["src/a.ts", "src/b.ts", "src/view.vue"] }),
    )
    writeFileSync(
      join(dir, "config/local.json"),
      JSON.stringify({ extends: ["./base.json"], entry: ["src/index.ts"] }),
    )
    writeFileSync(
      join(dir, "config/remote.json"),
      JSON.stringify({ extends: ["https://example.com/base.json"] }),
    )
    writeFileSync(join(dir, "config/bad.json"), "{ nope")
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const duplication = (configPath: string, paths = trackedSources(dir)) =>
    runOp("duplication", dir, { paths, configPath, options: {} }).report

  test("a local extends resolves through the filesystem and changes the result", async () => {
    // The base file ignores the three files that clone each other.
    const withBase = duplication(join(dir, "config/local.json"))
    const without = duplication(join(dir, ".fallowrc.json"))
    expect(without.groups.length).toBeGreaterThan(0)
    expect(withBase.groups.length).toBe(0)
    if (native) {
      const expected = (await native.detectDuplication!({
        root: dir,
        noCache: true,
        threads: 1,
        configPath: join(dir, "config/local.json"),
      })) as { clone_groups: unknown[] }
      expect(withBase.groups.length).toBe(expected.clone_groups.length)
    }
  })

  test("a remote extends and an invalid file are explicit errors", () => {
    expect(() => duplication(join(dir, "config/remote.json"))).toThrow(/extends/i)
    expect(() => duplication(join(dir, "config/bad.json"))).toThrow(/config/i)
  })
})
