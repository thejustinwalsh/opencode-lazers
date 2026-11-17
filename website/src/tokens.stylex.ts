import * as stylex from "@stylexjs/stylex"

export const color = stylex.defineVars({
  paper: "#F7F6EF",
  paperEdge: "#E9E8F6",
  ink: "#13095E",
  inkDeep: "#0E0159",
  peri: "#A3A5F9",
  periMid: "#5855A7",
  periSoft: "#D8D9FC",
  magenta: "#F81497",
  magentaDeep: "#ED017A",
  cyan: "#19EBF1",
})

export const type = stylex.defineVars({
  face: '"Archivo Variable", "Archivo", sans-serif',
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
})

export const bp = stylex.defineConsts({
  wide: "@media (min-width: 900px)",
  mid: "@media (min-width: 640px)",
})
