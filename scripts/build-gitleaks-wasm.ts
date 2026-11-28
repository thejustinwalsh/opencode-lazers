import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { existsSync, type Dirent } from "node:fs"
import { basename, join, relative } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import {
  GITLEAKS_SERVER_ASSETS,
  GITLEAKS_SERVER_ENTRIES,
} from "../src/code-review/providers/gitleaks/build-contribution.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const crate = join(root, "crates/gitleaks-wasm")
const targetDir = join(root, ".cache/gitleaks-wasm-target")
const assetSource = GITLEAKS_SERVER_ASSETS[0][0]
const outputDir = join(root, "src/code-review/providers/gitleaks/wasm")
const licenseDir = join(root, "licenses/gitleaks")
const upstream = JSON.parse(
  await readFile(join(root, "src/code-review/providers/gitleaks/UPSTREAM.json"), "utf8"),
) as {
  analyzer: { version: string; commit: string; license: string }
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")

function normalizedNotice(contents: Uint8Array): string {
  return new TextDecoder()
    .decode(contents)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n+$/, "\n")
}

async function run(
  command: string[],
  cwd = root,
  env: Record<string, string> = {},
): Promise<string> {
  const process = Bun.spawn(command, {
    cwd,
    env: { ...Bun.env, ...env },
    stdout: "pipe",
    stderr: "inherit",
  })
  const [stdout, status] = await Promise.all([new Response(process.stdout).text(), process.exited])
  if (status !== 0) throw new Error(`${command[0]} exited ${status}`)
  return stdout.trim()
}

async function version(command: string[]): Promise<string> {
  try {
    return (await run(command)).split("\n")[0] ?? "unknown"
  } catch {
    throw new Error(`${command[0]} is required to build Gitleaks WASM`)
  }
}

async function sourceDigest(): Promise<string> {
  const hash = createHash("sha256")
  const roots = [
    join(root, "crates/gitleaks-wasm"),
    join(root, "vendor/gitleaks"),
    join(root, "vendor/termenv"),
  ]
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (!entry.name.endsWith("_test.go")) {
        hash
          .update(relative(root, path))
          .update("\0")
          .update(await readFile(path))
      }
    }
  }
  for (const directory of roots) await walk(directory)
  return hash.digest("hex")
}

async function moduleDirectories(): Promise<Map<string, string>> {
  const modules = await run(
    [
      "go",
      "list",
      "-mod=readonly",
      "-deps",
      "-f",
      "{{if .Module}}{{.Module.Path}}\t{{.Module.Dir}}{{end}}",
      ".",
    ],
    crate,
    { GOTOOLCHAIN: "local" },
  )
  const uniqueModules = new Map<string, string>()
  for (const line of modules.split("\n").filter(Boolean)) {
    const separator = line.indexOf("\t")
    if (separator < 0) throw new Error("go list returned an invalid module row")
    const module = line.slice(0, separator)
    const directory = line.slice(separator + 1)
    if (!uniqueModules.has(module)) uniqueModules.set(module, directory)
  }
  return uniqueModules
}

const licenseName = /^(?:LICENSE|COPYING|NOTICE)(?:[._ -].*)?$/i

function directLicenseCandidates(entries: Dirent<string>[], directory: string): string[] {
  return entries
    .filter((entry) => entry.isFile() && licenseName.test(entry.name))
    .map((entry) => join(directory, entry.name))
}

async function nestedLicenseCandidates(
  entries: Dirent<string>[],
  directory: string,
): Promise<string[]> {
  const directories = entries.filter(
    (entry) => entry.isDirectory() && /^(?:license|licenses)$/i.test(entry.name),
  )
  const groups = await Promise.all(
    directories.map((entry) => nestedFilesInDirectory(join(directory, entry.name))),
  )
  return groups.flat()
}

async function nestedFilesInDirectory(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && licenseName.test(entry.name))
    .map((entry) => join(directory, entry.name))
}

async function licenseCandidates(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (): Dirent<string>[] => [],
  )
  const direct = directLicenseCandidates(entries, directory)
  if (direct.length > 0) return direct
  return nestedLicenseCandidates(entries, directory)
}

async function writeLicenseFiles(module: string, sources: string[]): Promise<string[]> {
  const files: string[] = []
  for (const source of sources) {
    const sourceName = basename(source).replace(/\.[^.]+$/, "")
    const name = `${module.replaceAll("/", "_")}__${sourceName}.txt`
    await writeFile(join(licenseDir, name), normalizedNotice(await readFile(source)), {
      mode: 0o644,
    })
    files.push(name)
  }
  return files
}

function assertLicenseCandidates(module: string, candidates: readonly string[]): void {
  if (candidates.length === 0 && module !== "std")
    throw new Error(`No LICENSE/COPYING/NOTICE file found for Go module ${module}`)
}

async function writeModuleLicenses(
  module: string,
  directory: string,
): Promise<{ module: string; files: string[] }> {
  if (module === "github.com/thejustinwalsh/opencode-lazers/crates/gitleaks-wasm")
    return { module, files: [] }
  const candidates = await licenseCandidates(directory)
  assertLicenseCandidates(module, candidates)
  return { module, files: await writeLicenseFiles(module, candidates) }
}

async function collectLicenses(): Promise<{ module: string; files: string[] }[]> {
  await rm(licenseDir, { recursive: true, force: true })
  await mkdir(licenseDir, { recursive: true })
  const collected: { module: string; files: string[] }[] = []
  for (const [module, directory] of await moduleDirectories()) {
    const result = await writeModuleLicenses(module, directory)
    if (result.files.length > 0) collected.push(result)
  }
  await writeFile(
    join(licenseDir, "golang-BSD.txt"),
    normalizedNotice(await readFile(join(root, "licenses/golang-BSD.txt"))),
    { mode: 0o644 },
  )
  collected.push({ module: "Go toolchain runtime", files: ["golang-BSD.txt"] })
  return collected
}

async function wasmImports(wasm: Uint8Array): Promise<string[]> {
  const module = await WebAssembly.compile(wasm)
  return WebAssembly.Module.imports(module)
    .map((item) => `${item.module}.${item.name}`)
    .sort()
}

interface Toolchain {
  go: string
  wasmOpt: string
}

async function pinnedToolchain(): Promise<Toolchain> {
  const goVersion = await version(["go", "version"])
  const wasmOptVersion = await version(["wasm-opt", "--version"])
  if (!/\bgo1\.26\.1\b/.test(goVersion))
    throw new Error("Gitleaks WASM requires the pinned Go 1.26.1 toolchain")
  if (!/\bversion 129\b/.test(wasmOptVersion))
    throw new Error("Gitleaks WASM requires the pinned Binaryen wasm-opt 129 toolchain")
  return { go: goVersion, wasmOpt: wasmOptVersion }
}

async function compileWasm(go: string): Promise<void> {
  await run(
    [
      "go",
      "build",
      "-mod=readonly",
      "-trimpath",
      "-buildvcs=false",
      "-ldflags=-s -w -buildid=",
      "-o",
      go,
      ".",
    ],
    crate,
    {
      CGO_ENABLED: "0",
      GOOS: "wasip1",
      GOARCH: "wasm",
      GOTOOLCHAIN: "local",
      GOCACHE: process.env.GOCACHE ?? join(homedir(), "Library/Caches/go-build"),
      GOPROXY: process.env.GOPROXY ?? "https://proxy.golang.org,direct",
    },
  )
}

async function optimizeWasm(go: string, output: string): Promise<void> {
  await run([
    "wasm-opt",
    "-O3",
    "--strip-debug",
    "--strip-producers",
    "--enable-bulk-memory",
    "--enable-sign-ext",
    "--enable-mutable-globals",
    "--enable-nontrapping-float-to-int",
    "--enable-multivalue",
    "--enable-reference-types",
    go,
    "-o",
    output,
  ])
}

async function buildManifest(wasm: Uint8Array, toolchain: Toolchain) {
  const modules = await collectLicenses()
  return {
    schemaVersion: 1,
    upstream: {
      version: upstream.analyzer.version,
      commit: upstream.analyzer.commit,
      license: upstream.analyzer.license,
      regex: "Go standard-library regexp",
    },
    target: "wasm32-wasip1",
    sourceSha256: await sourceDigest(),
    serverContribution: {
      entries: GITLEAKS_SERVER_ENTRIES,
      assets: GITLEAKS_SERVER_ASSETS,
    },
    wasm: {
      file: "gitleaks.wasm",
      bytes: wasm.byteLength,
      sha256: sha256(wasm),
      imports: await wasmImports(wasm),
    },
    optimization: { go: "-s -w", wasmOpt: "-O3" },
    toolchain: { go: toolchain.go, wasmOpt: toolchain.wasmOpt },
    licenses: modules,
  }
}

export async function buildGitleaksWasm() {
  const toolchain = await pinnedToolchain()
  const go = join(targetDir, "gitleaks.wasm")
  const output = join(root, assetSource)
  await mkdir(outputDir, { recursive: true })
  await mkdir(targetDir, { recursive: true })
  await compileWasm(go)
  await optimizeWasm(go, output)
  const wasm = await readFile(output)
  const manifest = await buildManifest(wasm, toolchain)
  const manifestPath = join(outputDir, "ARTIFACT.json")
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await run(["bun", "fmt", manifestPath])
  await rm(go, { force: true })
  console.log(`${relative(root, output)} ${wasm.byteLength} bytes`)
  return manifest
}

if (import.meta.main) {
  if (!existsSync(join(crate, "go.mod"))) throw new Error("crates/gitleaks-wasm is missing")
  await buildGitleaksWasm()
}
