import type { FallowAnalyzer } from "./analyzer.ts"
import type { FallowFinding, FallowPackage } from "./contract.ts"
import { runGit } from "./config.ts"

/**
 * Code added ahead of its consumer carries `// fallow-ignore-next-line unused-export -- consumed
 * by <task reference>`. The engine reports the comment when it is added (`added-suppression`, with
 * its reason, or none) and reports it as a stale suppression once the code it covers is used. Two
 * things the engine's audit does not do are added here: it hides a stale suppression in a file the
 * change did not touch (the consumer's own audit), and it has no notion of a suppression the plan
 * never paid back.
 */

/** Suppression kinds that stand for code deliberately left unused. */
export const AHEAD_KINDS = [
  "unused-export",
  "unused-file",
  "unused-type",
  "unused-class-member",
  "unused-enum-member",
]

type StaleItem = {
  path: string
  line: number
  origin?: { issue_kind?: string; reason?: string; is_file_level?: boolean }
}

const staleKey = (item: StaleItem) =>
  `${item.path}\0${item.origin?.issue_kind ?? ""}\0${item.origin?.reason ?? ""}`

function staleItems(report: unknown): StaleItem[] {
  const list = (report as { stale_suppressions?: unknown }).stale_suppressions
  return Array.isArray(list) ? (list as StaleItem[]) : []
}

export function staleFinding(item: StaleItem): FallowFinding {
  const kind = item.origin?.issue_kind ?? "a finding"
  const reason = item.origin?.reason
  return {
    id: `dead-code:stale-suppression:${item.path}:${kind}:${reason ?? ""}`,
    rule: "stale-suppression",
    class: "dead-code",
    severity: "warn",
    attribution: "introduced",
    file: item.path,
    line: item.line,
    message: `the code this ${kind} suppression covers is used now${reason ? ` (reason given: ${reason})` : ""}; remove the comment`,
    suppression: {
      kinds: item.origin?.issue_kind ? [item.origin.issue_kind] : [],
      ...(reason ? { reason } : {}),
    },
    suggestion: "Delete the fallow-ignore comment: its consumer has arrived.",
  }
}

/** Whether any file carries a fallow-ignore comment; a repository with none needs no extra pass. */
export async function hasSuppressionComments(workspace: string): Promise<boolean> {
  const found = await runGit(workspace, "grep", "--untracked", "-l", "fallow-ignore-")
  return found !== undefined && found.trim().length > 0
}

/**
 * Stale suppressions the change made stale: present in the head's whole-repository dead-code
 * results and not in the base's. The consumer of code that was added ahead of it leaves the
 * comment in a file it never touched; this is how its own audit tells it to remove it.
 */
export async function staleSuppressionsIntroduced(input: {
  analyzer: FallowAnalyzer
  workspace: string
  baseRoot: string
  configPath?: string
  cacheSeed?: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<FallowFinding[]> {
  if (!(await hasSuppressionComments(input.workspace))) return []
  const scope = (root: string) => ({
    root,
    configPath: input.configPath,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    ...(root === input.workspace
      ? { cacheSeed: input.cacheSeed, cachePublish: input.cacheSeed }
      : { cacheSeed: input.workspace }),
  })
  const [head, base] = await Promise.all([
    input.analyzer.deadCode(scope(input.workspace)),
    input.analyzer.deadCode(scope(input.baseRoot)),
  ])
  const before = new Set(staleItems(base).map(staleKey))
  return staleItems(head)
    .filter((item) => !before.has(staleKey(item)))
    .map(staleFinding)
}

/** Adds findings to a package, skipping any already there (same rule, file and line). */
export function withExtraFindings(
  pkg: FallowPackage,
  extra: readonly FallowFinding[],
): FallowPackage {
  const seen = new Set(pkg.findings.map((f) => `${f.rule}\0${f.file}\0${f.line}`))
  const fresh = extra.filter((f) => !seen.has(`${f.rule}\0${f.file}\0${f.line}`))
  if (fresh.length === 0) return pkg
  const warnings = pkg.summary.warnings + fresh.filter((f) => f.severity === "warn").length
  const errors = pkg.summary.errors + fresh.filter((f) => f.severity === "error").length
  return {
    ...pkg,
    verdict: pkg.verdict === "pass" ? (errors ? "fail" : "warn") : pkg.verdict,
    findings: [...fresh, ...pkg.findings],
    summary: { ...pkg.summary, errors, warnings },
  }
}

/**
 * Suppressions this plan added for code left unused, still present at the plan's end, whose
 * suppressed code is still unused: the promised consumer never arrived. A suppression the engine
 * reports as stale is the other case (the consumer arrived and left the comment), already a finding.
 */
export function unconsumedSuppressions(pkg: FallowPackage): FallowFinding[] {
  const stale = new Set(
    pkg.findings.filter((f) => f.rule === "stale-suppression").map((f) => `${f.file}\0${f.line}`),
  )
  return pkg.findings
    .filter(
      (f) =>
        f.rule === "added-suppression" &&
        f.suppression?.kinds.some((kind) => AHEAD_KINDS.includes(kind)) &&
        !stale.has(`${f.file}\0${f.line}`),
    )
    .map((f) => ({
      id: `dead-code:unconsumed-suppression:${f.file}:${f.suppression!.kinds.join(",")}:${f.suppression!.reason ?? ""}`,
      rule: "unconsumed-suppression",
      class: "dead-code" as const,
      severity: "warn" as const,
      attribution: "introduced" as const,
      file: f.file,
      line: f.line,
      message: `added by this plan and still unused at its end: the consumer ${f.suppression!.reason ? `named in the reason (${f.suppression!.reason})` : "(no reason was given)"} never used it`,
      suppression: f.suppression,
      suggestion: "Send the task that should consume it back, or remove the code and its comment.",
    }))
}

const DECLARATION =
  /(?:export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum|abstract class)\s+)([A-Za-z_$][\w$]*)/

/** The name declared on the first code line below a suppression comment. */
export async function suppressedSymbol(
  workspace: string,
  file: string,
  commentLine: number,
): Promise<string | undefined> {
  const source = await Bun.file(`${workspace}/${file}`)
    .text()
    .catch(() => undefined)
  if (!source) return undefined
  for (const line of source.split("\n").slice(commentLine)) {
    if (/^\s*(\/\/|\/\*|\*|$)/.test(line)) continue
    return DECLARATION.exec(line)?.[1]
  }
  return undefined
}
