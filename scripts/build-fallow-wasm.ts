import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { patchSetSha256 } from "./vendor-fallow.ts"

/**
 * Builds the vendored Fallow analysis to WebAssembly and writes the committed artifact:
 *
 *   bun scripts/build-fallow-wasm.ts
 *
 *   cargo build --release --locked  ->  wasm-bindgen --target web  ->  wasm-opt -Oz
 *   -> src/audit/wasm/{fallow.wasm, fallow.js, fallow.d.ts, ARTIFACT.json}
 *
 * Needs rustc with the wasm32-unknown-unknown target, `wasm-bindgen` at exactly the version of
 * the `wasm-bindgen` crate in crates/fallow-wasm/Cargo.lock, and `wasm-opt` on PATH.
 */
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

async function lockedBindgenVersion() {
  const lock = await readFile(join(crateDir, "Cargo.lock"), "utf8")
  const match = /name = "wasm-bindgen"\nversion = "([^"]+)"/.exec(lock)
  if (!match?.[1]) throw new Error("wasm-bindgen is not in crates/fallow-wasm/Cargo.lock")
  return match[1]
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

export async function buildFallowWasm() {
  const upstream = JSON.parse(await readFile(join(root, "vendor/fallow/UPSTREAM.json"), "utf8"))
  const toolchain = {
    rustc: await version(["rustc", "--version"]),
    cargo: await version(["cargo", "--version"]),
    wasmBindgen: await version(["wasm-bindgen", "--version"]),
    wasmOpt: await version(["wasm-opt", "--version"]),
  }
  const locked = await lockedBindgenVersion()
  if (!toolchain.wasmBindgen.endsWith(` ${locked}`)) {
    throw new Error(
      `wasm-bindgen CLI must be ${locked}: cargo install wasm-bindgen-cli --version ${locked} --locked`,
    )
  }

  const sysroot = (await run(["rustc", "--print", "sysroot"])).trim()
  await run(
    ["cargo", "build", "--release", "--locked", "--target", "wasm32-unknown-unknown"],
    crateDir,
    {
      CARGO_TARGET_DIR: targetDir,
      // Replaces .cargo/config.toml rustflags, so the entropy cfg is repeated. The path remaps keep
      // panic locations from embedding this checkout's or the user's cargo home path.
      CARGO_ENCODED_RUSTFLAGS: [
        "--cfg",
        'getrandom_backend="custom"',
        `--remap-path-prefix=${root.replace(/\/$/, "")}=/lazers`,
        `--remap-path-prefix=${cargoHome}=/cargo`,
        `--remap-path-prefix=${sysroot}=/rustc-sysroot`,
      ].join("\x1f"),
    },
  )
  const raw = join(targetDir, "wasm32-unknown-unknown/release/fallow_wasm.wasm")
  const stage = join(targetDir, "bindgen")
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  await run(["wasm-bindgen", "--target", "web", "--out-dir", stage, "--out-name", "fallow", raw])

  await mkdir(outDir, { recursive: true })
  const wasmPath = join(outDir, "fallow.wasm")
  await run([
    "wasm-opt",
    "-Oz",
    "--enable-bulk-memory",
    "--enable-sign-ext",
    "--enable-mutable-globals",
    "--enable-nontrapping-float-to-int",
    "--enable-multivalue",
    "--enable-reference-types",
    join(stage, "fallow_bg.wasm"),
    "-o",
    wasmPath,
  ])
  const glue = (await readFile(join(stage, "fallow.js"), "utf8")).replaceAll(
    "fallow_bg.wasm",
    "fallow.wasm",
  )
  await writeFile(join(outDir, "fallow.js"), glue)
  await writeFile(join(outDir, "fallow.d.ts"), await readFile(join(stage, "fallow.d.ts")))

  const wasm = await readFile(wasmPath)
  const manifest = {
    upstreamTag: upstream.tag as string,
    upstreamCommit: upstream.commit as string,
    patchSetSha256: await patchSetSha256(),
    bindingSha256: await bindingSha256(),
    wasmSha256: sha256(wasm),
    bytes: wasm.byteLength,
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
