import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runFallowModule } from "../src/audit/fallow-wasi.ts"
import { wasmURL } from "../src/worker-url.ts"
import {
  FAKE_AWS_KEY,
  FAKE_AWS_OTHER,
  FAKE_AWS_SAME_ENDS,
  FAKE_GITHUB_TOKEN,
  FAKE_PRIVATE_KEY,
  GITLEAKS_PARITY_FIXTURES,
  GITLEAKS_PARITY_EXPECTATIONS,
  wasmRequest,
} from "../test/code-review/gitleaks-fixtures/fixtures.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const crate = join(root, "crates/gitleaks-wasm")
const target = join(root, ".cache/gitleaks-wasm-target")
const native = join(target, "gitleaks-native-gore2regex")
const wasmPath = wasmURL(
  "./wasm/gitleaks.wasm",
  new URL("../src/code-review/providers/gitleaks/provider.ts", import.meta.url).href,
)

async function run(command: string[], cwd = root, env: Record<string, string> = {}) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...Bun.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (status !== 0) {
    void stderr
    throw new Error(`${command[0]} exited ${status}`)
  }
  return stdout.trim()
}

async function nativeResult(envelope: string): Promise<string> {
  const child = Bun.spawn([native], {
    cwd: root,
    stdin: new Blob([envelope]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (status !== 0) {
    void stderr
    throw new Error(`native Gitleaks oracle exited ${status}`)
  }
  return stdout.trim()
}

function parseOutput(output: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isSuccessfulEnvelope(value: unknown): value is { result: Record<string, unknown> } {
  return isRecord(value) && value.ok === true && isRecord(value.result)
}

function resultFromOutput(name: string, output: string): Record<string, unknown> {
  const envelope = parseOutput(output)
  if (!isSuccessfulEnvelope(envelope)) throw new Error(`invalid Gitleaks parity output: ${name}`)
  return envelope.result
}

function arrayCount(value: Record<string, unknown>, key: string): number {
  const result = value[key]
  return Array.isArray(result) ? result.length : -1
}

function allowlistLeftOut(value: Record<string, unknown>): number {
  const allowlist = value.allowlist
  const count = isRecord(allowlist) ? allowlist.leftOut : undefined
  return typeof count === "number" ? count : 0
}

function matchesExpected(
  result: Record<string, unknown>,
  expected: (typeof GITLEAKS_PARITY_EXPECTATIONS)[string],
): boolean {
  const actual = {
    introduced: arrayCount(result, "introduced"),
    inline: arrayCount(result, "inline"),
    allowlistLeftOut: allowlistLeftOut(result),
  }
  return (
    actual.introduced === expected.introduced &&
    (expected.inline === undefined || actual.inline === expected.inline) &&
    (expected.allowlistLeftOut === undefined ||
      actual.allowlistLeftOut === expected.allowlistLeftOut)
  )
}

export function verifyGitleaksExpectations(name: string, output: string): void {
  const expected = GITLEAKS_PARITY_EXPECTATIONS[name]
  if (!expected) throw new Error(`missing Gitleaks fixture expectation: ${name}`)
  const result = resultFromOutput(name, output)
  if (!matchesExpected(result, expected))
    throw new Error(`Gitleaks fixture classification mismatch: ${name}`)
}

async function buildNativeOracle(): Promise<void> {
  await run(
    [
      "go",
      "build",
      "-mod=readonly",
      "-tags=gore2regex",
      "-trimpath",
      "-buildvcs=false",
      "-o",
      native,
      ".",
    ],
    crate,
    { GOTOOLCHAIN: "local" },
  )
}

async function packagedModule(): Promise<WebAssembly.Module> {
  return WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer())
}

function privacyCanaries(): string[] {
  const privateLines = FAKE_PRIVATE_KEY.split("\n")
  return [
    FAKE_AWS_KEY,
    FAKE_AWS_OTHER,
    FAKE_AWS_SAME_ENDS,
    FAKE_GITHUB_TOKEN,
    ...privateLines.slice(1, -1),
  ]
}

async function wasmResult(
  module: WebAssembly.Module,
  request: ReturnType<typeof wasmRequest>,
): Promise<string> {
  const runRoot = mkdtempSync(join(tmpdir(), "gitleaks-parity-"))
  try {
    const outcome = runFallowModule(module, { op: "gitleaks", root: runRoot, payload: request })
    if (outcome.exitCode !== 0)
      throw new Error(`WASM Gitleaks exited ${outcome.exitCode ?? "without a status"}`)
    if (outcome.stderr !== "") throw new Error("WASM Gitleaks wrote diagnostics")
    return outcome.stdout.trim()
  } finally {
    rmSync(runRoot, { recursive: true, force: true })
  }
}

async function verifyFixture(
  module: WebAssembly.Module,
  fixture: (typeof GITLEAKS_PARITY_FIXTURES)[number],
  secrets: readonly string[],
): Promise<void> {
  const { name } = fixture
  const request = wasmRequest(fixture.fixture)
  const envelope = JSON.stringify({ op: "gitleaks", payload: request })
  const nativeOutput = await nativeResult(envelope)
  const output = await wasmResult(module, request)
  if (nativeOutput !== output) throw new Error(`native/WASM Gitleaks parity mismatch: ${name}`)
  verifyGitleaksExpectations(name, output)
  if (secrets.some((secret) => secret && output.includes(secret)))
    throw new Error(`Gitleaks output exposed a matched value: ${name}`)
}

export async function verifyGitleaksParity(): Promise<void> {
  mkdirSync(target, { recursive: true })
  await buildNativeOracle()
  try {
    const module = await packagedModule()
    const secrets = privacyCanaries()
    for (const fixture of GITLEAKS_PARITY_FIXTURES) await verifyFixture(module, fixture, secrets)
  } finally {
    rmSync(native, { force: true })
  }
  console.log(`Gitleaks native/WASM parity passed: ${GITLEAKS_PARITY_FIXTURES.length} fixtures`)
}

if (import.meta.main) await verifyGitleaksParity()
