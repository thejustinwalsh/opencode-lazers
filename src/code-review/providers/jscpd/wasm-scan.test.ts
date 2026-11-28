import { expect, test } from "bun:test"
import { executeJscpdScan, parseJscpdResponse } from "./wasm-scan.ts"
import { makeParityRequest } from "./test-input.ts"

test("the buffered adapter scans all detectors and its parsed report excludes source text", async () => {
  const scan = makeParityRequest()
  const module = await WebAssembly.compile(
    await Bun.file(new URL("./jscpd.wasm", import.meta.url)).arrayBuffer(),
  )
  const report = parseJscpdResponse(executeJscpdScan(module, scan))

  expect(report.detectors.map((item) => item.detector)).toEqual([...scan.detectors])
  const serialized = JSON.stringify(report)
  for (const file of scan.files) expect(serialized).not.toContain(file.source)
})

test("adapter failures return safe codes without forwarding source-like error bodies", () => {
  expect(() =>
    parseJscpdResponse('{"error":{"code":"invalid-request","source":"captured input"}}'),
  ).toThrow(expect.objectContaining({ code: "invalid-request" }))
  expect(() => parseJscpdResponse("not JSON with source material")).toThrow(
    expect.objectContaining({ code: "analyzer-unavailable" }),
  )
})

test("the adapter boundary strips unexpected source-bearing fields", () => {
  const report = parseJscpdResponse(
    JSON.stringify({
      detectors: [
        {
          detector: "mild",
          clones: [
            {
              fingerprint: "jscpd:0123456789ab",
              format: "typescript",
              kind: "exact",
              tokens: 80,
              lines: 10,
              first: { path: "src/a.ts", startLine: 1, endLine: 10 },
              second: { path: "src/b.ts", startLine: 1, endLine: 10 },
              matchedSource: "canary secret source",
            },
          ],
        },
      ],
      coverage: {
        filesReceived: 2,
        filesScanned: 2,
        filesUnsupported: 0,
        filesIgnored: 0,
        source: "canary secret source",
      },
    }),
  )

  expect(JSON.stringify(report)).not.toContain("canary secret source")
  expect(report.detectors[0]?.clones[0]).not.toHaveProperty("matchedSource")
})

test("the adapter rejects clone fingerprints that cannot be safe identities", () => {
  const output = JSON.stringify({
    detectors: [
      {
        detector: "mild",
        clones: [
          {
            fingerprint: "source-like matched text",
            format: "typescript",
            kind: "exact",
            tokens: 80,
            lines: 10,
            first: { path: "src/a.ts", startLine: 1, endLine: 10 },
            second: { path: "src/b.ts", startLine: 1, endLine: 10 },
          },
        ],
      },
    ],
    coverage: { filesReceived: 2, filesScanned: 2, filesUnsupported: 0, filesIgnored: 0 },
  })

  expect(() => parseJscpdResponse(output)).toThrow(
    expect.objectContaining({ code: "analyzer-unavailable" }),
  )
})
