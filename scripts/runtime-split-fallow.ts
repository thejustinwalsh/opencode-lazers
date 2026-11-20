import { setFallowCache, wasmFallowAnalyzer } from "../src/audit/wasm-analyzer.ts"

/**
 * `bun scripts/runtime-split-fallow.ts <file>...`: the Fallow comparison for the `runtime.ts`
 * split (gate 7 of `.agents/plans/runtime-split.md`). Pass `src/runner/runtime.ts` and every new
 * module. The analysis runs in the WebAssembly worker with Fallow's cache off, so nothing is
 * written into the tree. Prints complexity findings, clone groups touching the files, import
 * cycles, and unused exports in the files.
 */

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error("usage: bun scripts/runtime-split-fallow.ts src/runner/runtime.ts [module.ts...]")
  process.exit(2)
}
setFallowCache(false)
const root = process.cwd()

const complexity = await wasmFallowAnalyzer.complexity({ root, files })
const findings = [...complexity.findings].sort((a, b) => b.cognitive - a.cognitive)
console.log(`complexity findings: ${findings.length}`)
for (const f of findings)
  console.log(
    `  ${f.path}:${f.line} ${f.name} cyclomatic=${f.cyclomatic} cognitive=${f.cognitive} lines=${f.line_count}`,
  )
console.log(
  `  worst cognitive: ${findings[0]?.cognitive ?? 0}, worst cyclomatic: ${Math.max(0, ...findings.map((f) => f.cyclomatic))}`,
)

const duplication = (await wasmFallowAnalyzer.duplication({ root, files })) as unknown as {
  clone_groups: { instances: { file: string; start_line: number; end_line: number }[] }[]
}
const touching = duplication.clone_groups.filter((group) =>
  group.instances.some((i) => files.includes(i.file)),
)
console.log(`clone groups touching the files: ${touching.length}`)
for (const group of touching)
  console.log(
    `  ${group.instances.map((i) => `${i.file}:${i.start_line}-${i.end_line}`).join("  ")}`,
  )

const cycles = (await wasmFallowAnalyzer.cycles({ root })) as unknown as {
  circular_dependencies: unknown[]
}
console.log(`import cycles: ${cycles.circular_dependencies.length}`)

const dead = (await wasmFallowAnalyzer.deadCode({ root, files })) as unknown as {
  unused_exports: { path: string; export_name?: string; name?: string }[]
}
const unused = dead.unused_exports.filter((e) => files.includes(e.path))
console.log(`unused exports in the files: ${unused.length}`)
for (const e of unused) console.log(`  ${e.path} ${e.export_name ?? e.name}`)
process.exit(0)
