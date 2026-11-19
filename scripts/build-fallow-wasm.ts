import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { patchSetSha256 } from "./vendor-fallow.ts"

/**
 * Builds the vendored Fallow analysis to a WebAssembly (WASI preview 1) command and writes the
 * committed artifact:
 *
 *   bun scripts/build-fallow-wasm.ts
 *
 *   cargo build --release --locked --target wasm32-wasip1  ->  wasm-opt -Oz
 *   -> src/audit/wasm/{fallow.wasm, ARTIFACT.json}
 *
 * Needs rustc with the wasm32-wasip1 target and `wasm-opt` on PATH.
 */
const TARGET = "wasm32-wasip1"
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

export async function buildFallowWasm() {
  const upstream = JSON.parse(await readFile(join(root, "vendor/fallow/UPSTREAM.json"), "utf8"))
  const toolchain = {
    rustc: await version(["rustc", "--version"]),
    cargo: await version(["cargo", "--version"]),
    wasmOpt: await version(["wasm-opt", "--version"]),
  }
  const sysroot = (await run(["rustc", "--print", "sysroot"])).trim()
  await run(["cargo", "build", "--release", "--locked", "--target", TARGET], crateDir, {
    CARGO_TARGET_DIR: targetDir,
    // Replaces .cargo/config.toml rustflags, so the stack size is repeated. The path remaps keep
    // panic locations from embedding this checkout's or the user's cargo home path.
    CARGO_ENCODED_RUSTFLAGS: [
      "-C",
      "link-arg=-zstack-size=16777216",
      `--remap-path-prefix=${root.replace(/\/$/, "")}=/lazers`,
      `--remap-path-prefix=${cargoHome}=/cargo`,
      `--remap-path-prefix=${sysroot}=/rustc-sysroot`,
    ].join("\x1f"),
  })
  const raw = join(targetDir, `${TARGET}/release/fallow-wasi.wasm`)

  await mkdir(outDir, { recursive: true })
  const wasmPath = join(outDir, "fallow.wasm")
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
    raw,
    "-o",
    wasmPath,
  ])

  const wasm = await readFile(wasmPath)
  const manifest = {
    upstreamTag: upstream.tag as string,
    upstreamCommit: upstream.commit as string,
    target: TARGET,
    patchSetSha256: await patchSetSha256(),
    bindingSha256: await bindingSha256(),
    wasmSha256: sha256(wasm),
    bytes: wasm.byteLength,
    imports: await importList(wasm),
    toolchain,
  }
  await writeFile(join(outDir, "ARTIFACT.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`src/audit/wasm/fallow.wasm ${manifest.bytes} bytes sha256 ${manifest.wasmSha256}`)
  return manifest
}

if (import.meta.main) {
  if (!existsSync(join(root, "vendor/fallow/UPSTREAM.json"))) {
    throw new Error("vendor/fallow is missing; run: bun scripts/vendor-fallow.ts")
  }
  await buildFallowWasm()
}
