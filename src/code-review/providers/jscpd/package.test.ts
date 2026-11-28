import { expect, test } from "bun:test"
import { buildJscpdProvider } from "../../../../scripts/build-jscpd-provider.ts"
import { makeParityRequest } from "./test-input.ts"
import type { DuplicationComparisonResult, JscpdComparisonInput } from "./contract.ts"

test("the bundled public provider uses its neighboring worker and WASM without leaking source", async () => {
  await buildJscpdProvider()
  const scan = makeParityRequest()
  const exact = scan.files.slice(0, 2)
  const newCopy = { ...scan.files[0]!, path: "src/new-copy.ts" }
  const comparison: JscpdComparisonInput = {
    comparisonID: "package-smoke-comparison",
    base: { files: exact, complete: true },
    head: { files: [...exact, newCopy], complete: true },
    changedLines: [{ path: newCopy.path, startLine: 1, endLine: 40 }],
  }
  const providerURL = new URL("../../../../dist/jscpd-provider.js", import.meta.url)
  const providerModule = (await import(providerURL.href)) as typeof import("./provider.ts")
  const result: DuplicationComparisonResult =
    await providerModule.analyzeDuplicationComparison(comparison)

  expect(result.comparisonID).toBe(comparison.comparisonID)
  expect(result.tool).toEqual({ name: "jscpd", version: "5.4.0" })
  expect(result.status).toBe("complete")
  expect(result.findings.length).toBeGreaterThan(0)
  const serialized = JSON.stringify(result)
  for (const file of [...exact, newCopy]) expect(serialized).not.toContain(file.source)
})
