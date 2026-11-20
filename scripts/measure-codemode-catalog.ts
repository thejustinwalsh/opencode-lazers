/**
 * What OpenCode's Code Mode shows a model for LAZERS' tools, measured with OpenCode's own rules.
 *
 *   bun scripts/measure-codemode-catalog.ts [--opencode <checkout>] [--budget <tokens>] [--top <n>]
 *
 * It registers every `lz-*` tool the way the plugin does (test/tool-inventory.ts), renders each
 * tool's signature with OpenCode's catalogue renderer (`packages/codemode`), and runs OpenCode's
 * inline-catalogue selection (`packages/core/src/codemode/catalog.ts`: every namespace line, then
 * listings shortest first until the token budget is spent; pinned tools always shown). The OpenCode
 * source is read from a checkout, never installed or modified: its bare `effect` imports are
 * resolved to this repository's copy.
 *
 * Reports per-tool signature size, the total, and the inline catalogue the model actually gets.
 * Tokens are characters / 4, the same estimate OpenCode uses for the budget.
 */
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectTools } from "../test/tool-inventory.ts"

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const checkout = option("--opencode") ?? "/Users/tjw/Documents/ChatGPT/opencode-native-settlement"
const budget = Number(option("--budget") ?? 2000)
const top = Number(option("--top") ?? 12)

// OpenCode's source is not installed here, so its bare `effect` imports cannot resolve in the
// checkout. Copy the two directories it needs to a scratch folder beside a link to this
// repository's dependencies; the checkout itself is only read.
const scratch = mkdtempSync(join(tmpdir(), "lazers-catalog-"))
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }))
cpSync(join(checkout, "packages/codemode/src"), join(scratch, "packages/codemode/src"), { recursive: true })
cpSync(join(checkout, "packages/core/src/codemode/catalog.ts"), join(scratch, "packages/core/src/codemode/catalog.ts"))
symlinkSync(join(process.cwd(), "node_modules"), join(scratch, "node_modules"))

const load = (relative: string): Promise<any> => import(join(scratch, "packages", relative))
const runtime = await load("codemode/src/tool-runtime.ts")
const namespaceModule = await load("codemode/src/namespace.ts")
const toolModule = await load("codemode/src/tool.ts")
const catalogModule = await load("core/src/codemode/catalog.ts")
const { Schema } = await import("effect")

const tokens = (text: string) => Math.round(text.length / 4)

const inventory = await collectTools()

type Entry = {
  name: string
  area: string
  pinned: boolean
  description: string
  schemaCode: unknown
  output: unknown
}

/** Areas a namespace split would use; measured, not registered. */
function areaOf(name: string): string {
  if (/audit|fallow/.test(name)) return "audit"
  if (/handoff|recovery/.test(name)) return "recovery"
  if (/model|worker-catalog/.test(name)) return "models"
  if (/trajectory/.test(name)) return "trajectory"
  if (/plan|architect-continuity/.test(name)) return "plans"
  if (/project|repo-snapshot/.test(name)) return "context"
  if (/local|verify-task/.test(name)) return "local"
  if (/progress/.test(name)) return "progress"
  return "tasks"
}

const entries: Entry[] = [...inventory.values()].map((tool) => {
  // The host's rule (`inputJsonSchema`/`outputJsonSchema`): a Standard JSON Schema renders itself.
  const toJson = (schema: unknown, io: "input" | "output") => {
    const standard = (schema as { "~standard"?: { jsonSchema?: Record<string, (o: object) => unknown> } })?.[
      "~standard"
    ]
    if (standard?.jsonSchema) return standard.jsonSchema[io]!({ target: "draft-2020-12" })
    return schema
  }
  return {
    name: tool.name,
    area: areaOf(tool.name),
    pinned: tool.options?.pinned === true,
    description: tool.description,
    schemaCode: toJson(tool.input, "input"),
    output: tool.output === undefined ? Schema.NullOr(Schema.String) : toJson(tool.output, "output"),
  }
})

type Mode = { label: string; namespaced: boolean }

function measure(mode: Mode) {
  const tree: Record<string, unknown> = {}
  const spaces = new Map<string, Record<string, unknown>>()
  for (const entry of entries) {
    const tool = toolModule.make({
      description: entry.description,
      input: entry.schemaCode,
      output: entry.output,
      execute: () => undefined,
    })
    if (!mode.namespaced) {
      tree[entry.name] = tool
      continue
    }
    const members = spaces.get(entry.area) ?? {}
    members[entry.name] = tool
    spaces.set(entry.area, members)
  }
  for (const [area, members] of spaces)
    tree[area] = namespaceModule.make({ description: `LAZERS ${area} tools`, tools: members })
  const prepared = runtime.prepare(tree)
  const pinned = new Set(entries.filter((entry) => entry.pinned).map((entry) => entry.name))
  const tools = prepared.catalog.map((tool: { path: string; description: string; signature: string }) => ({
    type: "tool" as const,
    name: tool.path,
    description: tool.description,
    signature: tool.signature,
    pinned: pinned.has(tool.path.split(".").at(-1) ?? tool.path),
  }))
  const summary = catalogModule.summarize({ tools }, { budget })
  const inline = summary.namespaces
    .flatMap(
      (space: { entries: { line: string }[] } & Record<string, unknown>) => [
        catalogModule.namespaceLine(space),
        ...space.entries.map((item) => item.line),
      ],
    )
    .join("\n")
  return { tools, summary, inline }
}

const modes: Mode[] = [
  { label: "as registered (no namespaces)", namespaced: false },
  { label: "exploratory: by area", namespaced: true },
]
const results = modes.map((mode) => ({ mode, ...measure(mode) }))

const base = results[0]!
const rows = base.tools
  .map((tool: { name: string; signature: string; description: string; pinned: boolean }) => ({
    name: tool.name,
    signature: tool.signature.length,
    // The signature is `tools.name(input): Promise<output>`; the split shows which half is large.
    output: tool.signature.length - Math.max(tool.signature.lastIndexOf("): Promise<"), 0),
    description: tool.description.length,
    pinned: tool.pinned,
  }))
  .sort((left: { signature: number }, right: { signature: number }) => right.signature - left.signature)

console.log(`LAZERS tools: ${entries.length}   inline budget: ${budget} tokens\n`)
console.log(`Largest signatures (characters, rendered by OpenCode):`)
for (const row of rows.slice(0, top))
  console.log(
    `  ${row.name.padEnd(34)} signature ${String(row.signature).padStart(6)} (output ${String(row.output).padStart(6)})  description ${String(row.description).padStart(5)}${row.pinned ? "  pinned" : ""}`,
  )
const totalSignature = rows.reduce((sum: number, row: { signature: number }) => sum + row.signature, 0)
const totalDescription = rows.reduce((sum: number, row: { description: number }) => sum + row.description, 0)
console.log(
  `\nAll signatures: ${totalSignature} chars (${tokens("x".repeat(totalSignature))} tokens); all descriptions: ${totalDescription} chars`,
)
console.log(`Pinned: ${entries.filter((entry) => entry.pinned).map((entry) => entry.name).join(", ")}`)

for (const result of results) {
  console.log(`\n== ${result.mode.label}`)
  console.log(
    `inline catalogue: ${result.inline.length} chars, ${tokens(result.inline)} tokens; ` +
      `${result.summary.shown} of ${result.summary.total} signatures shown inline; ` +
      `${result.summary.namespaces.length} namespace lines`,
  )
  const lines = result.summary.namespaces.map(
    (space: { name: string; count: number; entries: unknown[] }) =>
      `${space.name} (${space.entries.length}/${space.count})`,
  )
  if (lines.length <= 20) console.log(`  ${lines.join(", ")}`)
}
process.exit(0)
