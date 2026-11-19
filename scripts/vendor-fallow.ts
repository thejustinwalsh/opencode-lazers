import { createHash } from "node:crypto"
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Imports upstream Fallow source into vendor/fallow and applies the patch queue.
 *
 *   bun scripts/vendor-fallow.ts [tag]
 *
 * The tag defaults to the one already recorded in vendor/fallow/UPSTREAM.json. A tarball whose
 * sha256 differs from a recorded hash for the same tag fails loudly. A patch that no longer
 * applies fails the import and leaves vendor/fallow untouched.
 */
const root = fileURLToPath(new URL("..", import.meta.url))
const vendorDir = join(root, "vendor/fallow")
const patchDir = join(root, "vendor/fallow-patches")
const repo = "fallow-rs/fallow"

/** Crates the analysis needs. `license`, `napi`, `lsp`, `mcp`, `cli`, editors, npm packaging and docs stay out. */
export const importedCrates = [
  "types",
  "config",
  "extract",
  "graph",
  "core",
  "engine",
  "mutation",
  "security",
  "output",
  "report-protocol",
  "process",
] as const
const rootFiles = ["Cargo.toml", "Cargo.lock", "LICENSE"] as const
/** Directories inside a crate that only serve upstream's own tests and benchmarks. */
const skippedInCrate = new Set(["tests", "benches", "AGENTS.md", "README.md"])

export type Upstream = {
  repo: string
  tag: string
  commit: string
  tarballSha256: string
  importedPaths: string[]
}

async function run(cmd: string[], cwd?: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${err.trim() || out.trim()}`)
  return out
}

async function resolveCommit(tag: string) {
  const out = await run([
    "git",
    "ls-remote",
    `https://github.com/${repo}`,
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ])
  const rows = out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
  const peeled = rows.find((row) => row[1]?.endsWith("^{}")) ?? rows[0]
  if (!peeled?.[0]) throw new Error(`Tag ${tag} not found in ${repo}`)
  return peeled[0]
}

async function readRecorded(): Promise<Upstream | undefined> {
  const file = join(vendorDir, "UPSTREAM.json")
  if (!existsSync(file)) return undefined
  return JSON.parse(await readFile(file, "utf8")) as Upstream
}

export async function patchFiles() {
  if (!existsSync(patchDir)) return []
  return (await readdir(patchDir)).filter((name) => name.endsWith(".patch")).sort()
}

/** Hash of the ordered patch contents; recorded in the build artifact manifest. */
export async function patchSetSha256() {
  const hash = createHash("sha256")
  for (const name of await patchFiles()) {
    hash.update(name)
    hash.update("\0")
    hash.update(await readFile(join(patchDir, name)))
    hash.update("\0")
  }
  return hash.digest("hex")
}

export async function vendorFallow(requestedTag?: string) {
  const recorded = await readRecorded()
  const tag = requestedTag ?? recorded?.tag
  if (!tag) throw new Error("Pass a tag: bun scripts/vendor-fallow.ts v3.43.2")
  const commit = await resolveCommit(tag)
  if (recorded && recorded.tag === tag && recorded.commit !== commit) {
    throw new Error(`Tag ${tag} moved: recorded ${recorded.commit}, upstream ${commit}`)
  }

  const cache = join(root, ".cache/vendor-fallow")
  await mkdir(cache, { recursive: true })
  const tarball = join(cache, `${tag}.tar.gz`)
  if (!existsSync(tarball)) {
    const res = await fetch(`https://github.com/${repo}/archive/refs/tags/${tag}.tar.gz`)
    if (!res.ok) throw new Error(`Download of ${tag} failed: ${res.status}`)
    await Bun.write(tarball, res)
  }
  const tarballSha256 = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex")
  if (recorded && recorded.tag === tag && recorded.tarballSha256 !== tarballSha256) {
    throw new Error(
      `Tarball for ${tag} changed: recorded ${recorded.tarballSha256}, got ${tarballSha256}`,
    )
  }

  const staging = join(cache, `stage-${tag}`)
  await rm(staging, { recursive: true, force: true })
  await mkdir(join(staging, "src"), { recursive: true })
  await run(["tar", "-xzf", tarball, "-C", join(staging, "src"), "--strip-components=1"])

  const out = join(staging, "out")
  await mkdir(join(out, "crates"), { recursive: true })
  const importedPaths: string[] = []
  for (const file of rootFiles) {
    await cp(join(staging, "src", file), join(out, file))
    importedPaths.push(file)
  }
  for (const crate of importedCrates) {
    const from = join(staging, "src/crates", crate)
    await cp(from, join(out, "crates", crate), {
      recursive: true,
      filter: (source) => !skippedInCrate.has(source.slice(from.length + 1).split("/")[0] ?? ""),
    })
    importedPaths.push(`crates/${crate}`)
  }

  const upstream: Upstream = { repo, tag, commit, tarballSha256, importedPaths }
  await writeFile(join(out, "UPSTREAM.json"), `${JSON.stringify(upstream, null, 2)}\n`)

  for (const name of await patchFiles()) {
    try {
      await run(
        ["patch", "-p1", "--fuzz=0", "--no-backup-if-mismatch", "-s", "-i", join(patchDir, name)],
        out,
      )
    } catch (error) {
      throw new Error(`Patch ${name} no longer applies to ${tag}: ${(error as Error).message}`, {
        cause: error,
      })
    }
    console.log(`applied ${name}`)
  }

  await rm(vendorDir, { recursive: true, force: true })
  await mkdir(join(root, "vendor"), { recursive: true })
  await cp(out, vendorDir, { recursive: true })
  await rm(staging, { recursive: true, force: true })
  console.log(
    `vendor/fallow at ${tag} (${commit.slice(0, 12)}), tarball ${tarballSha256.slice(0, 12)}`,
  )
  return upstream
}

if (import.meta.main) await vendorFallow(process.argv[2])
