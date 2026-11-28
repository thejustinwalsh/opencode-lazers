import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

const root = fileURLToPath(new URL("..", import.meta.url))
const crateDir = join(root, "crates/difftastic-wasm")
const vendorDir = join(root, "vendor/difftastic")
const targetDir = join(root, ".cache/difftastic-wasm-target")
const outputDir = join(root, "src/code-review/structural")
const target = "wasm32-wasip1"
const rustToolchain = globalThis.process.env.DIFFTASTIC_RUST_TOOLCHAIN ?? "1.99.0"
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")

async function run(command: string[], cwd = root, env: Record<string, string> = {}) {
  const process = Bun.spawn(command, {
    cwd,
    env: { ...globalThis.process.env, ...env },
    stdout: "pipe",
    stderr: "inherit",
  })
  const [stdout, code] = await Promise.all([new Response(process.stdout).text(), process.exited])
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`)
  return stdout.trim()
}

async function version(command: string[]) {
  return (await run(command)).split("\n")[0] ?? "unknown"
}

async function shaSources(directory: string, files: readonly string[]) {
  const digest = createHash("sha256")
  const visit = async (path: string, prefix: string) => {
    const entries = await readdir(path, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const child = join(path, entry.name)
      const relative = join(prefix, entry.name)
      if ((await stat(child)).isDirectory()) await visit(child, relative)
      else digest.update(`${relative}\0`).update(await readFile(child))
    }
  }
  for (const file of files) {
    const path = join(directory, file)
    if (existsSync(path)) {
      if ((await stat(path)).isDirectory()) await visit(path, file)
      else digest.update(`${file}\0`).update(await readFile(path))
    }
  }
  return digest.digest("hex")
}

export function wasiEnvironment(
  environment: NodeJS.ProcessEnv = globalThis.process.env,
): Record<string, string> {
  const sdk = environment.WASI_SDK_PATH
  const sysroot = environment.WASI_SYSROOT ?? (sdk ? join(sdk, "share/wasi-sysroot") : undefined)
  if (!sysroot || !existsSync(sysroot))
    throw new Error("Set WASI_SYSROOT or WASI_SDK_PATH to build Difftastic's C tree-sitter parsers")

  const sdkTool = (name: string) => (sdk ? join(sdk, "bin", name) : name)
  const compiler = environment["CC_wasm32-wasip1"] ?? sdkTool("clang")
  const existingCFlags = environment["CFLAGS_wasm32-wasip1"] ?? ""

  return {
    WASI_SYSROOT: sysroot,
    "CC_wasm32-wasip1": compiler,
    "AR_wasm32-wasip1": environment["AR_wasm32-wasip1"] ?? sdkTool("llvm-ar"),
    "RANLIB_wasm32-wasip1": environment["RANLIB_wasm32-wasip1"] ?? sdkTool("llvm-ranlib"),
    "CFLAGS_wasm32-wasip1": `${existingCFlags} --sysroot=${sysroot}`.trim(),
  }
}

async function wasmImports(wasm: Uint8Array) {
  const module = await WebAssembly.compile(wasm)
  return {
    imports: WebAssembly.Module.imports(module)
      .map((entry) => `${entry.module}.${entry.name}`)
      .sort(),
    exports: WebAssembly.Module.exports(module)
      .map((entry) => `${entry.kind}.${entry.name}`)
      .sort(),
  }
}

export async function buildDifftasticWasm() {
  const upstream = JSON.parse(await readFile(join(vendorDir, "UPSTREAM.json"), "utf8")) as {
    tag: string
    commit: string
  }
  const sysroot = (await run(["rustc", `+${rustToolchain}`, "--print", "sysroot"])).trim()
  const cargoHome = globalThis.process.env.CARGO_HOME ?? join(homedir(), ".cargo")
  const flags = [
    "-C",
    "link-arg=-zstack-size=16777216",
    `--remap-path-prefix=${root.replace(/\/$/, "")}=/lazers`,
    `--remap-path-prefix=${cargoHome}=/cargo`,
    `--remap-path-prefix=${sysroot}=/rustc-sysroot`,
  ].join("\x1f")

  await mkdir(outputDir, { recursive: true })
  await run(
    ["cargo", `+${rustToolchain}`, "build", "--release", "--locked", "--target", target],
    crateDir,
    {
      ...wasiEnvironment(),
      CARGO_TARGET_DIR: targetDir,
      CARGO_ENCODED_RUSTFLAGS: flags,
    },
  )
  const rawPath = join(targetDir, `${target}/release/lazers_difftastic_wasm.wasm`)
  const optimizedPath = join(targetDir, "difftastic-opt.wasm")
  const outputPath = join(outputDir, "difftastic.wasm.gz")
  await run([
    "wasm-opt",
    "-Oz",
    "--strip-debug",
    "--strip-producers",
    "--enable-bulk-memory",
    "--enable-sign-ext",
    "--enable-mutable-globals",
    "--enable-nontrapping-float-to-int",
    "--enable-multivalue",
    "--enable-reference-types",
    rawPath,
    "-o",
    optimizedPath,
  ])

  const optimized = await readFile(optimizedPath)
  const compressed = gzipSync(optimized, { level: 9 })
  await writeFile(outputPath, compressed)
  const wasmSurface = await wasmImports(optimized)
  const manifest = {
    upstreamTag: upstream.tag,
    upstreamCommit: upstream.commit,
    target,
    optimization: { rustOptLevel: 3, wasmOpt: "-Oz", gzipLevel: 9 },
    sourcesSha256: await shaSources(vendorDir, [
      "UPSTREAM.json",
      "Cargo.toml",
      "Cargo.lock",
      "build.rs",
      "src",
      "vendored_parsers",
    ]),
    bindingSha256: await shaSources(crateDir, ["Cargo.toml", "Cargo.lock", "src"]),
    wasmSha256: hash(optimized),
    compressedSha256: hash(compressed),
    wasmBytes: optimized.byteLength,
    compressedBytes: compressed.byteLength,
    ...wasmSurface,
    toolchain: {
      rustc: await version(["rustc", `+${rustToolchain}`, "--version"]),
      cargo: await version(["cargo", `+${rustToolchain}`, "--version"]),
      rustToolchain,
      wasmOpt: await version(["wasm-opt", "--version"]),
    },
  }
  await writeFile(join(outputDir, "ARTIFACT.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`src/code-review/structural/difftastic.wasm.gz ${compressed.byteLength} bytes`)
  return manifest
}

if (import.meta.main) await buildDifftasticWasm()
