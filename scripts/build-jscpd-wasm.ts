import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const crateDir = join(root, "crates/jscpd-wasm")
const targetDir = join(root, ".cache/jscpd-wasm-target")
const outputDir = join(root, "src/code-review/providers/jscpd")
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo")
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")

async function run(command: string[], cwd = root, env: Record<string, string> = {}) {
  const process = Bun.spawn(command, {
    cwd,
    env: { ...globalThis.process.env, ...env },
    stdout: "pipe",
    stderr: "inherit",
  })
  const [stdout, code] = await Promise.all([new Response(process.stdout).text(), process.exited])
  if (code !== 0) throw new Error(`${command.join(" ")} exited with code ${code}`)
  return stdout
}

async function version(command: string[], env: Record<string, string> = {}): Promise<string> {
  return (await run(command, root, env)).trim().split("\n")[0] ?? "unknown"
}

async function sourceHash(directory: string): Promise<string> {
  const hash = createHash("sha256")
  const walk = async (folder: string) => {
    const entries = (await readdir(folder, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )
    for (const entry of entries) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await walk(path)
      else hash.update(`${path.slice(directory.length)}\0`).update(await readFile(path))
    }
  }
  await walk(directory)
  return hash.digest("hex")
}

async function importList(wasm: Uint8Array): Promise<string[]> {
  const module = await WebAssembly.compile(wasm)
  return WebAssembly.Module.imports(module)
    .map((entry) => `${entry.module}.${entry.name}`)
    .sort()
}

export async function buildJscpdWasm() {
  if (!existsSync(join(root, "vendor/jscpd/UPSTREAM.json")))
    throw new Error("Pinned jscpd source is missing from vendor/jscpd.")
  const upstream = JSON.parse(await readFile(join(root, "vendor/jscpd/UPSTREAM.json"), "utf8")) as {
    name: string
    version: string
    commit: string
    license: string
    crates: Record<string, string>
  }
  const rustToolchain = process.env.RUSTUP_TOOLCHAIN ?? "1.99.0"
  const rustEnvironment = { RUSTUP_TOOLCHAIN: rustToolchain }
  const toolchain = {
    rustc: await version(["rustc", "--version"], rustEnvironment),
    cargo: await version(["cargo", "--version"], rustEnvironment),
    wasmOpt: await version(["wasm-opt", "--version"]),
  }
  const sysroot = (await run(["rustc", "--print", "sysroot"], root, rustEnvironment)).trim()
  const flags = [
    "-C",
    "link-arg=-zstack-size=16777216",
    `--remap-path-prefix=${root.replace(/\/$/, "")}=/lazers`,
    `--remap-path-prefix=${cargoHome}=/cargo`,
    `--remap-path-prefix=${sysroot}=/rustc-sysroot`,
  ]
  await mkdir(outputDir, { recursive: true })
  await run(
    [
      "cargo",
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      join(crateDir, "Cargo.toml"),
      "--target",
      "wasm32-wasip1",
    ],
    root,
    {
      CARGO_TARGET_DIR: targetDir,
      CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f"),
      ...rustEnvironment,
    },
  )
  const raw = join(targetDir, "wasm32-wasip1/release/jscpd-wasm.wasm")
  const artifactPath = join(outputDir, "jscpd.wasm")
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
    raw,
    "-o",
    artifactPath,
  ])

  const wasm = await readFile(artifactPath)
  const crateHash = await sourceHash(join(crateDir, "src"))
  const lockHash = sha256(await readFile(join(crateDir, "Cargo.lock")))
  const vendorHash = await sourceHash(join(root, "vendor/jscpd/rust/crates"))
  const manifest = {
    upstream: {
      name: upstream.name,
      version: upstream.version,
      commit: upstream.commit,
      license: upstream.license,
      crates: upstream.crates,
    },
    target: "wasm32-wasip1",
    wasmSha256: sha256(wasm),
    bytes: wasm.byteLength,
    crateSourceSha256: crateHash,
    cargoLockSha256: lockHash,
    vendoredSourceSha256: vendorHash,
    imports: await importList(wasm),
    optimization: { rustOptLevel: 3, wasmOpt: "-O3" },
    toolchain,
  }
  await writeFile(join(outputDir, "ARTIFACT.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Built jscpd WASI module (${wasm.byteLength} bytes).`)
  return manifest
}

if (import.meta.main) await buildJscpdWasm()
