import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const [tag, destination] = process.argv.slice(2)
if (!tag || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag) || !destination)
  throw Error("Usage: bun run package:release vMAJOR.MINOR.PATCH OUTPUT_DIRECTORY")
const output = resolve(destination)
const version = tag.slice(1)
const runtimeScripts = [
  "dist/processor.js",
  "dist/repo-worker.js",
  "dist/decision-worker.js",
  "dist/transition-indexes-worker.js",
  "dist/fallow-worker.js",
  "dist/fallow.wasm",
]
const staging = await mkdtemp(join(tmpdir(), "lazers-release-"))
const run = async (cwd: string, ...command: string[]) => {
  const process = Bun.spawn(command, { cwd, stdio: ["ignore", "inherit", "inherit"] })
  if ((await process.exited) !== 0) throw Error(`Failed: ${command.join(" ")}`)
}

try {
  await run(root, "bun", "run", "build")
  await mkdir(output, { recursive: true })
  const pkg = join(staging, "package")
  const consumer = join(staging, "consumer")
  await Promise.all([mkdir(join(pkg, "dist"), { recursive: true }), mkdir(consumer)])
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  manifest.version = version
  delete manifest.devDependencies
  delete manifest.scripts
  await Promise.all([
    writeFile(join(pkg, "package.json"), JSON.stringify(manifest, null, 2) + "\n"),
    cp(join(root, "README.md"), join(pkg, "README.md")),
    cp(join(root, "src"), join(pkg, "src"), {
      recursive: true,
      filter: (file) => !/\.(?:test|fixture)\.[cm]?[jt]sx?$/.test(basename(file)),
    }),
    ...[
      "gui-experimental.cjs",
      "server.js",
      "processor.js",
      "repo-worker.js",
      "decision-worker.js",
      "transition-indexes-worker.js",
      "fallow-worker.js",
      "fallow.wasm",
    ].map((file) => cp(join(root, "dist", file), join(pkg, "dist", file))),
    writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ name: "lazers-install-smoke", private: true }),
    ),
  ])
  await run(pkg, "bun", "pm", "pack", "--destination", staging)
  const filename = `opencode-lazers-${version}.tgz`
  await run(consumer, "bun", "add", "--ignore-scripts", join(staging, filename))
  await run(
    consumer,
    "bun",
    "-e",
    `const manifest = await Bun.file("node_modules/opencode-lazers/package.json").json()
     if (manifest.version !== ${JSON.stringify(version)}) throw Error("Installed version mismatch")
     for (const entry of [...Object.values(manifest.exports), ...${JSON.stringify(runtimeScripts)}]) {
       if (!(await Bun.file("node_modules/opencode-lazers/" + entry).exists()))
         throw Error("Missing installed plugin entry: " + entry)
     }
     const { default: plugin } = await import("opencode-lazers")
     if (!plugin) throw Error("Missing server plugin")
     console.log("Installed ${filename}: exports and runtime scripts present; server import passed")`,
  )
  await cp(join(staging, filename), join(output, filename), { force: false, errorOnExist: true })
} finally {
  await rm(staging, { recursive: true, force: true })
}
