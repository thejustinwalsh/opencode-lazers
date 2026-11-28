import type {
  CcccFileReport,
  CcccFunctionFinding,
  CcccFunctionReport,
  CcccLanguage,
  CcccSide,
  CcccSettings,
} from "./types.ts"

export interface FlatFunction {
  name: string
  kind: string
  path: string
  line: number
  endLine: number
  cognitive: number
  cyclomatic: number
  language: CcccLanguage
}

export interface FunctionPair {
  base: FlatFunction
  head: FlatFunction
}

function walkFunctions(
  functions: readonly CcccFunctionReport[],
  language: CcccLanguage,
  path: string,
  entries: { fn: FlatFunction; size: number }[],
): void {
  for (const item of functions) {
    const at = entries.length
    entries.push({
      fn: {
        name: item.name || "<anonymous>",
        kind: item.kind,
        path,
        line: item.line,
        endLine: item.line,
        cognitive: item.cognitive,
        cyclomatic: item.cyclomatic,
        language,
      },
      size: 1,
    })
    walkFunctions(item.children ?? [], language, path, entries)
    entries[at]!.size = entries.length - at
  }
}

export function flattenFunctions(report: CcccFileReport, lastLine: number): FlatFunction[] {
  const entries: { fn: FlatFunction; size: number }[] = []
  walkFunctions(report.functions, report.language, report.path, entries)
  entries.forEach((entry, index) => {
    const next = entries[index + entry.size]
    entry.fn.endLine = Math.max(entry.fn.line, next ? next.fn.line - 1 : lastLine)
  })
  return entries.map(({ fn }) => fn)
}

export function pairFunctions(
  base: readonly FlatFunction[],
  head: readonly FlatFunction[],
  keyOf: (side: CcccSide, fn: FlatFunction) => string | undefined = () => undefined,
): FunctionPair[] {
  const pairs: FunctionPair[] = []
  const usedBase = new Set<FlatFunction>()
  const usedHead = new Set<FlatFunction>()
  const keyed = (side: CcccSide, functions: readonly FlatFunction[]) => {
    const map = new Map<string, FlatFunction[]>()
    for (const fn of functions) {
      const key = keyOf(side, fn)
      if (key !== undefined) map.set(key, [...(map.get(key) ?? []), fn])
    }
    return map
  }

  const baseKeys = keyed("base", base)
  for (const [key, heads] of keyed("head", head)) {
    const bases = baseKeys.get(key)
    if (heads.length !== 1 || bases?.length !== 1) continue
    pairs.push({ base: bases[0]!, head: heads[0]! })
    usedBase.add(bases[0]!)
    usedHead.add(heads[0]!)
  }

  const named = (functions: readonly FlatFunction[], used: Set<FlatFunction>) => {
    const map = new Map<string, FlatFunction[]>()
    for (const fn of functions) {
      if (used.has(fn)) continue
      const key = `${fn.name}\0${fn.kind}`
      map.set(key, [...(map.get(key) ?? []), fn])
    }
    return map
  }
  const baseNamed = named(base, usedBase)
  for (const [key, heads] of named(head, usedHead)) {
    const bases = baseNamed.get(key)
    if (!bases) continue
    const candidates = heads.flatMap((headFn) =>
      bases.map((baseFn) => ({
        headFn,
        baseFn,
        distance: Math.abs(headFn.line - baseFn.line),
      })),
    )
    candidates.sort(
      (a, b) =>
        a.distance - b.distance || a.headFn.line - b.headFn.line || a.baseFn.line - b.baseFn.line,
    )
    for (const candidate of candidates) {
      if (usedHead.has(candidate.headFn) || usedBase.has(candidate.baseFn)) continue
      usedHead.add(candidate.headFn)
      usedBase.add(candidate.baseFn)
      pairs.push({ base: candidate.baseFn, head: candidate.headFn })
    }
  }
  return pairs.sort((a, b) => a.head.line - b.head.line)
}

export function overlapsChangedLine(
  lines: readonly number[] | undefined,
  start: number,
  end: number,
): boolean {
  return lines?.some((line) => Number.isInteger(line) && line >= start && line <= end) ?? false
}

export function increased(pair: FunctionPair): boolean {
  return pair.head.cyclomatic > pair.base.cyclomatic || pair.head.cognitive > pair.base.cognitive
}

export function findingFor(pair: FunctionPair, settings: CcccSettings): CcccFunctionFinding {
  const cyclomatic = {
    base: pair.base.cyclomatic,
    head: pair.head.cyclomatic,
    delta: pair.head.cyclomatic - pair.base.cyclomatic,
  }
  const cognitive = {
    base: pair.base.cognitive,
    head: pair.head.cognitive,
    delta: pair.head.cognitive - pair.base.cognitive,
  }
  const above =
    pair.head.cyclomatic > settings.complexity.cyclomatic ||
    pair.head.cognitive > settings.complexity.cognitive
  const primary =
    above ||
    cyclomatic.delta >= settings.complexity.primaryDelta ||
    cognitive.delta >= settings.complexity.primaryDelta
  const complexityAxis =
    Math.round(
      Math.min(
        1,
        Math.max(
          0,
          cyclomatic.delta / settings.complexity.cyclomatic,
          cognitive.delta / settings.complexity.cognitive,
        ),
      ) * 1000,
    ) / 1000
  return {
    name: pair.head.name,
    kind: pair.head.kind,
    location: {
      path: pair.head.path,
      line: pair.head.line,
      endLine: pair.head.endLine,
    },
    base: { path: pair.base.path, line: pair.base.line, endLine: pair.base.endLine },
    cyclomatic,
    cognitive,
    severity: above ? "warning" : "info",
    tier: primary ? "primary" : "supporting",
    complexityAxis,
  }
}

export function functionTotals(functions: readonly FlatFunction[]) {
  return functions.reduce(
    (totals, fn) => {
      totals.functions += 1
      totals.cyclomatic += fn.cyclomatic
      totals.cognitive += fn.cognitive
      return totals
    },
    { functions: 0, cyclomatic: 0, cognitive: 0 },
  )
}
