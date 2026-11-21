import type { FallowDisposition, FallowFinding, FallowPackage } from "./contract.ts"
import { contextOf, errorsOf, warningsOf } from "./audit-findings.ts"

/**
 * The one renderer of a `FallowPackage` into text: the repair prompt, the Architect notice and
 * the `lz-fallow-audit` summary all come from here. It reads typed fields only.
 */

const REPAIR_LIMIT = 4000
const CONTEXT_SHOWN = 5
const WAIVER_KINDS = 3

function location(finding: FallowFinding): string {
  return finding.endLine
    ? `${finding.file}:${finding.line}-${finding.endLine}`
    : `${finding.file}:${finding.line}`
}

/** `complexity src/a.ts:12 \`fn\` cognitive 31 (limit 15), was 12.` */
export function findingLine(finding: FallowFinding): string {
  const symbol = finding.symbol && finding.class !== "diff-risk" ? ` \`${finding.symbol}\`` : ""
  const exemption = finding.gateExemption ? ` [${finding.gateExemption}: never fails]` : ""
  const estimated = finding.estimatedCrap ? " [CRAP estimated]" : ""
  const waived = finding.suppression
    ? ` [suppresses ${finding.suppression.kinds.join(", ") || "everything"}; ${finding.suppression.reason ? `reason: ${finding.suppression.reason}` : "NO REASON GIVEN"}]`
    : ""
  return `${finding.rule} ${location(finding)}${symbol} ${finding.message}${exemption}${estimated}${waived}`
}

function numbered(findings: readonly FallowFinding[], start: number, room: number) {
  const lines: string[] = []
  let used = 0
  for (const [index, finding] of findings.entries()) {
    const line = `${start + index}. ${findingLine(finding)}${finding.suggestion ? `\n   ${finding.suggestion}` : ""}`
    if (used + line.length > room) break
    lines.push(line)
    used += line.length + 1
  }
  return { lines, hidden: findings.length - lines.length }
}

function waiver(findings: readonly FallowFinding[]): string {
  const comments = [...new Set(findings.flatMap((f) => (f.suppress ? [f.suppress.comment] : [])))]
  if (comments.length === 0) return ""
  const shown = comments.slice(0, WAIVER_KINDS).map((comment) => `\`${comment} -- <reason>\``)
  const ahead = [
    ...new Set(
      findings.flatMap((f) => (f.class === "dead-code" && f.suppress ? [f.suppress.comment] : [])),
    ),
  ]
  // Code added deliberately ahead of the task that will use it carries the comment, naming that task.
  const aheadText = ahead.length
    ? ` Code you add deliberately ahead of the task that will use it takes the comment with the consumer named: ${ahead
        .slice(0, WAIVER_KINDS)
        .map((comment) => `\`${comment} -- consumed by <task reference>\``)
        .join(" or ")}; the Architect reads every such reason.`
    : ""
  return `To waive any other finding on purpose, only when the Architect says so: ${shown.join(" or ")}.${aheadText}`
}

function summaryLine(pkg: FallowPackage): string {
  const { errors, warnings, inherited } = pkg.summary
  return `Fallow audit verdict ${pkg.verdict}: ${errors} error${errors === 1 ? "" : "s"} and ${warnings} warning${warnings === 1 ? "" : "s"} introduced by this task${inherited ? `, ${inherited} already in the touched files` : ""}.`
}

function notChecked(pkg: FallowPackage): string[] {
  return pkg.config.classesNotChecked.length
    ? [
        `Not checked: ${pkg.config.classesNotChecked.map((c) => `${c.class} (${c.reason})`).join("; ")}.`,
      ]
    : []
}

/**
 * The text of the one repair: errors to fix, warnings to consider (fix, or say in one line why
 * they stay), inherited findings as context.
 */
export function renderRepair(pkg: FallowPackage): string {
  const errors = errorsOf(pkg)
  const warnings = warningsOf(pkg)
  const context = contextOf(pkg)
  const closing = [
    "Fix these inside your write scope. Do not add fallow-ignore comments to hide a finding.",
    waiver([...errors, ...warnings]),
  ]
    .filter(Boolean)
    .join(" ")
  const room = REPAIR_LIMIT - 1200
  const out = [summaryLine(pkg)]
  const share = Math.max(600, Math.floor(room / (warnings.length ? 2 : 1)))
  if (errors.length) {
    const { lines, hidden } = numbered(errors, 1, share)
    out.push("Errors, fix these:", ...lines)
    if (hidden) out.push(`...and ${hidden} more errors; run lz-fallow-audit for the list.`)
  }
  if (warnings.length) {
    const { lines, hidden } = numbered(warnings, errors.length + 1, share)
    out.push("Warnings, consider fixing: fix each, or say in one line why you leave it:", ...lines)
    if (hidden) out.push(`...and ${hidden} more warnings; run lz-fallow-audit for the list.`)
  }
  if (context.length) {
    out.push(
      `Context, not introduced by this task (${pkg.summary.inherited} in the touched files; do not fix unless you must):`,
      ...context.slice(0, CONTEXT_SHOWN).map((f) => `- ${findingLine(f)}`),
    )
  }
  out.push(...notChecked(pkg), closing)
  return out.join("\n").slice(0, REPAIR_LIMIT)
}

const NOTICE_LIMIT = 10

/** What the Architect reads about an accepted task: what remained, and what the repair did. */
export function renderNotice(
  pkg: FallowPackage,
  dispositions: readonly FallowDisposition[] | undefined,
): string {
  const lines = [summaryLine(pkg)]
  const live = [...errorsOf(pkg), ...warningsOf(pkg)]
  if (live.length)
    lines.push(
      ...live.slice(0, NOTICE_LIMIT).map((f) => `- ${f.severity} ${findingLine(f)}`),
      ...(live.length > NOTICE_LIMIT ? [`- ...and ${live.length - NOTICE_LIMIT} more`] : []),
    )
  if (dispositions?.length) {
    const count = (d: FallowDisposition["disposition"]) =>
      dispositions.filter((x) => x.disposition === d).length
    lines.push(
      `After the repair: ${count("fixed")} fixed, ${count("remaining")} remaining, ${count("suppressed")} suppressed.`,
    )
    for (const d of dispositions.filter((x) => x.disposition !== "fixed").slice(0, NOTICE_LIMIT))
      lines.push(
        `- ${d.severity} ${d.findingID}: ${d.disposition}${
          d.reason ? `, reason: ${d.reason}` : d.severity === "warn" ? ", no reason stated" : ""
        }`,
      )
  }
  lines.push(...notChecked(pkg))
  return lines.join("\n")
}
