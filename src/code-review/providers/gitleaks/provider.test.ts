import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { runFallowModule } from "../../../audit/fallow-wasi.ts"
import { GITLEAKS_VERSION, scanGitleaksComparison } from "./index.ts"
import {
  FAKE_AWS_KEY,
  GITLEAKS_PARITY_FIXTURES,
  readerFor,
  wasmRequest,
} from "../../../../test/code-review/gitleaks-fixtures/fixtures.ts"
import { runGitleaksWorker } from "./worker-client.ts"

async function moduleForTests(): Promise<WebAssembly.Module> {
  return WebAssembly.compile(
    await Bun.file(new URL("./wasm/gitleaks.wasm", import.meta.url)).arrayBuffer(),
  )
}

function fixtureReader() {
  const path = "src/config.ts"
  return readerFor({
    base: { [path]: "export const region = 'eu';\n" },
    head: {
      [path]: `export const region = 'eu';\nexport const key = "${FAKE_AWS_KEY}";\n`,
    },
    changedFiles: [{ path, status: "modified" }],
    changes: { [path]: [{ startLine: 2, endLine: 2 }] },
  })
}

test("Gitleaks reports only a comparison-introduced, redacted finding", async () => {
  const result = await scanGitleaksComparison(fixtureReader())

  expect(result.status).toBe("complete")
  expect(result.tool).toEqual({ id: "gitleaks", version: GITLEAKS_VERSION })
  expect(result.findings).toHaveLength(1)
  expect(result.findings[0]).toMatchObject({
    kind: "secret.introduced",
    rule: "aws-access-token",
    location: {
      side: "head",
      path: "src/config.ts",
      range: { startLine: 2, startCol: 0 },
      prPosition: { line: 2, side: "RIGHT" },
    },
    masked: "AKI********AM2",
  })
  const output = JSON.stringify(result)
  expect(output).not.toContain(FAKE_AWS_KEY)
  expect(output).not.toContain("export const key")
})

test("secret fingerprints are keyed per run rather than stable low-entropy hashes", async () => {
  const first = await scanGitleaksComparison(fixtureReader())
  const second = await scanGitleaksComparison(fixtureReader())

  expect(first.findings[0]?.fingerprint).toMatch(/^[0-9a-f]{32}$/)
  expect(second.findings[0]?.fingerprint).toMatch(/^[0-9a-f]{32}$/)
  expect(second.findings[0]?.fingerprint).not.toBe(first.findings[0]?.fingerprint)
})

test("Gitleaks comparison counts moves and reports only the additional copy", async () => {
  const result = await scanGitleaksComparison(
    readerFor({
      base: {
        "src/a.ts": `const key = "${FAKE_AWS_KEY}";\nconst count = 1;\n`,
        "src/b.ts": "export {};\n",
      },
      head: {
        "src/a.ts": `const key = "${FAKE_AWS_KEY}";\nconst count = 2;\n`,
        "src/b.ts": `const key = "${FAKE_AWS_KEY}";\n`,
      },
      changedFiles: [
        { path: "src/a.ts", status: "modified" },
        { path: "src/b.ts", status: "modified" },
      ],
      changes: {
        "src/a.ts": [{ startLine: 2, endLine: 2 }],
        "src/b.ts": [{ startLine: 1, endLine: 1 }],
      },
    }),
  )

  expect(result.findings.map((finding) => finding.location.path)).toEqual(["src/b.ts"])
})

test("renamed files compare old and new immutable side paths", async () => {
  const result = await scanGitleaksComparison(
    readerFor({
      base: { "src/old.ts": `const key = "${FAKE_AWS_KEY}";\nexport const n = 1;\n` },
      head: { "src/new.ts": `const key = "${FAKE_AWS_KEY}";\nexport const n = 2;\n` },
      changedFiles: [
        {
          path: "src/new.ts",
          previousPath: "src/old.ts",
          status: "renamed",
        },
      ],
      changes: { "src/new.ts": [{ startLine: 1, endLine: 2 }] },
    }),
  )

  expect(result.findings).toEqual([])
})

test("coordinates preserve UTF-16 line widths and CRLF line numbers", async () => {
  const path = "src/config.ts"
  const line = `  const label = "🚀"; const key = "${FAKE_AWS_KEY}";`
  const result = await scanGitleaksComparison(
    readerFor({
      base: { [path]: "export {};\r\n" },
      head: { [path]: `export {};\r\n${line}\r\n` },
      changedFiles: [{ path, status: "modified" }],
      changes: { [path]: [{ startLine: 2, endLine: 2 }] },
    }),
  )

  expect(result.findings[0]?.location.range).toEqual({
    startLine: 2,
    startCol: 2,
    endLine: 2,
    endCol: line.length,
  })
})

test("Gitleaks applies root ignore config and reports its comparison effect", async () => {
  const path = "src/config.ts"
  const result = await scanGitleaksComparison(
    readerFor({
      base: { [path]: "export {};\n" },
      head: { [path]: `export const key = "${FAKE_AWS_KEY}";\n` },
      changedFiles: [
        { path, status: "modified" },
        { path: ".gitleaksignore", status: "added" },
      ],
      changes: {
        [path]: [{ startLine: 1, endLine: 1 }],
        ".gitleaksignore": [{ startLine: 1, endLine: 1 }],
      },
      headIgnore: `${path}:aws-access-token:1\n`,
    }),
  )

  expect(result.findings).toHaveLength(0)
  expect(result.allowlistChange).toMatchObject({
    kind: "secret.allowlist.changed",
    leftOut: 1,
    added: [`${path}:aws-access-token:1`],
  })
  expect(JSON.stringify(result)).not.toContain(FAKE_AWS_KEY)
})

test("Gitleaks resolves config extensions from captured side content", async () => {
  const fixture = GITLEAKS_PARITY_FIXTURES.find(({ name }) => name === "captured-config-include")!
  const result = await scanGitleaksComparison(readerFor(fixture.fixture))

  expect(result.findings).toHaveLength(0)
  expect(result.allowlistChange?.leftOut).toBe(1)
})

test("Gitleaks reports an inline allow marker without exposing source", async () => {
  const path = "src/config.ts"
  const result = await scanGitleaksComparison(
    readerFor({
      base: { [path]: "export {};\n" },
      head: { [path]: `const key = "${FAKE_AWS_KEY}"; // gitleaks:allow\n` },
      changedFiles: [{ path, status: "modified" }],
      changes: { [path]: [{ startLine: 1, endLine: 1 }] },
    }),
  )

  expect(result.findings).toHaveLength(0)
  expect(result.inlineAllow).toHaveLength(1)
  expect(result.inlineAllow[0]).toMatchObject({
    kind: "secret.allow.inline",
    leftOut: 1,
    matches: [{ rule: "aws-access-token", masked: "AKI********AM2" }],
  })
  expect(JSON.stringify(result)).not.toContain(FAKE_AWS_KEY)
  expect(JSON.stringify(result)).not.toContain("const key")
})

test("missing change ranges degrade the comparison and preserve findings as unclassified", async () => {
  const base = readerFor({
    base: { "src/config.ts": "export const region = 'eu';\n" },
    head: {
      "src/config.ts": `export const region = 'eu';\nexport const key = "${FAKE_AWS_KEY}";\n`,
    },
    changedFiles: [{ path: "src/config.ts", status: "modified" }],
    changes: {},
    changesStatus: "unavailable",
  })
  const result = await scanGitleaksComparison(base)

  expect(result.status).toBe("degraded")
  expect(result.findings).toHaveLength(0)
  expect(result.unclassified).toHaveLength(1)
  expect(result.coverage.skipped).toContainEqual({
    side: "comparison",
    reason: "change-ranges-unavailable",
  })
})

test("an unavailable base file degrades classification instead of claiming introduction", async () => {
  const path = "src/config.ts"
  const reader = readerFor({
    base: {},
    head: { [path]: `const key = "${FAKE_AWS_KEY}";\n` },
    changedFiles: [{ path, status: "modified" }],
    changes: { [path]: [{ startLine: 1, endLine: 1 }] },
  })
  const result = await scanGitleaksComparison(reader)

  expect(result.status).toBe("degraded")
  expect(result.findings).toHaveLength(0)
  expect(result.unclassified).toHaveLength(1)
  expect(result.coverage.skipped).toContainEqual({
    side: "base",
    path,
    reason: "source-unavailable",
  })
})

test("provider byte limits return typed degraded coverage without echoing content", async () => {
  const result = await scanGitleaksComparison(fixtureReader(), {
    maxFileBytes: 2_000_000,
    maxInputBytes: 1,
    timeoutMs: 120_000,
  })

  expect(result.status).toBe("failed")
  expect(result.failure).toEqual({ code: "input-too-large" })
  expect(result.coverage.skipped).toContainEqual({
    side: "comparison",
    reason: "input-byte-limit",
  })
  expect(JSON.stringify(result)).not.toContain(FAKE_AWS_KEY)
})

test("worker failures do not echo secret-bearing input or error messages", async () => {
  const result = await scanGitleaksComparison(fixtureReader(), undefined, {
    run: async () => {
      throw new Error(`${FAKE_AWS_KEY} private worker diagnostic`)
    },
  })

  expect(result.status).toBe("failed")
  expect(result.failure).toEqual({ code: "worker-failed" })
  expect(JSON.stringify(result)).not.toContain(FAKE_AWS_KEY)
  expect(JSON.stringify(result)).not.toContain("private worker diagnostic")
})

test("ambient GITLEAKS configuration cannot override captured side config", async () => {
  const previousConfig = process.env.GITLEAKS_CONFIG
  const previousToml = process.env.GITLEAKS_CONFIG_TOML
  process.env.GITLEAKS_CONFIG = "/host-only/gitleaks.toml"
  process.env.GITLEAKS_CONFIG_TOML = "not a captured configuration"
  try {
    const result = await scanGitleaksComparison(fixtureReader())
    expect(result.status).toBe("complete")
    expect(result.findings).toHaveLength(1)
  } finally {
    if (previousConfig === undefined) delete process.env.GITLEAKS_CONFIG
    else process.env.GITLEAKS_CONFIG = previousConfig
    if (previousToml === undefined) delete process.env.GITLEAKS_CONFIG_TOML
    else process.env.GITLEAKS_CONFIG_TOML = previousToml
  }
})

test("obsolete comparison results are discarded after WASM completes", async () => {
  let checks = 0
  const reader = {
    ...fixtureReader(),
    isCurrent: () => ++checks === 1,
  }
  const result = await scanGitleaksComparison(reader)

  expect(result.status).toBe("stale")
  expect(result.findings).toEqual([])
})

test("an aborted provider does not start source reads or return findings", async () => {
  const controller = new AbortController()
  controller.abort()
  let reads = 0
  const reader = {
    ...fixtureReader(),
    read: async () => {
      reads++
      return { status: "absent" as const }
    },
  }
  const result = await scanGitleaksComparison(reader, undefined, undefined, controller.signal)

  expect(result.status).toBe("cancelled")
  expect(result.findings).toEqual([])
  expect(reads).toBe(0)
})

test("worker cancellation terminates an in-flight WASI run", async () => {
  const module = await moduleForTests()
  const controller = new AbortController()
  const request = wasmRequest({
    base: {},
    head: {},
    changedFiles: [],
    changes: {},
  })
  const pending = runGitleaksWorker(module, request, controller.signal, 120_000)
  controller.abort()

  await expect(pending).rejects.toMatchObject({
    code: "cancelled",
  })
})

test("repeated isolated runs release worker and WASI resources", async () => {
  for (let count = 0; count < 3; count++) {
    const result = await scanGitleaksComparison(fixtureReader())
    expect(result.findings).toHaveLength(1)
  }
  Bun.gc(true)
})

test("the WASI response contains no source text or matched secret", async () => {
  const fixture = {
    base: { "src/config.ts": "export {};\n" },
    head: {
      "src/config.ts": `export const key = "${FAKE_AWS_KEY}";\n`,
    },
    changedFiles: [{ path: "src/config.ts", status: "added" as const }],
    changes: { "src/config.ts": [{ startLine: 1, endLine: 1 }] },
  }
  const module = await moduleForTests()
  const request = wasmRequest(fixture)
  const root = mkdtempSync(join(tmpdir(), "gitleaks-parity-"))
  try {
    const wasm = runFallowModule(module, {
      op: "gitleaks",
      root,
      payload: request,
    })
    expect(wasm.exitCode).toBe(0)
    expect(wasm.stderr).toBe("")
    expect(wasm.stdout).not.toContain(FAKE_AWS_KEY)
    expect(wasm.stdout).not.toContain("export const key")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
