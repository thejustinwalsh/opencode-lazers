import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as fallow from "@fallow-cli/fallow-node"
import { complexity, initSync, parse } from "./fallow.js"

const wasmBytes = readFileSync(new URL("./fallow.wasm", import.meta.url))
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))

type Fn = { name: string; line: number; col: number; cyclomatic: number; cognitive: number }
const key = (fn: Fn) => `${fn.line}:${fn.col}:${fn.name}`

let native = new Map<string, Fn[]>()

beforeAll(async () => {
  initSync({ module: wasmBytes })
  // Thresholds of 1 and 0 make native report every function that is not trivially 1/0.
  const report = (await fallow.computeComplexity({
    root: repoRoot,
    noCache: true,
    threads: 1,
    maxCyclomatic: 1,
    maxCognitive: 0,
    top: 100000,
  })) as unknown as { findings: ({ path: string } & Fn)[] }
  native = new Map()
  for (const finding of report.findings) {
    const rows = native.get(finding.path) ?? []
    rows.push(finding)
    native.set(finding.path, rows)
  }
})

describe("fallow.wasm", () => {
  test("complexity matches native computeComplexity on files of this repository", () => {
    // Whatever the repository holds now: a spread of files that native reports functions for.
    const paths = [...native.keys()].sort()
    const files = paths.filter(
      (_, index) => index % Math.max(1, Math.floor(paths.length / 6)) === 0,
    )
    const project = (fns: Fn[]) =>
      fns
        .map((fn) => ({ k: key(fn), cyclomatic: fn.cyclomatic, cognitive: fn.cognitive }))
        .sort((a, b) => a.k.localeCompare(b.k))
    for (const file of files) {
      const content = readFileSync(`${repoRoot}${file}`, "utf8")
      const wasm = (JSON.parse(complexity(file, content)) as Fn[]).filter(
        // Native lists a function only above the thresholds 1 and 0, and never the synthetic
        // module-scope unit, which is aggregate-only.
        (fn) => fn.name !== "<module>" && (fn.cyclomatic > 1 || fn.cognitive > 0),
      )
      expect(project(wasm)).toEqual(project(native.get(file) ?? []))
    }
  })

  test("parse summarises imports and exports", () => {
    const summary = JSON.parse(
      parse("a.ts", `import { x } from "./x"\nexport const y = x\nexport default function () {}`),
    )
    expect(summary).toMatchObject({
      imports: ["./x"],
      exports: ["y", "default"],
      parseErrorCount: 0,
    })
  })

  test("module declares no filesystem, network or process import", () => {
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(wasmBytes))
    // Declared today: wasm-bindgen's string reader (`__wbindgen_string_get`, for the string
    // arrays a host passes in), its `throw` helper, and the externref table initialiser. All three
    // are provided by the generated glue and touch no host capability. A WASI, `env`, clock,
    // random, filesystem, socket or process function would not match.
    expect(
      imports.every((entry) => entry.module === "./fallow_bg.js" && entry.kind === "function"),
    ).toBe(true)
    expect(imports.map((entry) => entry.name.replace(/_[0-9a-f]{16}$/, "")).sort()).toEqual([
      "__wbg___wbindgen_string_get",
      "__wbg___wbindgen_throw",
      "__wbindgen_init_externref_table",
    ])
  })
})
