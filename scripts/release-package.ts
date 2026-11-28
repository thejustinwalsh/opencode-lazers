import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { assertNoNativeBinaries } from "./native-binary-check.ts"
import { serverAssets, serverEntries } from "./build-server.ts"
import {
  assertReviewPackageFiles,
  reviewPackageFiles,
} from "./code-review-package/review-package-files.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const [tag, destination, changelog] = process.argv.slice(2)
if (!tag || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag) || !destination)
  throw Error("Usage: bun run package:release vMAJOR.MINOR.PATCH OUTPUT_DIRECTORY [CHANGELOG_FILE]")
const output = resolve(destination)
const version = tag.slice(1)
const runtimeScripts = [
  ...serverEntries.map(([, file]) => `dist/${file}`),
  ...serverAssets.map((file) => `dist/${file}`),
]
const staging = await mkdtemp(join(tmpdir(), "lazers-release-"))
const run = async (cwd: string, ...command: string[]) => {
  const process = Bun.spawn(command, { cwd, stdio: ["ignore", "inherit", "inherit"] })
  if ((await process.exited) !== 0) throw Error(`Failed: ${command.join(" ")}`)
}

try {
  await run(root, "bun", "run", "build")
  const { installedSmokePath } = await import("./code-review-package/installed-smoke.ts")
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
    cp(resolve(changelog ?? join(root, "CHANGELOG.md")), join(pkg, "CHANGELOG.md")),
    cp(join(root, "licenses"), join(pkg, "licenses"), { recursive: true }),
    cp(join(root, "src"), join(pkg, "src"), {
      recursive: true,
      filter: (file) => !/\.(?:test|fixture)\.[cm]?[jt]sx?$/.test(basename(file)),
    }),
    ...["dist/gui-experimental.cjs", ...runtimeScripts].map((file) =>
      cp(join(root, file), join(pkg, file)),
    ),
    writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ name: "lazers-install-smoke", private: true }),
    ),
    cp(installedSmokePath, join(consumer, "installed-smoke.ts")),
    cp(
      join(root, "scripts/code-review-package/installed-smoke-runner.ts"),
      join(consumer, "installed-smoke-runner.ts"),
    ),
  ])
  // Analysis is WebAssembly; the archive must hold no native addon or executable.
  await assertNoNativeBinaries(pkg)
  await assertReviewPackageFiles(pkg, reviewPackageFiles)
  await run(pkg, "bun", "pm", "pack", "--destination", staging)
  const filename = `opencode-lazers-${version}.tgz`
  await run(consumer, "bun", "add", "--ignore-scripts", join(staging, filename))
  await run(
    consumer,
    "bun",
    "-e",
    `const manifest = await Bun.file("node_modules/opencode-lazers/package.json").json()
      if (manifest.version !== ${JSON.stringify(version)}) throw Error("Installed version mismatch")
      const exports = Object.values(manifest.exports).flatMap((entry) =>
        typeof entry === "string" ? [entry] : Object.values(entry))
      for (const entry of [...exports, ...${JSON.stringify(runtimeScripts)}]) {
        if (!(await Bun.file("node_modules/opencode-lazers/" + entry).exists()))
          throw Error("Missing installed plugin entry: " + entry)
      }
      const { default: plugin } = await import("opencode-lazers")
      if (!plugin) throw Error("Missing server plugin")
      console.log("Installed ${filename}: exports and runtime files are present")`,
  )
  await run(consumer, "bun", "run", "installed-smoke-runner.ts")
  const installed = join(consumer, "node_modules/opencode-lazers")
  await assertReviewPackageFiles(installed, reviewPackageFiles)
  await cp(join(staging, filename), join(output, filename), { force: false, errorOnExist: true })
} finally {
  await rm(staging, { recursive: true, force: true })
}
