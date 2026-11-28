import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  DEFAULT_GITLEAKS_SETTINGS,
  GITLEAKS_PROVIDER_ID,
  GITLEAKS_TOOL,
  GITLEAKS_VERSION,
  type GitleaksAllowlistChange,
  type GitleaksChangedFile,
  type GitleaksComparisonReader,
  type GitleaksCoverage,
  type GitleaksFailureCode,
  type GitleaksFileStatus,
  type GitleaksIntroducedFinding,
  type GitleaksInlineAllow,
  type GitleaksLineRange,
  type GitleaksLocation,
  type GitleaksProviderSeams,
  type GitleaksResult,
  type GitleaksSettings,
  type GitleaksSide,
  type GitleaksSkippedInput,
  type GitleaksSkipReason,
  type GitleaksSourceRead,
  type GitleaksUnclassifiedFinding,
} from "./index.ts"
import { GITLEAKS_SERVER_ASSETS, GITLEAKS_SERVER_ENTRIES } from "./build-contribution.ts"
import { decodeGitleaksWasmOutput } from "./gitleaks-worker.ts"
import { wasmURL, workerURL } from "../../../worker-url.ts"

type PublicSurface =
  | GitleaksAllowlistChange
  | GitleaksChangedFile
  | GitleaksComparisonReader
  | GitleaksCoverage
  | GitleaksFailureCode
  | GitleaksFileStatus
  | GitleaksIntroducedFinding
  | GitleaksInlineAllow
  | GitleaksLineRange
  | GitleaksLocation
  | GitleaksProviderSeams
  | GitleaksResult
  | GitleaksSettings
  | GitleaksSide
  | GitleaksSkippedInput
  | GitleaksSkipReason
  | GitleaksSourceRead
  | GitleaksUnclassifiedFinding

test("provider-owned bundle contributions resolve beside the package server entry", () => {
  const publicTypes: PublicSurface[] = []
  expect(publicTypes).toEqual([])
  expect(DEFAULT_GITLEAKS_SETTINGS.timeoutMs).toBeGreaterThan(0)
  expect(GITLEAKS_PROVIDER_ID).toBe("gitleaks")
  expect(GITLEAKS_TOOL).toBe("gitleaks")
  expect(GITLEAKS_VERSION).toBe("8.30.1")

  const base = "file:///opt/lazers/dist/server.js"

  expect(GITLEAKS_SERVER_ENTRIES).toEqual([
    ["src/code-review/providers/gitleaks/gitleaks-worker.ts", "gitleaks-worker.js"],
  ])
  expect(GITLEAKS_SERVER_ASSETS).toEqual([
    ["src/code-review/providers/gitleaks/wasm/gitleaks.wasm", "gitleaks.wasm"],
  ])
  expect(workerURL("./gitleaks-worker", base).href).toBe(
    "file:///opt/lazers/dist/gitleaks-worker.js",
  )
  expect(wasmURL("./wasm/gitleaks.wasm", base).href).toBe("file:///opt/lazers/dist/gitleaks.wasm")
})

test("worker decoder returns only typed failure codes for malformed or failed output", () => {
  expect(decodeGitleaksWasmOutput("not-json", 0)).toEqual({
    ok: false,
    code: "invalid-output",
  })
  expect(
    decodeGitleaksWasmOutput(
      JSON.stringify({ ok: false, code: "invalid-config", diagnostic: "private source text" }),
      0,
    ),
  ).toEqual({ ok: false, code: "invalid-config" })
  expect(decodeGitleaksWasmOutput("{}", 1)).toEqual({ ok: false, code: "worker-exit" })
})

test("packaged provenance and license manifest identify the pinned analyzer", async () => {
  const artifact = JSON.parse(
    await Bun.file(new URL("./wasm/ARTIFACT.json", import.meta.url)).text(),
  ) as {
    upstream: { version: string; commit: string; license: string; regex: string }
    wasm: { file: string; bytes: number; sha256: string; imports: string[] }
    serverContribution: { entries: string[][]; assets: string[][] }
    licenses: { module: string; files: string[] }[]
  }

  expect(artifact.upstream).toMatchObject({
    version: "8.30.1",
    commit: "83d9cd684c87d95d656c1458ef04895a7f1cbd8e",
    license: "MIT",
    regex: "Go standard-library regexp",
  })
  expect(artifact.wasm.file).toBe("gitleaks.wasm")
  const wasmBytes = await Bun.file(new URL("./wasm/gitleaks.wasm", import.meta.url)).arrayBuffer()
  expect(wasmBytes.byteLength).toBe(artifact.wasm.bytes)
  expect(artifact.wasm.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(createHash("sha256").update(new Uint8Array(wasmBytes)).digest("hex")).toBe(
    artifact.wasm.sha256,
  )
  expect(artifact.serverContribution.assets).toEqual(
    GITLEAKS_SERVER_ASSETS.map(([source, output]) => [source, output]),
  )
  expect(artifact.serverContribution.entries).toEqual(
    GITLEAKS_SERVER_ENTRIES.map(([source, output]) => [source, output]),
  )
  const licenses = artifact.licenses.flatMap((module) => module.files)
  expect(licenses).toContain("github.com_zricethezav_gitleaks_v8__LICENSE.txt")
  expect(licenses).toContain("golang-BSD.txt")
  expect(
    await Bun.file(
      new URL(
        "../../../../licenses/gitleaks/github.com_zricethezav_gitleaks_v8__LICENSE.txt",
        import.meta.url,
      ),
    ).exists(),
  ).toBe(true)
  expect(
    await Bun.file(
      new URL("../../../../licenses/gitleaks/golang-BSD.txt", import.meta.url),
    ).exists(),
  ).toBe(true)
})
