import { expect, test } from "bun:test"
import {
  assertParityEvidence,
  type NativeParityReports,
  type PackagedParityResult,
} from "./jscpd-parity-evidence.ts"

const nativeReports: NativeParityReports = [
  {
    clones: [
      { first: { path: "src/custom.jscpd-ts" }, second: { path: "generated/keep.jscpd-ts" } },
      { first: { path: "src/custom-source" }, second: { path: "src/custom.jscpd-ts" } },
    ],
  },
]

function packagedResult(filesIgnored: number, findingCount: number): PackagedParityResult {
  return {
    findings: Array.from({ length: findingCount }),
    coverage: {
      base: { filesIgnored },
      head: { filesIgnored },
    },
  }
}

test("parity evidence requires positive native and packaged results and configured paths", () => {
  const evidence = {
    minimumBasePairs: 2,
    requiredBasePaths: ["src/custom.jscpd-ts", "generated/keep.jscpd-ts"],
    excludedBasePaths: ["generated/drop.jscpd-ts"],
    minimumFindings: 1,
    minimumIgnoredFiles: 2,
  }

  expect(
    assertParityEvidence("captured-config", evidence, nativeReports, packagedResult(2, 1)),
  ).toBe(2)
  expect(() =>
    assertParityEvidence(
      "captured-config",
      { ...evidence, minimumBasePairs: 3 },
      nativeReports,
      packagedResult(2, 1),
    ),
  ).toThrow("Pinned jscpd returned too few base clones in parity case captured-config.")
  expect(() =>
    assertParityEvidence(
      "captured-config",
      { ...evidence, minimumFindings: 2 },
      nativeReports,
      packagedResult(2, 1),
    ),
  ).toThrow("Packaged provider returned too few findings in parity case captured-config.")
  expect(() =>
    assertParityEvidence("captured-config", evidence, nativeReports, packagedResult(1, 1)),
  ).toThrow("Packaged provider did not apply captured filters in parity case captured-config.")
  expect(() =>
    assertParityEvidence(
      "captured-config",
      { ...evidence, requiredBasePaths: ["src/missing.jscpd-ts"] },
      nativeReports,
      packagedResult(2, 1),
    ),
  ).toThrow("Pinned jscpd omitted expected configured path in parity case captured-config.")
  expect(() =>
    assertParityEvidence(
      "captured-config",
      { ...evidence, excludedBasePaths: ["generated/keep.jscpd-ts"] },
      nativeReports,
      packagedResult(2, 1),
    ),
  ).toThrow("Pinned jscpd scanned an excluded configured path in parity case captured-config.")
})
