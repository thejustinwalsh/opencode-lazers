import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { Worker } from "node:worker_threads"
import { workerURL } from "../../../worker-url.ts"
import { makeEmbeddedParityRequest, makeParityRequest } from "./test-input.ts"
import { runJscpdSide } from "./worker-client.ts"
import type { JscpdSideReport } from "./contract.ts"

const pairs = (report: Awaited<ReturnType<typeof runJscpdSide>>, detector: string) =>
  report.detectors.find((item) => item.detector === detector)?.clones ?? []

test("the owned WASI worker exercises all seven detectors without returning source text", async () => {
  const request = makeParityRequest()
  const report = await runJscpdSide(request, { timeoutMs: 120_000 })

  expect(report.detectors.map((item) => item.detector)).toEqual([...request.detectors])
  expect(report.coverage).toEqual({
    filesReceived: request.files.length,
    filesScanned: request.files.length,
    filesUnsupported: 0,
    filesIgnored: 0,
  })
  expect(pairs(report, "strict").some((clone) => clone.first.path.endsWith("exact-a.ts"))).toBe(
    true,
  )
  expect(
    pairs(report, "weak").some(
      (clone) =>
        clone.first.path.endsWith("weak-base.ts") || clone.second.path.endsWith("weak-base.ts"),
    ),
  ).toBe(true)
  expect(
    pairs(report, "renamed").some(
      (clone) =>
        clone.kind === "renamed" &&
        [clone.first.path, clone.second.path].some((path) => path.endsWith("renamed-a.js")) &&
        [clone.first.path, clone.second.path].some((path) => path.endsWith("renamed-b.js")),
    ),
  ).toBe(true)
  expect(
    pairs(report, "gap").some(
      (clone) =>
        clone.kind === "gap" &&
        [clone.first.path, clone.second.path].some((path) => path.endsWith("gap-a.ts")) &&
        [clone.first.path, clone.second.path].some((path) => path.endsWith("gap-b.ts")),
    ),
  ).toBe(true)
  expect(
    pairs(report, "ast").some(
      (clone) =>
        clone.kind === "similar" &&
        [clone.first.path, clone.second.path].some((path) => path.endsWith("ast-a.js")) &&
        [clone.first.path, clone.second.path].some((path) => path.endsWith("ast-b.js")),
    ),
  ).toBe(true)
  expect(
    pairs(report, "cross-language").some(
      (clone) =>
        [clone.first.path, clone.second.path].some((path) => path.endsWith("cross.ts")) &&
        [clone.first.path, clone.second.path].some((path) => path.endsWith("cross.js")),
    ),
  ).toBe(true)
  const serialized = JSON.stringify(report)
  for (const file of request.files) expect(serialized).not.toContain(file.source)
})

test("fresh workers release WASI state between repeated scans", async () => {
  const request = makeParityRequest()
  let exits = 0
  const workerFactory = () => {
    const worker = new Worker(workerURL("./jscpd-worker", import.meta.url))
    worker.on("exit", () => exits++)
    return worker
  }
  const first = await runJscpdSide(request, { timeoutMs: 120_000, workerFactory })
  expect(exits).toBe(1)
  const second = await runJscpdSide(request, { timeoutMs: 120_000, workerFactory })
  expect(exits).toBe(2)
  expect(second).toEqual(first)
})

test("side globs and unsupported formats are reflected in scan coverage", async () => {
  const request = makeParityRequest()
  const report = await runJscpdSide(
    {
      ...request,
      files: [
        request.files[0]!,
        request.files[1]!,
        {
          path: "assets/payload.jscpd-unknown",
          source: "one\ntwo\nthree\nfour\nfive\n",
        },
      ],
      detectors: ["mild"],
      config: { mode: "mild", ignore: ["src/exact-b.ts"] },
    },
    { timeoutMs: 120_000 },
  )

  expect(report.coverage).toEqual({
    filesReceived: 3,
    filesScanned: 1,
    filesUnsupported: 1,
    filesIgnored: 1,
  })
  expect(pairs(report, "mild")).toEqual([])
})

test("configured cross-format groups compare TypeScript and JavaScript in regular detector modes", async () => {
  const request = makeParityRequest()
  const files = request.files.filter((file) => ["src/cross.ts", "src/cross.js"].includes(file.path))
  const report = await runJscpdSide(
    {
      ...request,
      files,
      detectors: ["mild"],
      config: {
        mode: "mild",
        crossFormats: [["javascript", "typescript"]],
      },
    },
    { timeoutMs: 120_000 },
  )

  expect(
    pairs(report, "mild").some(
      (clone) =>
        [clone.first.path, clone.second.path].includes("src/cross.ts") &&
        [clone.first.path, clone.second.path].includes("src/cross.js"),
    ),
  ).toBe(true)
})

test("embedded Vue scripts retain host-file locations and source-free reports", async () => {
  const request = makeEmbeddedParityRequest()
  const report = await runJscpdSide(request, { timeoutMs: 120_000 })
  const clone = pairs(report, "mild").find(
    (item) => item.first.path === "src/embedded-a.vue" && item.second.path === "src/embedded-b.vue",
  )

  expect(clone).toBeDefined()
  expect(clone?.first.startLine).toBeGreaterThan(4)
  expect(clone?.second.startLine).toBeGreaterThan(4)
  expect(JSON.stringify(report)).not.toContain(request.files[0]?.source)
})

test("aborting a running worker rejects safely and a successor worker still answers", async () => {
  const request = makeParityRequest()
  const controller = new AbortController()
  let exited = false
  const pending = runJscpdSide(request, {
    signal: controller.signal,
    timeoutMs: 120_000,
    workerFactory: () => {
      const worker = new Worker(workerURL("./jscpd-worker", import.meta.url))
      worker.on("exit", () => {
        exited = true
      })
      return worker
    },
  })
  controller.abort(new Error("private source must not escape"))
  await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  expect(exited).toBe(true)

  const report = await runJscpdSide(request, { timeoutMs: 120_000 })
  expect(report.detectors).toHaveLength(7)
})

class DeferredTerminationWorker extends EventEmitter {
  releaseTermination: (() => void) | undefined
  terminationStarted = false

  postMessage(): void {}

  terminate(): Promise<number> {
    this.terminationStarted = true
    return new Promise((resolve) => {
      this.releaseTermination = () => {
        this.emit("exit", 1)
        resolve(1)
      }
    })
  }
}

const emptyReport: JscpdSideReport = {
  detectors: [],
  coverage: { filesReceived: 0, filesScanned: 0, filesUnsupported: 0, filesIgnored: 0 },
}

test("success waits for worker termination before resolving", async () => {
  const worker = new DeferredTerminationWorker()
  let settled = false
  const pending = runJscpdSide(makeParityRequest(), {
    timeoutMs: 120_000,
    workerFactory: () => worker as unknown as Worker,
  }).then((report) => {
    settled = true
    return report
  })

  worker.emit("message", { id: 1, ok: true, report: emptyReport })
  await Promise.resolve()
  expect(worker.terminationStarted).toBe(true)
  expect(settled).toBe(false)

  worker.releaseTermination?.()
  await expect(pending).resolves.toEqual(emptyReport)
  expect(settled).toBe(true)
})

test("abort waits for worker termination before rejecting", async () => {
  const worker = new DeferredTerminationWorker()
  const controller = new AbortController()
  let settled = false
  const pending = runJscpdSide(makeParityRequest(), {
    signal: controller.signal,
    timeoutMs: 120_000,
    workerFactory: () => worker as unknown as Worker,
  }).finally(() => {
    settled = true
  })

  controller.abort()
  await Promise.resolve()
  expect(worker.terminationStarted).toBe(true)
  expect(settled).toBe(false)

  worker.releaseTermination?.()
  await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  expect(settled).toBe(true)
})

test("timeout waits for worker termination before rejecting", async () => {
  const worker = new DeferredTerminationWorker()
  let settled = false
  const pending = runJscpdSide(makeParityRequest(), {
    timeoutMs: 1,
    workerFactory: () => worker as unknown as Worker,
  }).finally(() => {
    settled = true
  })

  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  expect(worker.terminationStarted).toBe(true)
  expect(settled).toBe(false)

  worker.releaseTermination?.()
  await expect(pending).rejects.toMatchObject({ code: "analyzer-timeout" })
  expect(settled).toBe(true)
})

test("worker failure waits for termination and hides worker error text", async () => {
  const worker = new DeferredTerminationWorker()
  let settled = false
  const pending = runJscpdSide(makeParityRequest(), {
    timeoutMs: 120_000,
    workerFactory: () => worker as unknown as Worker,
  }).finally(() => {
    settled = true
  })

  worker.emit("error", new Error("private matched source canary"))
  await Promise.resolve()
  expect(worker.terminationStarted).toBe(true)
  expect(settled).toBe(false)

  worker.releaseTermination?.()
  await expect(pending).rejects.toMatchObject({
    code: "worker-failed",
    message: "The duplication analyzer is unavailable.",
  })
  expect(settled).toBe(true)
})
