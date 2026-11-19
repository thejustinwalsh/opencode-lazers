import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { patchSetSha256 } from "./vendor-fallow.ts"

/**
 * Builds the vendored Fallow analysis to two WebAssembly (WASI preview 1) commands and writes
 * the committed artifacts:
 *
 *   bun scripts/build-fallow-wasm.ts [fallow.wasm] [fallow-threads.wasm]
 *
 *   cargo build --release --locked --target wasm32-wasip1          ->  wasm-opt -O3
 *   cargo build --release --locked --target wasm32-wasip1-threads  ->  wasm-opt -O3
 *   -> src/audit/wasm/{fallow.wasm, fallow-threads.wasm, ARTIFACT.json}
 *
 * The threaded module imports a shared memory and a thread-spawn call the host serves (see
 * `src/audit/fallow-wasi.ts`); the analyzer uses it only for large projects.
 * Needs rustc with both targets and `wasm-opt` on PATH.
 */
const MODULES = [
  { file: "fallow.wasm", target: "wasm32-wasip1", threads: false },
  { file: "fallow-threads.wasm", target: "wasm32-wasip1-threads", threads: true },
] as const
const WASM_OPT_LEVEL = "-O3"
const root = fileURLToPath(new URL("..", import.meta.url))
const crateDir = join(root, "crates/fallow-wasm")
const targetDir = join(root, ".cache/fallow-wasm-target")
const outDir = join(root, "src/audit/wasm")
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo")
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")

async function run(cmd: string[], cwd = root, env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "inherit",
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`)
  return out
}

async function version(cmd: string[]) {
  try {
    return (await run(cmd)).trim().split("\n")[0] ?? "unknown"
  } catch {
    throw new Error(`${cmd[0]} is not available; see the header of scripts/build-fallow-wasm.ts`)
  }
}

/** Hash of the binding crate sources, so a changed binding is visible in the manifest. */
async function bindingSha256() {
  const hash = createHash("sha256")
  const walk = async (dir: string) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else hash.update(`${path.slice(crateDir.length)}\0`).update(await readFile(path))
    }
  }
  await walk(join(crateDir, "src"))
  for (const file of ["Cargo.toml", "Cargo.lock", ".cargo/config.toml"]) {
    hash.update(`${file}\0`).update(await readFile(join(crateDir, file)))
  }
  return hash.digest("hex")
}

/** Imports the module asks of its host, so a changed surface shows in the committed manifest. */
async function importList(wasm: Uint8Array) {
  const module = await WebAssembly.compile(wasm)
  return WebAssembly.Module.imports(module)
    .map((entry) => `${entry.module}.${entry.name}`)
    .sort()
}

async function buildModule(
  module: (typeof MODULES)[number],
  flags: string[],
): Promise<{ target: string; wasmSha256: string; bytes: number; imports: string[] }> {
  await run(["cargo", "build", "--release", "--locked", "--target", module.target], crateDir, {
    CARGO_TARGET_DIR: targetDir,
    // Replaces .cargo/config.toml rustflags, so the target's flags are repeated there and here.
    CARGO_ENCODED_RUSTFLAGS: [
      ...flags,
      ...(module.threads
        ? ["-C", "link-arg=--initial-memory=4294901760", "-C", "link-arg=--max-memory=4294967296"]
        : []),
    ].join("\x1f"),
  })
  const raw = join(targetDir, `${module.target}/release/fallow-wasi.wasm`)
  const wasmPath = join(outDir, module.file)
  await run([
    "wasm-opt",
    WASM_OPT_LEVEL,
    "--strip-debug",
    "--strip-producers",
    "--enable-bulk-memory",
    "--enable-sign-ext",
    "--enable-mutable-globals",
    "--enable-nontrapping-float-to-int",
    "--enable-multivalue",
    "--enable-reference-types",
    ...(module.threads ? ["--enable-threads"] : []),
    raw,
    "-o",
    wasmPath,
  ])
  const wasm = await readFile(wasmPath)
  console.log(`src/audit/wasm/${module.file} ${wasm.byteLength} bytes`)
  return {
    target: module.target,
    wasmSha256: sha256(wasm),
    bytes: wasm.byteLength,
    imports: await importList(wasm),
  }
}

/** Build the named modules (default: all); the others keep their entry in the manifest. */
export async function buildFallowWasm(only: readonly string[] = []) {
  const upstream = JSON.parse(await readFile(join(root, "vendor/fallow/UPSTREAM.json"), "utf8"))
  const toolchain = {
    rustc: await version(["rustc", "--version"]),
    cargo: await version(["cargo", "--version"]),
    wasmOpt: await version(["wasm-opt", "--version"]),
  }
  const sysroot = (await run(["rustc", "--print", "sysroot"])).trim()
  // The path remaps keep panic locations from embedding this checkout's or the user's cargo home.
  const flags = [
    "-C",
    "link-arg=-zstack-size=16777216",
    `--remap-path-prefix=${root.replace(/\/$/, "")}=/lazers`,
    `--remap-path-prefix=${cargoHome}=/cargo`,
    `--remap-path-prefix=${sysroot}=/rustc-sysroot`,
  ]
  await mkdir(outDir, { recursive: true })
  const previous = existsSync(join(outDir, "ARTIFACT.json"))
    ? (JSON.parse(await readFile(join(outDir, "ARTIFACT.json"), "utf8")).modules ?? {})
    : {}
  const modules: Record<string, Awaited<ReturnType<typeof buildModule>>> = { ...previous }
  for (const module of MODULES) {
    if (only.length > 0 && !only.includes(module.file)) continue
    modules[module.file] = await buildModule(module, flags)
    // The two targets share nothing worth keeping; free the disk between builds.
    await rm(join(targetDir, module.target), { recursive: true, force: true })
  }
  const manifest = {
    upstreamTag: upstream.tag as string,
    upstreamCommit: upstream.commit as string,
    patchSetSha256: await patchSetSha256(),
    bindingSha256: await bindingSha256(),
    optimization: { rustOptLevel: 3, wasmOpt: WASM_OPT_LEVEL },
    modules,
    toolchain,
  }
  await writeFile(join(outDir, "ARTIFACT.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

if (import.meta.main) {
  if (!existsSync(join(root, "vendor/fallow/UPSTREAM.json"))) {
    throw new Error("vendor/fallow is missing; run: bun scripts/vendor-fallow.ts")
  }
  await buildFallowWasm(process.argv.slice(2))
}
