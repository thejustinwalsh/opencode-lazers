import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type {} from "../src/code-review/providers/cccc/code-review-cccc-worker.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const crateDir = join(root, "crates/cccc-wasm")
const targetDir = join(root, ".cache/cccc-wasm-target")
const wasmDir = join(root, "src/code-review/providers/cccc/wasm")
const distDir = join(root, "dist")
const wasmName = "cccc.wasm"
const apiName = "code-review-cccc.js"
const workerName = "code-review-cccc-worker.js"
const WASM_OPT_VERSION = "129"
const WASI_SDK_VERSION = "34.0"
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo")
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")

async function run(command: string[], cwd = root, env: Record<string, string> = {}) {
  const process = Bun.spawn(command, {
    cwd,
    env: { ...globalThis.process.env, ...env },
    stdout: "pipe",
    stderr: "inherit",
  })
  const [output, code] = await Promise.all([new Response(process.stdout).text(), process.exited])
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`)
  return output.trim()
}

async function version(command: string[]) {
  return (await run(command, crateDir)).split("\n")[0] ?? "unknown"
}

async function wasiBuildEnvironment() {
  const sdk = requiredWasiSdk()
  const sdkVersion = await checkedWasiSdkVersion(sdk)
  const sysroot = checkedWasiSysroot(sdk)
  const clang = process.env.CC_wasm32_wasip1 ?? join(sdk, "bin/clang")
  const clangVersion = await checkedWasiCompiler(clang, sdkVersion)
  return {
    sdk,
    sysroot,
    clang,
    sdkVersion: sdkVersion.split("\n")[0] ?? "unknown",
    clangVersion,
  }
}

async function checkedWasiSdkVersion(sdk: string): Promise<string> {
  let version: string
  try {
    version = await readFile(join(sdk, "VERSION"), "utf8")
  } catch {
    throw new Error(`WASI SDK ${sdk} is missing its VERSION file`)
  }
  if (!version.startsWith(WASI_SDK_VERSION))
    throw new Error(
      `WASI SDK ${WASI_SDK_VERSION} is required; found ${version.split("\n")[0] ?? "unknown"}`,
    )
  return version
}

function checkedWasiSysroot(sdk: string): string {
  const sysroot = join(sdk, "share/wasi-sysroot")
  if (!validWasiInstallation(join(sdk, "bin/clang"), sysroot))
    throw new Error(`WASI SDK ${sdk} must contain bin/clang and share/wasi-sysroot`)
  return sysroot
}

async function checkedWasiCompiler(clang: string, sdkVersion: string): Promise<string> {
  const clangVersion = await wasiCompilerVersion(clang)
  requireWasiCompilerMatch(clangVersion, sdkVersion)
  return clangVersion
}

async function wasiCompilerVersion(clang: string): Promise<string> {
  try {
    return await version([clang, "--version"])
  } catch {
    throw new Error(`WASI compiler ${clang} is unavailable or could not report its version`)
  }
}

function requireWasiCompilerMatch(clangVersion: string, sdkVersion: string): void {
  const llvmVersion = /^llvm-version:\s*(\S+)/m.exec(sdkVersion)?.[1]
  if (wasiCompilerMatchesSDK(clangVersion, llvmVersion)) return
  throw new Error(
    `WASI compiler must be LLVM ${llvmVersion ?? "version from SDK metadata"} from SDK ${WASI_SDK_VERSION}; found ${clangVersion}`,
  )
}

function wasiCompilerMatchesSDK(clangVersion: string, llvmVersion: string | undefined): boolean {
  if (!llvmVersion) return false
  return clangVersion.includes(`${llvmVersion}-wasi-sdk`)
}

function requiredWasiSdk(): string {
  const defaults = [join(homedir(), ".local/share/wasi-sdk/34.0"), "/opt/wasi-sdk"]
  const sdk = process.env.WASI_SDK_PATH ?? defaults.find(existsSync)
  if (!sdk)
    throw new Error(
      `WASI SDK ${WASI_SDK_VERSION} was not found at ${defaults.join(" or ")}; set WASI_SDK_PATH to an installed SDK`,
    )
  return sdk
}

function validWasiInstallation(clang: string, sysroot: string): boolean {
  return (
    existsSync(clang) && existsSync(join(sysroot, "include")) && existsSync(join(sysroot, "lib"))
  )
}

async function sourceHash(): Promise<string> {
  const hash = createHash("sha256")
  const crateSource = join(crateDir, "src")
  const walk = async (directory: string, path: string) => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const fullPath = join(path, entry.name)
      if (entry.isDirectory()) await walk(directory, fullPath)
      else hash.update(`${fullPath.slice(directory.length)}\0`).update(await readFile(fullPath))
    }
  }
  await walk(crateSource, crateSource)
  for (const file of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"]) {
    hash.update(`${file}\0`).update(await readFile(join(crateDir, file)))
  }
  return hash.digest("hex")
}

async function importsOf(bytes: Uint8Array): Promise<string[]> {
  const module = await WebAssembly.compile(bytes)
  return WebAssembly.Module.imports(module)
    .map((entry) => `${entry.module}.${entry.name}`)
    .sort()
}

async function buildWasm(): Promise<{
  target: string
  wasiSdk: string
  clang: string
  sha256: string
  bytes: number
  imports: string[]
}> {
  const target = "wasm32-wasip1"
  const wasi = await wasiBuildEnvironment()
  await checkWasiToolchain(wasi.sdkVersion, target)
  const flags = await wasmLinkFlags(wasi.sysroot, target)
  await compileWasm(target, wasi, flags)
  const raw = join(targetDir, target, "release", "lazers-cccc-wasm.wasm")
  const output = join(wasmDir, wasmName)
  await optimizeWasm(raw, output)
  const bytes = new Uint8Array(await readFile(output))
  return {
    target,
    wasiSdk: wasi.sdkVersion,
    clang: wasi.clangVersion,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    imports: await importsOf(bytes),
  }
}

async function checkWasiToolchain(wasiSdk: string, target: string): Promise<void> {
  if (!wasiSdk.startsWith(WASI_SDK_VERSION))
    throw new Error(`WASI SDK 34.0 is required; found ${wasiSdk.split("\n")[0] ?? "unknown"}`)
  const targetStatus = await run(
    ["rustup", "target", "list", "--installed", "--toolchain", "1.99.0"],
    crateDir,
  )
  if (!targetStatus.split("\n").includes(target))
    throw new Error(
      `Rust 1.99.0 needs ${target}; install it with rustup target add --toolchain 1.99.0 ${target}`,
    )
}

async function wasmLinkFlags(sysroot: string, target: string): Promise<string> {
  const rustSysroot = await run(["rustc", "--print", "sysroot"], crateDir)
  return [
    "-C",
    "link-arg=-Wl,-z,stack-size=16777216",
    "-C",
    `link-arg=--target=${target}`,
    "-C",
    `link-arg=--sysroot=${sysroot}`,
    "-C",
    "link-arg=-lc",
    `--remap-path-prefix=${root}=/lazers`,
    `--remap-path-prefix=${cargoHome}=/cargo`,
    `--remap-path-prefix=${rustSysroot}=/rustc-sysroot`,
  ].join(" ")
}

async function compileWasm(
  target: string,
  wasi: { sdk: string; sysroot: string; clang: string },
  flags: string,
): Promise<void> {
  await run(["cargo", "build", "--release", "--locked", "--target", target], crateDir, {
    CARGO_TARGET_DIR: targetDir,
    CARGO_TARGET_WASM32_WASIP1_LINKER: wasi.clang,
    CC_wasm32_wasip1: wasi.clang,
    CFLAGS_wasm32_wasip1: `--sysroot=${wasi.sysroot}`,
    RUSTFLAGS: flags,
    WASI_SDK_PATH: wasi.sdk,
  })
}

async function optimizeWasm(raw: string, output: string): Promise<void> {
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
    output,
  ])
}

async function buildWorker(): Promise<{ sha256: string; bytes: number }> {
  const entry = join(root, "src/code-review/providers/cccc/code-review-cccc-worker.ts")
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    format: "esm",
    packages: "external",
    external: ["node:worker_threads", "node:wasi", "bun:sqlite"],
    minify: true,
  })
  if (!result.success) throw new AggregateError(result.logs, "cccc worker bundle failed")
  const output = result.outputs[0]
  if (!output) throw new Error("cccc worker bundle emitted no output")
  const bytes = new Uint8Array(await output.arrayBuffer())
  await mkdir(distDir, { recursive: true })
  await writeFile(join(distDir, workerName), bytes)
  return { sha256: sha256(bytes), bytes: bytes.byteLength }
}

async function buildApi(): Promise<{ sha256: string; bytes: number }> {
  const entry = join(root, "src/code-review/providers/cccc/index.ts")
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    format: "esm",
    packages: "external",
    external: ["node:worker_threads"],
    minify: true,
  })
  if (!result.success) throw new AggregateError(result.logs, "cccc public API bundle failed")
  const output = result.outputs[0]
  if (!output) throw new Error("cccc public API bundle emitted no output")
  const bytes = new Uint8Array(await output.arrayBuffer())
  await mkdir(distDir, { recursive: true })
  await writeFile(join(distDir, apiName), bytes)
  return { sha256: sha256(bytes), bytes: bytes.byteLength }
}

export async function buildCcccWasm() {
  if (!existsSync(join(crateDir, "Cargo.lock")))
    throw new Error(
      "cccc WASM lockfile is missing; generate and commit crates/cccc-wasm/Cargo.lock",
    )
  const upstream = JSON.parse(await readFile(join(root, "vendor/cccc/UPSTREAM.json"), "utf8")) as {
    version: string
    commit: string
  }
  await mkdir(wasmDir, { recursive: true })
  const rustc = await version(["rustc", "--version"])
  const cargo = await version(["cargo", "--version"])
  const wasmOpt = await version(["wasm-opt", "--version"])
  if (!new RegExp(`\\b${WASM_OPT_VERSION}\\b`).test(wasmOpt))
    throw new Error(`wasm-opt ${WASM_OPT_VERSION} is required; found ${wasmOpt}`)
  const module = await buildWasm()
  const api = await buildApi()
  const worker = await buildWorker()
  await mkdir(distDir, { recursive: true })
  await writeFile(join(distDir, wasmName), await readFile(join(wasmDir, wasmName)))
  const manifest = {
    upstreamTag: `v${upstream.version}`,
    upstreamCommit: upstream.commit,
    cargoLockSha256: sha256(await readFile(join(crateDir, "Cargo.lock"))),
    bindingSha256: await sourceHash(),
    optimization: { rustOptLevel: "s", lto: true, wasmOpt: WASM_OPT_VERSION, wasmOptFlags: "-O3" },
    module: { ...module, path: `src/code-review/providers/cccc/wasm/${wasmName}` },
    api: { ...api, path: `dist/${apiName}` },
    worker: { ...worker, path: `dist/${workerName}` },
    toolchain: { rustc, cargo, wasmOpt, bun: Bun.version },
  }
  await writeFile(join(wasmDir, "ARTIFACT.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`${manifest.module.path} ${module.bytes} bytes`)
  console.log(`${manifest.worker.path} ${worker.bytes} bytes`)
  return manifest
}

if (import.meta.main) await buildCcccWasm()
