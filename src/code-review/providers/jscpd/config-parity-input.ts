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
