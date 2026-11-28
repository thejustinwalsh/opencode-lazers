import type { WasmScanRequest } from "./contract.ts"

interface FunctionShape {
  name: string
  parameter: string
  stem: string
  literalOffset?: number
  typed?: boolean
  comment?: string
}

function functionSource(shape: FunctionShape): string {
  const annotation = shape.typed ? ": number[]" : ""
  const returnAnnotation = shape.typed ? ": number" : ""
  const offset = shape.literalOffset ?? 0
  const slots = Array.from(
    { length: 14 },
    (_, index) =>
      `  const ${shape.stem}Slot${index} = ${shape.parameter}[${index}] ?? ${index + offset}`,
  )
  const values = Array.from({ length: 14 }, (_, index) => `${shape.stem}Slot${index}`).join(", ")
  return [
    `export function ${shape.name}(${shape.parameter}${annotation})${returnAnnotation} {`,
    ...(shape.comment ? [`  // ${shape.comment}`] : []),
    `  const ${shape.stem}Scaled = ${shape.parameter}.map((item) => item * 2 + ${1 + offset})`,
    `  const ${shape.stem}Selected = ${shape.stem}Scaled.filter((item) => item >= ${offset})`,
    ...slots,
    `  const ${shape.stem}Total = ${shape.stem}Selected.reduce((sum, item) => sum + item, 0)`,
    `  return ${shape.stem}Total + ${values}`,
    "}",
    "",
  ].join("\n")
}

function gapPart(offset: number): string[] {
  return Array.from(
    { length: 22 },
    (_, index) =>
      `  const gapPart${offset + index} = values[${offset + index}] ?? ${offset + index}`,
  )
}

function gapSource(marker: string): string {
  return [
    "export function separated(values: number[]) {",
    ...gapPart(0),
    ...(marker === "B" ? ["  const insertedGap = values.slice(-1).length"] : []),
    ...gapPart(40),
    "  return values.length",
    "}",
    "",
  ].join("\n")
}

function renamedSource(name: string, parameter: string, stem: string, offset: number): string {
  const body = [
    `  let ${stem}Hash = 0`,
    `  for (let ${stem}Index = 0; ${stem}Index < ${parameter}.length; ${stem}Index += 1) {`,
    `    const ${stem}Value = ${parameter}[${stem}Index] ?? ${offset}`,
    `    const ${stem}Absolute = Math.abs(${stem}Value + ${offset})`,
    `    const ${stem}Rotated = (${stem}Absolute << (${stem}Index % 8)) | (${stem}Absolute >>> (32 - (${stem}Index % 8)))`,
    `    ${stem}Hash = (${stem}Hash ^ ${stem}Rotated) >>> 0`,
    `    ${stem}Hash = Math.imul(${stem}Hash, ${16_777_619 + offset}) >>> 0`,
    `    ${stem}Hash += Math.floor(${stem}Index / ${offset + 1})`,
    `    ${stem}Hash ^= ${stem}Value << 3`,
    `    ${stem}Hash = Math.abs(${stem}Hash) % ${2_147_483_647 + offset}`,
    `    ${stem}Hash = (${stem}Hash + Number.isFinite(${stem}Value)) >>> 0`,
    `    ${stem}Hash ^= Math.trunc(${stem}Value * ${3 + offset})`,
    `    ${stem}Hash = (${stem}Hash ^ Math.ceil(${stem}Index / ${2 + offset})) >>> 0`,
    `    ${stem}Hash = Math.floor(Math.sqrt(${stem}Hash * ${stem}Hash))`,
    `    ${stem}Hash += Number.parseInt(String(${stem}Value), 10)`,
    `    ${stem}Hash = (${stem}Hash + Math.round(${stem}Value / ${offset + 2})) >>> 0`,
    `    ${stem}Hash = (${stem}Hash ^ Math.clz32(${stem}Value)) >>> 0`,
    "  }",
    `  return ${stem}Hash`,
  ]
  return [`export function ${name}(${parameter}) {`, ...body, "}", ""].join("\n")
}

/** Generated source keeps the matched text out of checked-in fixtures and snapshots. */
export function makeParityRequest(): WasmScanRequest {
  const exact = functionSource({
    name: "copied",
    parameter: "items",
    stem: "measure",
    comment: "stable block",
  })
  const weakBase = functionSource({
    name: "annotated",
    parameter: "items",
    stem: "measure",
    comment: "base-only note",
  })
  const weakHead = functionSource({
    name: "annotated",
    parameter: "items",
    stem: "measure",
    comment: "head-only note",
  })
  const renamedA = renamedSource("renamedFirst", "leftItems", "left", 0)
  const renamedB = renamedSource("renamedSecond", "rightItems", "right", 100)
  const astA = functionSource({
    name: "similarFirst",
    parameter: "firstItems",
    stem: "first",
    literalOffset: 2,
  })
  const astB = functionSource({
    name: "similarSecond",
    parameter: "secondItems",
    stem: "second",
    literalOffset: 3,
  })
  const crossTs = functionSource({
    name: "crossed",
    parameter: "entries",
    stem: "result",
    typed: true,
  })
  const crossJs = functionSource({
    name: "crossed",
    parameter: "entries",
    stem: "result",
  })

  return {
    files: [
      { path: "src/exact-a.ts", format: "typescript", source: exact },
      { path: "src/exact-b.ts", format: "typescript", source: exact },
      { path: "src/weak-base.ts", format: "typescript", source: weakBase },
      { path: "src/weak-head.ts", format: "typescript", source: weakHead },
      { path: "src/renamed-a.js", format: "javascript", source: renamedA },
      { path: "src/renamed-b.js", format: "javascript", source: renamedB },
      { path: "src/ast-a.js", format: "javascript", source: astA },
      { path: "src/ast-b.js", format: "javascript", source: astB },
      { path: "src/gap-a.ts", format: "typescript", source: gapSource("A") },
      { path: "src/gap-b.ts", format: "typescript", source: gapSource("B") },
      { path: "src/cross.ts", format: "typescript", source: crossTs },
      { path: "src/cross.js", format: "javascript", source: crossJs },
    ],
    detectors: ["strict", "mild", "weak", "renamed", "gap", "ast", "cross-language"],
    minTokens: 50,
    minLines: 5,
    config: { mode: "mild" },
  }
}

export function makeEmbeddedParityRequest(): WasmScanRequest {
  const embedded = functionSource({
    name: "embeddedWorker",
    parameter: "values",
    stem: "measure",
    typed: true,
  })
  const component = `<template>\n  <section></section>\n</template>\n<script lang="ts">\n${embedded}</script>\n`
  return {
    files: [
      { path: "src/embedded-a.vue", format: "vue", source: component },
      { path: "src/embedded-b.vue", format: "vue", source: component },
    ],
    detectors: ["mild"],
    minTokens: 50,
    minLines: 5,
    config: { mode: "mild" },
  }
}
