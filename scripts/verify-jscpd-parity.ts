import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runFallowModule } from "../src/audit/fallow-wasi.ts"
import {
  makeEmbeddedParityRequest,
  makeParityRequest,
} from "../src/code-review/providers/jscpd/test-input.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const crate = join(root, "crates/jscpd-wasm")
const target = join(root, ".cache/jscpd-parity-target")
const wasmPath = join(root, "src/code-review/providers/jscpd/jscpd.wasm")
const nativeExecutable = join(
  target,
  "release",
  process.platform === "win32" ? "jscpd-wasm.exe" : "jscpd-wasm",
)
const environment = {
  ...process.env,
  CARGO_TARGET_DIR: target,
  RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN ?? "1.99.0",
}

async function run(command: string[], stdin?: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: root,
    env: environment,
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "inherit",
  })
  if (stdin !== undefined) {
    child.stdin?.write(stdin)
    child.stdin?.end()
  }
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  if (code !== 0) throw new Error(`${command[0]} exited with code ${code}`)
  return stdout
}

await mkdir(target, { recursive: true })
await run(["cargo", "build", "--release", "--locked", "--manifest-path", join(crate, "Cargo.toml")])

const wasm = new WebAssembly.Module(await Bun.file(wasmPath).arrayBuffer())
const requests = [makeParityRequest(), makeEmbeddedParityRequest()]
const reports = requests.map((scan) => {
  const request = { op: "scan", root: process.cwd(), ...scan }
  const outcome = runFallowModule(wasm, request)
  if (outcome.exitCode !== undefined && outcome.exitCode !== 0)
    throw new Error("The WASI jscpd adapter exited unsuccessfully.")
  return {
    request,
    wasm: JSON.stringify(JSON.parse(outcome.stdout)),
  }
})
for (const { request, wasm: wasiReport } of reports) {
  const nativeReport = JSON.stringify(
    JSON.parse(await run([nativeExecutable], JSON.stringify(request))),
  )
  if (nativeReport !== wasiReport) throw new Error("Native and WASI jscpd reports differ.")
}
const summaries = reports.map(
  ({ wasm }) =>
    JSON.parse(wasm) as {
      detectors: Array<{ detector: string; clones: unknown[] }>
    },
)
const detectorCount = summaries[0]?.detectors.length ?? 0
const pairCount = summaries.reduce(
  (total, report) =>
    total + report.detectors.reduce((sum, detector) => sum + detector.clones.length, 0),
  0,
)
console.log(
  `Native/WASI jscpd parity passed: ${detectorCount} detectors plus embedded Vue, ${pairCount} clone pairs.`,
)
