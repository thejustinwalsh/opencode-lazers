import { expect, test } from "bun:test"
import { scanGitleaksComparison } from "./index.ts"
import {
  FAKE_AWS_KEY,
  readerFor,
  type SecretFixture,
} from "../../../../test/code-review/gitleaks-fixtures/fixtures.ts"

const CAPTURED_COMPARISON_ID = "0123456789abcdef".repeat(4)
const BASE_REVISION = `${"0123456789abcdef".repeat(2)}01234567`
const HEAD_REVISION = "fedcba9876543210".repeat(4)

const fixture: SecretFixture = {
  base: { "src/config.ts": "export {};\n" },
  head: { "src/config.ts": `export const key = "${FAKE_AWS_KEY}";\n` },
  changedFiles: [{ path: "src/config.ts", status: "modified" }],
  changes: { "src/config.ts": [{ startLine: 1, endLine: 1 }] },
}

function capturedReader() {
  return {
    ...readerFor(fixture),
    comparisonID: CAPTURED_COMPARISON_ID,
    baseRevision: BASE_REVISION,
    headRevision: HEAD_REVISION,
  }
}

async function outcomeResults(reader: ReturnType<typeof capturedReader>) {
  const success = await scanGitleaksComparison(reader)
  const failure = await scanGitleaksComparison(reader, undefined, {
    run: async () => {
      throw new Error("private worker diagnostic")
    },
  })
  const stale = await scanGitleaksComparison({ ...reader, isCurrent: () => false })
  const controller = new AbortController()
  controller.abort()
  const cancelled = await scanGitleaksComparison(reader, undefined, undefined, controller.signal)
  const duringRunController = new AbortController()
  const cancelledDuringRun = await scanGitleaksComparison(
    reader,
    undefined,
    {
      run: async () => {
        duringRunController.abort()
        throw new Error("private cancellation diagnostic")
      },
    },
    duringRunController.signal,
  )
  const degraded = await scanGitleaksComparison({
    ...reader,
    changedLines: { ...reader.changedLines, status: "unavailable" },
  })

  return [success, failure, stale, cancelled, cancelledDuringRun, degraded]
}

test("captured 64-hex comparison IDs and full Git revisions stay unchanged across outcomes", async () => {
  const results = await outcomeResults(capturedReader())

  expect(results.map(({ status }) => status)).toEqual([
    "complete",
    "failed",
    "stale",
    "cancelled",
    "cancelled",
    "degraded",
  ])
  for (const result of results) {
    expect(result.identity).toEqual({
      comparisonID: CAPTURED_COMPARISON_ID,
      baseRevision: BASE_REVISION,
      headRevision: HEAD_REVISION,
    })
  }
})

test("descriptive secret-bearing identity metadata aliases consistently without being echoed", async () => {
  const privateMetadata = "private-comparison-secret-192ae6"
  const reader = {
    ...capturedReader(),
    comparisonID: `comparison-${privateMetadata}`,
    baseRevision: `base-${privateMetadata}`,
    headRevision: `head-${privateMetadata}`,
  }
  const results = await outcomeResults(reader)

  expect(results.map(({ status }) => status)).toEqual([
    "complete",
    "failed",
    "stale",
    "cancelled",
    "cancelled",
    "degraded",
  ])
  for (const result of results) {
    expect(result.identity).toEqual(results[0]!.identity)
    expect(JSON.stringify(result)).not.toContain(privateMetadata)
  }
})
