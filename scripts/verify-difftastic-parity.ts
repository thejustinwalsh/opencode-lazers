import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  DIFFTASTIC_VERSION,
  StructuralCompareRequestSchema,
  type ValidStructuralCompareRequest,
} from "../src/code-review/structural/contract.ts"
import { structuralDiffFromJson } from "../src/code-review/structural/structural-diff.ts"
import { compareStructural } from "../src/code-review/structural/worker-client.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixturesRoot = join(root, "test/code-review/structural-fixtures")
const recordControlled = globalThis.process.argv.includes("--record-controlled")
const nativeBinary = globalThis.process.env.DIFFTASTIC_NATIVE_BIN

type ParityCase = {
  fixture: string
  path: string
  snapshot: string
  origin: "oaink" | "controlled"
  missingSide?: "base" | "head"
  limits?: ValidStructuralCompareRequest["limits"]
}

const cases: ParityCase[] = [
  {
    fixture: "signature-change",
    path: "src/price.ts",
    snapshot: "signature-change--src-price.ts.json",
    origin: "oaink",
  },
  {
    fixture: "signature-change",
    path: "src/cart.ts",
    snapshot: "signature-change--src-cart.ts.json",
    origin: "oaink",
  },
  {
    fixture: "format-only",
    path: "src/config.ts",
    snapshot: "format-only--src-config.ts.json",
    origin: "oaink",
  },
  {
    fixture: "rename-only",
    path: "src/queue.ts",
    snapshot: "rename-only--src-queue.ts.json",
    origin: "oaink",
  },
  {
    fixture: "unparseable-file",
    path: "src/broken.ts",
    snapshot: "unparseable-file--src-broken.ts.json",
    origin: "oaink",
  },
  {
    fixture: "rust-trait-impl",
    path: "src/lib.rs",
    snapshot: "rust-trait-impl--src-lib.rs.json",
    origin: "oaink",
  },
  {
    fixture: "signature-change",
    path: "src/price.ts",
    snapshot: "fallback/byte-limit.json",
    origin: "oaink",
    limits: { byteLimit: 10, graphLimit: 3_000_000, parseErrorLimit: 0 },
  },
  {
    fixture: "signature-change",
    path: "src/price.ts",
    snapshot: "fallback/graph-limit.json",
    origin: "oaink",
    limits: { byteLimit: 1_000_000, graphLimit: 1, parseErrorLimit: 0 },
  },
  {
    fixture: "signature-change",
    path: "src/price.ts",
    snapshot: "fallback/created.json",
    origin: "oaink",
    missingSide: "base",
  },
  {
    fixture: "signature-change",
    path: "src/price.ts",
    snapshot: "fallback/deleted.json",
    origin: "oaink",
    missingSide: "head",
  },
  {
    fixture: "controlled-unicode",
    path: "sample.ts",
    snapshot: "controlled-unicode--sample.ts.json",
    origin: "controlled",
  },
  {
    fixture: "controlled-final-newline",
    path: "sample.ts",
    snapshot: "controlled-final-newline--sample.ts.json",
    origin: "controlled",
  },
  {
    fixture: "controlled-empty",
    path: "empty.ts",
    snapshot: "controlled-empty--empty.ts.json",
    origin: "controlled",
  },
  {
    fixture: "controlled-empty-present",
    path: "empty.ts",
    snapshot: "controlled-empty-present--empty.ts.json",
    origin: "controlled",
  },
]

async function run(
  command: string[],
  cwd = root,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  const process = Bun.spawn(command, {
    cwd,
    env: { ...globalThis.process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (code !== 0)
    throw new Error(
      `${command.join(" ")} exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(-2000)}` : ""}`,
    )
  return { stdout, stderr }
}

async function readSource(
  fixture: string,
  side: "base" | "head",
  path: string,
): Promise<string | null> {
  const fixturePath = `${path}.fixture`
  try {
    return await readFile(join(fixturesRoot, "fixtures", fixture, side, fixturePath), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

function sidePath(side: "base" | "head", path: string, source: string | null): string {
  return source === null ? "/dev/null" : `${side}/${path}`
}

async function nativeJson(
  executable: string,
  item: ParityCase,
  request: ValidStructuralCompareRequest,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lazers-difftastic-parity-"))
  try {
    for (const [side, source] of [
      ["base", request.base],
      ["head", request.head],
    ] as const) {
      if (source === null) continue
      const path = join(directory, side, item.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, source)
    }
    const { stdout } = await run(
      [
        executable,
        "--display",
        "json",
        sidePath("base", item.path, request.base),
        sidePath("head", item.path, request.head),
      ],
      directory,
      {
        DFT_UNSTABLE: "yes",
        DFT_BYTE_LIMIT: String(request.limits.byteLimit),
        DFT_GRAPH_LIMIT: String(request.limits.graphLimit),
        DFT_PARSE_ERROR_LIMIT: String(request.limits.parseErrorLimit),
      },
    )
    return stdout
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function requestFor(item: ParityCase): Promise<ValidStructuralCompareRequest> {
  return StructuralCompareRequestSchema.parse({
    path: item.path,
    base: item.missingSide === "base" ? null : await readSource(item.fixture, "base", item.path),
    head: item.missingSide === "head" ? null : await readSource(item.fixture, "head", item.path),
    ...(item.limits ? { limits: item.limits } : {}),
  })
}

async function readSnapshot(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && recordControlled) return undefined
    throw error
  })
}

async function writeControlledSnapshot(path: string, output: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, output)
}

function verifyPinnedSnapshot(
  path: string,
  output: string,
  recordedSnapshot: string | undefined,
): void {
  if (!nativeBinary) return
  if (recordedSnapshot === undefined) throw new Error(`Missing pinned snapshot ${basename(path)}`)
  assert.deepStrictEqual(
    JSON.parse(output),
    JSON.parse(recordedSnapshot),
    `Pinned native output drifted from ${basename(path)}`,
  )
}

async function retainOrVerifySnapshot(
  item: ParityCase,
  path: string,
  output: string,
  recordedSnapshot: string | undefined,
): Promise<void> {
  if (recordControlled && item.origin === "controlled") {
    await writeControlledSnapshot(path, output)
    return
  }
  verifyPinnedSnapshot(path, output, recordedSnapshot)
}

async function verifyCase(item: ParityCase): Promise<void> {
  const request = await requestFor(item)
  const snapshotPath = join(fixturesRoot, "snapshots", item.snapshot)
  const recordedSnapshot = await readSnapshot(snapshotPath)
  const output = nativeBinary ? await nativeJson(nativeBinary, item, request) : recordedSnapshot
  if (output === undefined)
    throw new Error(
      `Missing native snapshot ${item.snapshot}; use --record-controlled with a pinned native binary`,
    )
  await retainOrVerifySnapshot(item, snapshotPath, output, recordedSnapshot)

  const [native, wasm] = await Promise.all([
    Promise.resolve(structuralDiffFromJson(output, request)),
    compareStructural(request, { timeoutMs: 60_000 }),
  ])
  assert.deepStrictEqual(wasm, native, `Native/WASM projection mismatch: ${item.snapshot}`)
  console.log(`PASS ${item.snapshot}`)
}

const sourcePin = JSON.parse(
  await readFile(join(root, "vendor/difftastic/UPSTREAM.json"), "utf8"),
) as { tag: string; commit: string }
if (
  sourcePin.tag !== DIFFTASTIC_VERSION ||
  sourcePin.commit !== "b7d119e90ac9f972f03f69508da765dacd302c0c"
)
  throw new Error("Vendored Difftastic source pin does not match the expected 0.71.0 revision")
const fixtureVersion = (
  await readFile(join(fixturesRoot, "snapshots/DIFFTASTIC_VERSION"), "utf8")
).trim()
if (fixtureVersion !== DIFFTASTIC_VERSION)
  throw new Error(`Fixture oracle is ${fixtureVersion}; expected ${DIFFTASTIC_VERSION}`)
if (recordControlled && !nativeBinary)
  throw new Error(
    "Set DIFFTASTIC_NATIVE_BIN to the pinned native 0.71.0 binary when recording fixtures",
  )
if (nativeBinary) {
  const version = (await run([nativeBinary, "--version"])).stdout
  if (!version.includes(DIFFTASTIC_VERSION))
    throw new Error(`Expected pinned Difftastic ${DIFFTASTIC_VERSION}, received ${version.trim()}`)
}

for (const item of cases) await verifyCase(item)
console.log(
  `Verified ${cases.length} WASM results against pinned Difftastic ${DIFFTASTIC_VERSION} snapshots`,
)
