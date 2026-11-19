import { beforeAll, expect, test } from "bun:test"
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"
import { buildServer } from "../../scripts/build-server.ts"
import { buildCurrentPriceIndex } from "../models/current-price-index.ts"
import { ModelDecisionReadInputSchema } from "../models/decision-contract.ts"
import { createThreadedDecisionReader } from "../models/decision-worker-client.ts"
import {
  defaultModelPriceSourcePolicy,
  ModelPriceSourceSettingsSchema,
} from "../models/price-source-settings.ts"
import { makeLedgerFixture } from "../../test/models-observation-ledger/fixtures/ledger.ts"
import { workerURL } from "../worker-url.ts"
import { computeGeneration } from "./generation.ts"
import sourcePlugin from "../index.ts"

const dist = fileURLToPath(new URL("../../dist/", import.meta.url))

beforeAll(async () => {
  await buildServer()
}, 60_000)

test("build emits one server file plus its workers, and the bundle exports the same plugin", async () => {
  expect(readdirSync(dist).filter((file) => file.endsWith(".js"))).toEqual(
    expect.arrayContaining([
      "server.js",
      "processor.js",
      "repo-worker.js",
      "decision-worker.js",
      "fallow-worker.js",
      "fallow-thread.js",
    ]),
  )
  const built = (await import(`${dist}server.js`)) as { default: typeof sourcePlugin }
  expect(Object.keys(built)).toEqual(["default"])
  expect(built.default.id).toBe(sourcePlugin.id)
  expect(Object.keys(built.default)).toEqual(Object.keys(sourcePlugin))
  expect(typeof built.default.effect).toBe("function")
})

test("generation of a bundle follows its contents, not its mtime or path", () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-bundle-"))
  try {
    const bundle = join(directory, "server.js")
    writeFileSync(bundle, "export default 1\n")
    const first = computeGeneration(directory, bundle)
    expect(computeGeneration(directory, bundle)).toBe(first)
    const copy = join(directory, "copy.js")
    copyFileSync(bundle, copy)
    expect(computeGeneration(directory, copy)).toBe(first)
    writeFileSync(bundle, "export default 2\n")
    expect(computeGeneration(directory, bundle)).not.toBe(first)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("bundled workers start from the built output", async () => {
  const processor = new Worker(pathToFileURL(`${dist}processor.js`))
  const first = await new Promise<{ patterns: unknown[] }>((resolve, reject) => {
    processor.once("message", resolve)
    processor.once("error", reject)
  })
  await processor.terminate()
  expect(first.patterns.length).toBeGreaterThan(0)

  const fixture = makeLedgerFixture()
  const settings = ModelPriceSourceSettingsSchema.parse({
    policy: defaultModelPriceSourcePolicy(),
    access: { openrouter: "configured", opencode: "not-configured" },
  })
  const reader = createThreadedDecisionReader({
    path: fixture.path,
    projectDirectory: fixture.projectDirectory,
    workerURL: pathToFileURL(`${dist}decision-worker.js`),
    readPriceState: async (routes) => ({
      settings,
      index: buildCurrentPriceIndex({
        sourceStore: { readComparisonSources: () => [] },
        priceSources: settings,
        observedRoutes: routes,
      }),
      freshness: "current",
    }),
  })
  try {
    const overview = await reader.overview(
      ModelDecisionReadInputSchema.parse({
        schemaVersion: 2,
        scope: { projectDirectory: fixture.projectDirectory },
        filters: { persona: null, taskKind: null, period: { from: null, to: null } },
      }),
    )
    expect(overview.context.snapshotID).toBeTruthy()
  } finally {
    reader.close()
    fixture.close()
  }
}, 60_000)

test("worker URLs resolve beside the bundle and fall back to source", () => {
  expect(workerURL("./processor", "file:///x/dist/server.js").href).toBe(
    "file:///x/dist/processor.js",
  )
  expect(workerURL("./decision-worker", "file:///x/src/models/a.ts").href).toBe(
    "file:///x/src/models/decision-worker.ts",
  )
})

test("the bundled fallow worker finds both modules and its thread script, and answers on threads and off", async () => {
  const root = mkdtempSync(join(tmpdir(), "lz-bundle-fallow-"))
  const branches = Array.from({ length: 25 }, (_, i) => `  if (a === ${i}) return ${i}`).join("\n")
  writeFileSync(join(root, "package.json"), '{"name":"bundle-fixture"}')
  writeFileSync(
    join(root, "complex.ts"),
    `export function route(a: number) {\n${branches}\n  return -1\n}\n`,
  )
  const worker = new Worker(pathToFileURL(`${dist}fallow-worker.js`))
  type Reply = {
    id?: number
    ok?: boolean
    report?: { functions: { file: string; name: string }[]; unused_files?: unknown[] }
    error?: unknown
    fallback?: string
  }
  const ask = (request: Record<string, unknown>) =>
    new Promise<Reply>((resolve, reject) => {
      worker.once("error", reject)
      const onMessage = (message: Reply & { ready?: true }) => {
        if (message.ready) return
        worker.off("message", onMessage)
        resolve(message)
      }
      worker.on("message", onMessage)
      worker.postMessage({ root, ...request })
    })
  try {
    await new Promise((resolve) => worker.once("message", resolve))
    for (const [id, threads] of [
      [1, "off"],
      [2, "on"],
    ] as const) {
      const complexity = await ask({ id, kind: "complexity", files: ["complex.ts"], threads })
      expect(complexity.error).toBeUndefined()
      expect(complexity.report?.functions.map((f) => f.name)).toEqual(["route"])
    }
    // A whole-project run on the threaded module needs dist/fallow-threads.wasm and
    // dist/fallow-thread.js; a fallback would name the one that is missing.
    const dead = await ask({ id: 3, kind: "deadCode", threads: "on" })
    expect(dead.error).toBeUndefined()
    expect(dead.ok).toBe(true)
    expect(dead.fallback).toBeUndefined()
  } finally {
    await worker.terminate()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
