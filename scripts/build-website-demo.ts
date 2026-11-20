/**
 * Builds the website's live panel demos (website/demo) into website/public/demo, so the site's
 * own `vite build` copies them to /demo/. Run from anywhere: `bun scripts/build-website-demo.ts`.
 *
 * 1. Compiles every story (website/demo/stories) and validates each state's reads against the
 *    panel read contracts' schemas. A contract change that a story no longer satisfies fails here.
 * 2. Builds the demo entry with Vite (relative base) using the repo's solid-js and the real panels.
 * 3. Writes the compiled stories as JSON beside it and prints the byte cost.
 */
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { gzipSync } from "node:zlib"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { build } from "vite"
import solid from "vite-plugin-solid"
import { compile, dataAt } from "../website/demo/src/story.ts"
import { readers, stories } from "../website/demo/stories/index.ts"
import { DEMOS } from "../website/src/demos.ts"

const root = fileURLToPath(new URL("../website/demo", import.meta.url))
const outDir = fileURLToPath(new URL("../website/public/demo", import.meta.url))

async function validate() {
  let failures = 0
  let checked = 0
  for (const source of stories) {
    const story = compile(source)
    const reader = readers[story.panel]
    if (!reader) throw new Error(`No reader for panel ${story.panel}`)
    // Validate the initial state and the state after every data patch.
    const times = [0, ...story.steps.filter((step) => step.data).map((step) => step.at)]
    for (const t of times) {
      for (const read of reader(dataAt(story, t) as never)) {
        checked++
        const result = await read.schema["~standard"].validate(read.value)
        const issues = (result as { issues?: readonly { message: string; path?: unknown[] }[] })
          .issues
        if (issues) {
          failures++
          console.error(
            `story ${story.id} @${t}ms ${read.label}: ${issues
              .slice(0, 3)
              .map((i) => `${(i.path ?? []).join(".")}: ${i.message}`)
              .join("; ")}`,
          )
        }
      }
    }
  }
  if (failures) throw new Error(`${failures} story reads do not match their contracts`)
  console.log(`validated ${checked} reads across ${stories.length} stories`)
}

async function sizes(
  dir: string,
  prefix = "",
): Promise<{ name: string; raw: number; gz: number }[]> {
  const out: { name: string; raw: number; gz: number }[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await sizes(path, `${prefix}${entry.name}/`)))
    else {
      const bytes = await Bun.file(path).bytes()
      out.push({
        name: prefix + entry.name,
        raw: (await stat(path)).size,
        gz: gzipSync(bytes).length,
      })
    }
  }
  return out
}

/** The page's static copy of each demo (website/src/demos.ts) must equal the compiled stories. */
function checkPageCopy() {
  const problems: string[] = []
  for (const [key, def] of Object.entries(DEMOS)) {
    const source = stories.find((candidate) => candidate.id === def.story)
    if (!source) {
      problems.push(`${key}: no story "${def.story}"`)
      continue
    }
    const story = compile(source)
    if (story.panel !== def.panel) problems.push(`${key}: panel ${story.panel} != ${def.panel}`)
    if (story.size.width !== def.size.width || story.size.height !== def.size.height)
      problems.push(`${key}: size differs`)
    const want = story.chapters.map((c) => `${c.name}|${c.caption}`)
    const have = def.steps.map((c) => `${c.name}|${c.caption}`)
    if (want.join("\n") !== have.join("\n")) problems.push(`${key}: steps differ from the story`)
  }
  if (problems.length)
    throw new Error(`website/src/demos.ts is out of date:\n${problems.join("\n")}`)
}

checkPageCopy()
await validate()
await rm(outDir, { recursive: true, force: true })
await build({
  root,
  configFile: false,
  base: "./",
  logLevel: "warn",
  plugins: [solid()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __LAZERS_RADAR_WORKER_SOURCE__: JSON.stringify(""),
  },
  resolve: { conditions: ["module", "browser", "development|production"] },
  build: { outDir, emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 4000 },
})
await mkdir(join(outDir, "stories"), { recursive: true })
for (const source of stories) {
  await writeFile(join(outDir, "stories", `${source.id}.json`), JSON.stringify(compile(source)))
}
const files = await sizes(outDir)
let raw = 0
let gz = 0
for (const file of files.sort((a, b) => b.raw - a.raw)) {
  raw += file.raw
  gz += file.gz
  console.log(
    `${file.name.padEnd(44)} ${String(file.raw).padStart(9)}  gzip ${String(file.gz).padStart(8)}`,
  )
}
console.log(`total ${raw} bytes, gzip ${gz}`)
