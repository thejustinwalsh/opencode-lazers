import { beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as fallow from "@fallow-cli/fallow-node"
import { Project, initSync } from "./fallow.js"

/**
 * Parity of the WebAssembly module against native Fallow (the pinned
 * `@fallow-cli/fallow-node`), on this repository and on a small fixture.
 *
 * Known, intended differences (everything else must match exactly):
 *  - CRAP-only complexity findings. Native also lists a function whose estimated CRAP score
 *    exceeds `maxCrap` with both complexities within limits. The module reports cyclomatic and
 *    cognitive findings only; CRAP needs the coverage model, which is not ported.
 *  - Dead code, architecture and feature flags are not exposed through the module yet.
 */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
const wasmBytes = readFileSync(new URL("./fallow.wasm", import.meta.url))

type Instance = { file: string; startLine: number; endLine: number }
type Group = { tokenCount: number; lineCount: number; instances: Instance[] }
type Envelope<T> = { ok: true } & T

function call<T>(json: string): Envelope<T> {
  const parsed = JSON.parse(json) as Envelope<T> | { error: { code: string; message: string } }
  if ("error" in parsed) throw new Error(`${parsed.error.code}: ${parsed.error.message}`)
  return parsed
}

function groupKeys(groups: { instances: { file: string; start: number; end: number }[] }[]) {
  return new Set(
    groups.map((group) =>
      group.instances
        .map((instance) => `${instance.file}:${instance.start}-${instance.end}`)
        .sort()
        .join("|"),
    ),
  )
}
const wasmKeys = (groups: Group[]) =>
  groupKeys(
    groups.map((group) => ({
      instances: group.instances.map((i) => ({ file: i.file, start: i.startLine, end: i.endLine })),
    })),
  )
type NativeGroup = { instances: { file: string; start_line: number; end_line: number }[] }
const nativeKeys = (groups: NativeGroup[]) =>
  groupKeys(
    groups.map((group) => ({
      instances: group.instances.map((i) => ({
        file: i.file,
        start: i.start_line,
        end: i.end_line,
      })),
    })),
  )

function difference(a: Set<string>, b: Set<string>) {
  return [...a].filter((key) => !b.has(key)).sort()
}

function open(root: string, paths: string[], configName: string, configText: string) {
  const contents = paths.map((path) => readFileSync(join(root, path), "utf8"))
  return new Project("/ws", paths, contents, configName, configText)
}

beforeAll(() => {
  initSync({ module: wasmBytes })
})

describe("this repository", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    maxBuffer: 1 << 28,
  })
    .toString()
    .split("\0")
    .filter(Boolean)
  const config = readFileSync(join(repoRoot, ".fallowrc.json"), "utf8")
  let project: Project

  beforeAll(() => {
    project = open(repoRoot, tracked, ".fallowrc.json", config)
  })

  test("clone groups match native detectDuplication", async () => {
    const native = (await fallow.detectDuplication({
      root: repoRoot,
      noCache: true,
      threads: 1,
    })) as unknown as {
      clone_groups: (NativeGroup & { token_count: number; line_count: number })[]
      stats: {
        total_files: number
        total_lines: number
        duplicated_lines: number
        clone_groups: number
      }
    }
    const wasm = call<{
      groups: Group[]
      stats: {
        totalFiles: number
        totalLines: number
        duplicatedLines: number
        cloneGroups: number
      }
    }>(project.duplication([], ""))

    expect(difference(wasmKeys(wasm.groups), nativeKeys(native.clone_groups))).toEqual([])
    expect(difference(nativeKeys(native.clone_groups), wasmKeys(wasm.groups))).toEqual([])
    expect(wasm.groups.length).toBe(native.clone_groups.length)
    expect(wasm.stats).toMatchObject({
      totalFiles: native.stats.total_files,
      totalLines: native.stats.total_lines,
      duplicatedLines: native.stats.duplicated_lines,
      cloneGroups: native.stats.clone_groups,
    })
    // Token and line counts agree per group, not only the locations.
    const nativeCounts = new Map(
      native.clone_groups.map((g) => [[...nativeKeys([g])][0], `${g.token_count}/${g.line_count}`]),
    )
    for (const group of wasm.groups) {
      const key = [...wasmKeys([group])][0]
      expect(`${group.tokenCount}/${group.lineCount}`).toBe(nativeCounts.get(key) as string)
    }
  }, 60_000)

  test("complexity findings match native computeComplexity, apart from CRAP-only findings", async () => {
    const native = (await fallow.computeComplexity({
      root: repoRoot,
      noCache: true,
      threads: 1,
    })) as unknown as {
      findings: {
        path: string
        name: string
        line: number
        cyclomatic: number
        cognitive: number
        exceeded: string
      }[]
    }
    const wasm = call<{
      functions: {
        file: string
        name: string
        line: number
        cyclomatic: number
        cognitive: number
      }[]
    }>(project.complexity([]))
    const key = (
      file: string,
      f: { name: string; line: number; cyclomatic: number; cognitive: number },
    ) => `${file}:${f.line}:${f.name}:${f.cyclomatic}:${f.cognitive}`
    const expected = new Set(
      native.findings.filter((f) => f.exceeded !== "crap").map((f) => key(f.path, f)),
    )
    const actual = new Set(wasm.functions.map((f) => key(f.file, f)))
    expect(difference(actual, expected)).toEqual([])
    expect(difference(expected, actual)).toEqual([])
    expect(expected.size).toBeGreaterThan(100)
  }, 60_000)

  test("a changed-file run reports exactly the full-run groups that touch the changed files", () => {
    const full = call<{ groups: Group[] }>(project.duplication([], "")).groups
    const touched = [...new Set(full.flatMap((group) => group.instances.map((i) => i.file)))].sort()
    const changed = touched.filter((_, index) => index % Math.ceil(touched.length / 10) === 0)
    expect(changed.length).toBeGreaterThanOrEqual(8)
    const focused = call<{ groups: Group[] }>(project.duplication(changed, "")).groups
    const expected = full.filter((group) => group.instances.some((i) => changed.includes(i.file)))
    expect(difference(wasmKeys(focused), wasmKeys(expected))).toEqual([])
    expect(difference(wasmKeys(expected), wasmKeys(focused))).toEqual([])
    expect(focused.length).toBeGreaterThan(0)
  })
})

describe("fixture project", () => {
  let dir: string
  let paths: string[]
  const block = (name: string) => `export function ${name}(items: number[], limit: number) {
  const out: number[] = []
  for (const item of items) {
    if (item > limit) {
      out.push(item * 2)
    } else if (item < 0) {
      out.push(-item)
    } else {
      out.push(item + limit)
    }
  }
  const total = out.reduce((sum, value) => sum + value, 0)
  const average = out.length === 0 ? 0 : total / out.length
  return { out, total, average, max: Math.max(...out), min: Math.min(...out) }
}
`
  const branchy = `export function route(a: number, b: number, c: string): string {
${Array.from({ length: 12 }, (_, i) => `  if (a === ${i} && b > ${i} || c === "k${i}") {\n    if (b % 2 === 0) { return "even${i}" }\n  }`).join("\n")}
  return "none"
}
`
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "fixture", type: "module" }),
    "src/a.ts": block("alpha"),
    "src/b.ts": block("beta"),
    "src/c.ts": branchy,
    "src/view.vue": `<script setup lang="ts">\n${block("gamma")}\n</script>\n<template><div /></template>\n`,
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "fallow-fixture-"))
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    paths = Object.keys(files)
  })

  test("clone groups and complexity match native", async () => {
    const project = open(dir, paths, "fallow.toml", "")
    const nativeDupes = (await fallow.detectDuplication({
      root: dir,
      noCache: true,
      threads: 1,
    })) as unknown as { clone_groups: NativeGroup[] }
    const wasmDupes = call<{ groups: Group[] }>(project.duplication([], "")).groups
    expect(nativeDupes.clone_groups.length).toBeGreaterThan(0)
    expect(difference(wasmKeys(wasmDupes), nativeKeys(nativeDupes.clone_groups))).toEqual([])
    expect(difference(nativeKeys(nativeDupes.clone_groups), wasmKeys(wasmDupes))).toEqual([])

    const nativeHealth = (await fallow.computeComplexity({
      root: dir,
      noCache: true,
      threads: 1,
    })) as unknown as {
      findings: {
        path: string
        name: string
        line: number
        cyclomatic: number
        cognitive: number
        exceeded: string
      }[]
    }
    const wasmHealth = call<{
      functions: {
        file: string
        name: string
        line: number
        cyclomatic: number
        cognitive: number
      }[]
    }>(project.complexity([]))
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
    expect(wasmHealth.functions.length).toBeGreaterThan(0)
    rmSync(dir, { recursive: true, force: true })
  }, 60_000)
})

describe("config text", () => {
  const errorFor = (name: string, text: string) => {
    const project = new Project("/ws", ["a.ts"], ["export {}"], name, text)
    return (JSON.parse(project.duplication([], "")) as { error?: { code: string } }).error?.code
  }

  test("a remote extends returns remote-extends-unsupported", () => {
    expect(errorFor(".fallowrc.json", '{"extends":["https://example.com/base.json"]}')).toBe(
      "remote-extends-unsupported",
    )
    expect(errorFor("fallow.toml", 'extends = ["https://example.com/base.json"]')).toBe(
      "remote-extends-unsupported",
    )
  })

  test("a local extends, an invalid file and an unknown key are errors, not silent defaults", () => {
    expect(errorFor(".fallowrc.json", '{"extends":["./base.json"]}')).toBe("extends-unsupported")
    expect(errorFor(".fallowrc.json", "{ nope")).toBe("config-invalid")
    expect(errorFor(".fallowrc.json", '{"unknownField":true}')).toBe("config-invalid")
  })

  test("jsonc comments and toml parse", () => {
    expect(
      errorFor(".fallowrc.jsonc", '{ // comment\n "duplicates": { "minTokens": 30 } }'),
    ).toBeUndefined()
    expect(errorFor("fallow.toml", "[duplicates]\nminTokens = 30")).toBeUndefined()
  })
})
