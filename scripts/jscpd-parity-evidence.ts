export interface ParityEvidence {
  minimumBasePairs?: number
  requiredBasePaths?: readonly string[]
  excludedBasePaths?: readonly string[]
  minimumFindings?: number
  minimumIgnoredFiles?: number
}

export interface NativeParityPair {
  first: { path: string }
  second: { path: string }
}

export type NativeParityReports = readonly {
  clones: readonly NativeParityPair[]
}[]

export interface PackagedParityResult {
  findings: readonly unknown[]
  coverage: {
    base: { filesIgnored: number }
    head: { filesIgnored: number }
  }
}

function assertMinimumCount(count: number, minimum: number | undefined, message: string): void {
  if (minimum !== undefined && count < minimum) throw new Error(message)
}

function assertMinimumIgnoredFiles(
  name: string,
  minimum: number | undefined,
  coverage: PackagedParityResult["coverage"],
): void {
  if (
    minimum !== undefined &&
    (coverage.base.filesIgnored < minimum || coverage.head.filesIgnored < minimum)
  )
    throw new Error(`Packaged provider did not apply captured filters in parity case ${name}.`)
}

export function assertNativePathEvidence(
  name: string,
  paths: ReadonlySet<string>,
  required: readonly string[],
  excluded: readonly string[],
): void {
  const missing = required.find((path) => !paths.has(path))
  if (missing !== undefined)
    throw new Error(`Pinned jscpd omitted expected configured path in parity case ${name}.`)

  const included = excluded.find((path) => paths.has(path))
  if (included !== undefined)
    throw new Error(`Pinned jscpd scanned an excluded configured path in parity case ${name}.`)
}

export function assertParityEvidence(
  name: string,
  evidence: ParityEvidence | undefined,
  baseReports: NativeParityReports,
  result: PackagedParityResult,
): number {
  const basePairs = baseReports.flatMap((report) => report.clones)
  const paths = new Set(basePairs.flatMap((pair) => [pair.first.path, pair.second.path]))
  assertMinimumCount(
    basePairs.length,
    evidence?.minimumBasePairs,
    `Pinned jscpd returned too few base clones in parity case ${name}.`,
  )
  assertMinimumCount(
    result.findings.length,
    evidence?.minimumFindings,
    `Packaged provider returned too few findings in parity case ${name}.`,
  )
  assertMinimumIgnoredFiles(name, evidence?.minimumIgnoredFiles, result.coverage)
  assertNativePathEvidence(
    name,
    paths,
    evidence?.requiredBasePaths ?? [],
    evidence?.excludedBasePaths ?? [],
  )
  return basePairs.length
}
