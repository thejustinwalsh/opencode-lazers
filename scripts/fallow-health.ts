import { setFallowCache, wasmFallowAnalyzer } from "../src/audit/wasm-analyzer.ts"

/**
 * `bun scripts/fallow-health.ts`: runs the vendored WebAssembly Fallow over this repository with
 * `.fallowrc.json` and prints every finding grouped by kind with `file:line`. Dead code (unused
 * files, exports, types, dependencies, members), import cycles and clone groups are findings;
 * exit 1 when any exist. Fallow's cache is off, so nothing is written into the tree.
 */
setFallowCache(false)
const root = process.cwd()
const configPath = `${root}/.fallowrc.json`

type Row = Record<string, unknown>
const dead = (await wasmFallowAnalyzer.deadCode({ root, configPath })) as unknown as Row
const dupes = await wasmFallowAnalyzer.duplication({ root, configPath })

type Place = { path: string; line?: number }
const place = (p: Place): string => (p.line === undefined ? p.path : `${p.path}:${p.line}`)
const describe = (row: Row): string => {
  const name = row.export_name ?? row.package_name ?? row.member_name ?? ""
  if (Array.isArray(row.files)) return `${(row.files as string[]).join(" -> ")} -> (start)`
  if (Array.isArray(row.locations))
    return `${name}: ${(row.locations as Place[]).map(place).join("  ")}`
  if (Array.isArray(row.imported_from))
    return `${name}: imported at ${(row.imported_from as Place[]).map(place).join("  ")}`
  return `${place(row as Place)} ${name}`.trim()
}

/** Diagnostics and hints in the same report are not findings. */
const NOT_FINDINGS = new Set(["workspace_diagnostics", "next_steps"])

let total = 0
const section = (kind: string, rows: unknown): void => {
  if (!Array.isArray(rows) || rows.length === 0) return
  total += rows.length
  console.log(`${kind}: ${rows.length}`)
  for (const row of rows as Row[]) console.log(`  ${describe(row)}`)
}
for (const [kind, rows] of Object.entries(dead)) if (!NOT_FINDINGS.has(kind)) section(kind, rows)
const groups = dupes.clone_groups ?? []
if (groups.length > 0) {
  total += groups.length
  console.log(`clone_groups: ${groups.length}`)
  for (const g of groups)
    console.log(`  ${g.instances.map((i) => `${i.file}:${i.start_line}-${i.end_line}`).join("  ")}`)
}
console.log(`total findings: ${total}`)
process.exit(total === 0 ? 0 : 1)
