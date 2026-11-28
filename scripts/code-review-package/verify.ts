import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { reviewProducers } from "./review-package-files.ts"

const root = fileURLToPath(new URL("../..", import.meta.url))
const packageManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  version: string
}
const outputs = reviewProducers.flatMap(({ api, workers, assets }) => [api, ...workers, ...assets])
const releaseOutput = await mkdtemp(join(tmpdir(), "lazers-review-release-"))

async function run(...command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
  })
  if ((await child.exited) !== 0) throw new Error(`Failed: ${command.join(" ")}`)
}

try {
  await Promise.all(outputs.map((file) => rm(join(root, file), { force: true })))
  await run("bun", "run", "build:server")
  await run("bun", "run", "package:release", `v${packageManifest.version}`, releaseOutput)
} finally {
  await rm(releaseOutput, { recursive: true, force: true })
}
