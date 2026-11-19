import type { FallowDisposition, FallowPackage } from "./contract.ts"

const live = (pkg: FallowPackage) => pkg.findings.filter((f) => f.attribution !== "inherited")

/**
 * What became of each introduced finding of the first audit, read from the audit that ran after
 * the repair. A finding still reported is `remaining`; one that vanished is `fixed`, unless the
 * repair added a `fallow-ignore` comment that the engine reported (a diff-risk finding with a
 * parsed suppression in the same file naming the finding's rule), which makes it `suppressed`
 * with the reason text the comment carries. No prose is read.
 */
export function dispositionsAfterRepair(
  first: FallowPackage,
  after: FallowPackage,
): FallowDisposition[] {
  const remaining = new Set(live(after).map((f) => f.id))
  const waivers = after.findings.filter(
    (f) =>
      f.class === "diff-risk" &&
      f.rule === "added-suppression" &&
      f.symbol?.startsWith("suppressed:"),
  )
  return live(first).map((finding) => {
    if (remaining.has(finding.id))
      return {
        findingID: finding.id,
        severity: finding.severity,
        disposition: "remaining" as const,
      }
    const waiver = waivers.find((w) => w.file === finding.file)
    return waiver
      ? {
          findingID: finding.id,
          severity: finding.severity,
          disposition: "suppressed" as const,
          reason: waiver.symbol!.slice("suppressed:".length).trim() || undefined,
        }
      : { findingID: finding.id, severity: finding.severity, disposition: "fixed" as const }
  })
}
