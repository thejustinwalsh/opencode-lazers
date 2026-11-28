import type { WasmScanRequest } from "./contract.ts"
import { makeParityRequest } from "./test-input.ts"

const repeatedSource = makeParityRequest().files[0]!.source

export function makeCapturedConfigParityRequest(): WasmScanRequest {
  return {
    files: [
      { path: "src/custom.jscpd-ts", source: repeatedSource },
      { path: "src/custom-source", source: repeatedSource },
      { path: "generated/drop.jscpd-ts", source: repeatedSource },
      { path: "generated/keep.jscpd-ts", source: repeatedSource },
      { path: "src/plain.js", source: repeatedSource },
    ],
    ignoreFiles: [
      { path: ".gitignore", contents: "generated/*.jscpd-ts\n" },
      { path: "generated/.gitignore", contents: "!keep.jscpd-ts\n" },
    ],
    detectors: ["mild"],
    minTokens: 50,
    minLines: 5,
    config: {
      mode: "mild",
      formats: ["typescript"],
      formatsExts: { typescript: ["jscpd-ts"] },
      formatsNames: { typescript: ["custom-source"] },
    },
  }
}

export function makeIsolatedConfigParityRequest(): WasmScanRequest {
  return {
    files: [
      { path: "packages/a/first.ts", format: "typescript", source: repeatedSource },
      { path: "packages/b/second.ts", format: "typescript", source: repeatedSource },
    ],
    ignoreFiles: [],
    detectors: ["mild"],
    minTokens: 50,
    minLines: 5,
    config: {
      mode: "mild",
      skipIsolated: [["packages/a", "packages/b"]],
    },
  }
}

export function makeSizeLimitParityRequest(): WasmScanRequest {
  const oversizedSource = `${repeatedSource}\n// ${"x".repeat(1_300)}\n`
  return {
    files: [
      { path: "src/size-small-a.ts", source: repeatedSource },
      { path: "src/size-small-b.ts", source: repeatedSource },
      { path: "src/size-large-a.ts", source: oversizedSource },
      { path: "src/size-large-b.ts", source: oversizedSource },
    ],
    ignoreFiles: [],
    detectors: ["mild"],
    minTokens: 50,
    minLines: 5,
    config: { mode: "mild", maxSize: "2kb" },
  }
}
