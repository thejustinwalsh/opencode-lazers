import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  disposeFixture,
  makeFixture,
  moduleKinds,
  repoRoot,
  runOp,
  trackedSources,
} from "./test-support.ts"

/**
 * What LAZERS asks of Fallow, on small fixture projects with expectations written by hand, on
 * both shipped modules (single-threaded and threaded). The two must also answer identically.
 */
const names = <T>(items: T[], pick: (item: T) => string) => items.map(pick).sort()
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

for (const kind of moduleKinds) {
  describe(`${kind} module`, () => {
    const op = async (dir: string, name: string, extra: Record<string, unknown> = {}) =>
      (await runOp(name, dir, extra, {}, kind)).report

    describe("dead code", () => {
      let dir: string
      beforeAll(() => {
        dir = makeFixture({
          // A re-export chain: `reexported` is used through the barrel, `leftover` is not.
          "src/index.ts": `import { shout } from "dep-a"
import { ping } from "./ping.ts"
import { alpha } from "./a.ts"
import { reexported } from "./barrel.ts"
export const main = () => shout(ping(), alpha([1], reexported))
`,
          "src/barrel.ts": `export { reexported } from "./inner.ts"\n`,
          "src/inner.ts": `export const reexported = 1\nexport const leftover = 2\n`,
        })
      })
      afterAll(async () => disposeFixture(dir))

      test("reports exactly the unused file, export and dependency, and nothing that is used", async () => {
        const dead = await op(dir, "deadCode")
        expect(names(dead.unused_files, (f: { path: string }) => f.path)).toEqual([
          "src/b.ts",
          "src/c.ts",
          "src/flags.ts",
          "src/orphan.ts",
          "src/view.vue",
        ])
        expect(
          names(
            dead.unused_exports,
            (f: { path: string; export_name: string }) => `${f.path}:${f.export_name}`,
          ),
        ).toEqual(["src/inner.ts:leftover", "src/ping.ts:unusedExport"])
        expect(
          names(dead.unused_dependencies, (f: { package_name: string }) => f.package_name),
        ).toEqual(["never-used"])
      })

      test("a dependency reached through a symlinked node_modules entry resolves", async () => {
        const dead = await op(dir, "deadCode")
        expect(dead.unresolved_imports).toEqual([])
        expect(
          names(dead.unused_dependencies, (f: { package_name: string }) => f.package_name),
        ).not.toContain("dep-a")
      })
    })

    describe("cycles and architecture", () => {
      let cyclic: string
      let broken: string
      beforeAll(() => {
        cyclic = makeFixture()
        broken = makeFixture({ "src/pong.ts": `export const pong = (): number => 1\n` })
      })
      afterAll(async () => {
        await disposeFixture(cyclic)
        await disposeFixture(broken)
      })

      test("one import cycle is reported with its files, and none once it is broken", async () => {
        const cycles = (await op(cyclic, "cycles")).circular_dependencies
        expect(cycles.map((c: { files: string[] }) => c.files)).toEqual([
          ["src/ping.ts", "src/pong.ts"],
        ])
        expect((await op(broken, "cycles")).circular_dependencies).toEqual([])
      })

      test("the architecture report carries the same cycle", async () => {
        expect((await op(cyclic, "architecture")).circular_dependencies).toHaveLength(1)
        expect((await op(broken, "architecture")).circular_dependencies).toEqual([])
      })
    })

    describe("duplication, complexity and flags", () => {
      let dir: string
      beforeAll(() => {
        dir = makeFixture({
          "config/strict.json": JSON.stringify({
            entry: ["src/index.ts"],
            duplicates: { minTokens: 500 },
          }),
          "config/base.json": JSON.stringify({
            ignorePatterns: ["src/a.ts", "src/b.ts", "src/view.vue"],
          }),
          "config/local.json": JSON.stringify({
            extends: ["./base.json"],
            entry: ["src/index.ts"],
          }),
        })
      })
      afterAll(async () => disposeFixture(dir))

      type Group = { instances: { file: string; start_line: number; end_line: number }[] }
      const groups = (report: Record<string, any>) =>
        (report.clone_groups as Group[]).map((g) =>
          g.instances.map((i) => `${i.file}:${i.start_line}-${i.end_line}`).sort(),
        )

      test("three copies of one function are one clone group with the right ranges", async () => {
        const report = await op(dir, "duplicationReport")
        expect(groups(report)).toEqual([["src/a.ts:1-14", "src/b.ts:1-14", "src/view.vue:2-15"]])
        expect(report.clone_groups[0].line_count).toBe(14)
      })

      test("below the token threshold there is no group", async () => {
        expect(
          (await op(dir, "duplicationReport", { configPath: join(dir, "config/strict.json") }))
            .clone_groups,
        ).toEqual([])
      })

      test("the in-memory clone operation finds the same group, and a changed set filters it", async () => {
        const paths = trackedSources(dir)
        const all = await op(dir, "duplication", { paths, options: {} })
        expect(all.groups).toHaveLength(1)
        const only = await op(dir, "duplication", { paths, files: ["src/a.ts"], options: {} })
        expect(only.groups).toHaveLength(1)
        const none = await op(dir, "duplication", { paths, files: ["src/orphan.ts"], options: {} })
        expect(none.groups).toEqual([])
      })

      test("a function above the threshold is reported with its name and line, one below is not", async () => {
        const paths = trackedSources(dir)
        const report = await op(dir, "complexity", { paths, options: {} })
        expect(
          report.functions.map((f: { file: string; name: string; line: number }) => [
            f.file,
            f.name,
            f.line,
          ]),
        ).toEqual([["src/c.ts", "route", 1]])
        const health = await op(dir, "health")
        const route = health.findings.find((f: { name: string }) => f.name === "route")
        expect(route).toMatchObject({ path: "src/c.ts", line: 1 })
        expect(route.cyclomatic).toBeGreaterThan(report.thresholds.maxCyclomatic)
        // `alpha` stays under both thresholds, so complexity does not list it.
        expect(report.functions.map((f: { name: string }) => f.name)).not.toContain("alpha")
      })

      test("a feature flag in the source is found with its name and place", async () => {
        const flags = await op(dir, "featureFlagReport")
        expect(flags.total_flags).toBe(2)
        expect(
          names(
            flags.feature_flags,
            (f: { flag_name: string; path: string; line: number }) =>
              `${f.flag_name}@${f.path}:${f.line}`,
          ),
        ).toEqual(["ENABLE_BETA_PANEL@src/flags.ts:3", "FEATURE_NEW_CHECKOUT@src/flags.ts:2"])
      })

      test("a local extends resolves through the filesystem and changes the result", async () => {
        const without = await op(dir, "duplicationReport")
        const withBase = await op(dir, "duplicationReport", {
          configPath: join(dir, "config/local.json"),
        })
        expect(without.clone_groups.length).toBe(1)
        expect(withBase.clone_groups).toEqual([])
      })

      test("a remote extends and an invalid file are explicit errors", async () => {
        const bad = makeFixture({
          "config/remote.json": JSON.stringify({ extends: ["https://example.com/base.json"] }),
          "config/bad.json": "{ nope",
        })
        try {
          await expect(
            op(bad, "duplicationReport", { configPath: join(bad, "config/remote.json") }),
          ).rejects.toThrow(/extends/i)
          await expect(
            op(bad, "duplicationReport", { configPath: join(bad, "config/bad.json") }),
          ).rejects.toThrow(/config/i)
        } finally {
          await disposeFixture(bad)
        }
      })
    })
  })
}

describe("both modules answer alike", () => {
  let dir: string
  beforeAll(() => {
    dir = makeFixture()
  })
  afterAll(async () => disposeFixture(dir))

  test("every report on the fixture is identical, apart from timing", async () => {
    for (const name of [
      "deadCode",
      "cycles",
      "architecture",
      "featureFlagReport",
      "duplicationReport",
      "health",
    ]) {
      const single = strip((await runOp(name, dir, {}, {}, "single")).report)
      const threads = strip((await runOp(name, dir, {}, {}, "threads")).report)
      expect(threads, name).toEqual(single)
    }
    const paths = trackedSources(dir)
    for (const name of ["complexity", "duplication"]) {
      const single = strip((await runOp(name, dir, { paths, options: {} }, {}, "single")).report)
      const threads = strip((await runOp(name, dir, { paths, options: {} }, {}, "threads")).report)
      expect(threads, name).toEqual(single)
    }
  }, 120_000)
})

describe("this repository (invariants only; its findings change daily)", () => {
  test("every report runs without error, is deterministic, and has plausible counts, on both modules", async () => {
    const sections = [
      "deadCode",
      "cycles",
      "architecture",
      "featureFlagReport",
      "duplicationReport",
      "health",
    ]
    const seen = new Map<string, string>()
    for (const kind of moduleKinds)
      for (const name of sections) {
        const first = (await runOp(name, repoRoot, {}, {}, kind)).report
        expect(first.kind ?? first.summary ?? first, `${kind} ${name}`).toBeTruthy()
        const text = JSON.stringify(strip(first))
        // Same module twice, and the other module, give the same bytes.
        expect(JSON.stringify(strip((await runOp(name, repoRoot, {}, {}, kind)).report))).toBe(text)
        const other = seen.get(name)
        if (other !== undefined) expect(text, `${name} differs between modules`).toBe(other)
        seen.set(name, text)
        if (name === "deadCode") expect(first.total_issues).toBeGreaterThanOrEqual(0)
        if (name === "duplicationReport")
          expect(first.clone_groups.length).toBeGreaterThanOrEqual(0)
      }
  }, 280_000)
})
