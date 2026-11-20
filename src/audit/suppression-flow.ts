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

type Candidate = { path: string; line: number; name: string }

const MARKER_LINE = /fallow-ignore-(?:next-line|file)(.*)$/

/** Suppression comments that stand for code left unused: an unused-code kind, or no kind at all. */
async function aheadSuppressions(workspace: string): Promise<Candidate[]> {
  const found = await runGit(workspace, "grep", "-n", "--untracked", "fallow-ignore-")
  const candidates: Candidate[] = []
  for (const row of (found ?? "").split("\n")) {
    const [path, lineText, ...rest] = row.split(":")
    const marker = MARKER_LINE.exec(rest.join(":"))
    if (!path || !marker) continue
    const targets = marker[1]!.split("--")[0]!
    if (targets.trim() && !AHEAD_KINDS.some((kind) => targets.includes(kind))) continue
    const line = Number(lineText)
    const fileLevel = rest.join(":").includes("fallow-ignore-file")
    const name = fileLevel ? undefined : await suppressedSymbol(workspace, path, line)
    const stem = path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "")
    candidates.push({ path, line, name: name ?? stem })
  }
  return candidates
}

/** Added lines of the change per file (tracked diff, plus the content of untracked files). */
async function addedLinesByFile(workspace: string, base: string): Promise<Map<string, string[]>> {
  const added = new Map<string, string[]>()
  const diff = (await runGit(workspace, "diff", "-U0", base)) ?? ""
  let current = ""
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) current = line.replace(/^\+\+\+ (?:b\/)?/, "")
    else if (line.startsWith("+") && current)
      (added.get(current) ?? added.set(current, []).get(current)!).push(line.slice(1))
  }
  const untracked = (await runGit(workspace, "ls-files", "--others", "--exclude-standard")) ?? ""
  for (const path of untracked.split("\n").filter(Boolean)) {
    const text = await Bun.file(`${workspace}/${path}`)
      .text()
      .catch(() => "")
    added.set(path, text.split("\n"))
  }
  return added
}

const word = (name: string) => new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`)

/**
 * The suppressions this change may have made stale: a comment on unused code whose name the
 * change's added lines mention outside the file holding it. (One already stale at the base is
 * reported again to a second consumer; harmless, and it still needs removing.)
 */
async function possiblyConsumed(workspace: string, base: string): Promise<Candidate[]> {
  const comments = await aheadSuppressions(workspace)
  if (comments.length === 0) return []
  const added = await addedLinesByFile(workspace, base)
  const result: Candidate[] = []
  for (const candidate of comments) {
    const pattern = word(candidate.name)
    const mentioned = [...added].some(
      ([path, lines]) => path !== candidate.path && lines.some((line) => pattern.test(line)),
    )
    if (mentioned) result.push(candidate)
  }
  return result
}

/**
 * Stale suppressions the change made stale. The engine's audit hides them in files the change did
 * not touch, and the consumer of code added ahead of its consumer never touches that file; this is
 * how its own audit says "remove the comment". The rule: only when the change's added lines
 * mention the name under a suppression comment, one whole-
 * repository dead-code pass at head confirms which of those comments are stale now. A change
 * that mentions no suppressed name costs a `git grep` and nothing else.
 */
export async function staleSuppressionsIntroduced(input: {
  analyzer: FallowAnalyzer
  workspace: string
  base: string
  configPath?: string
  cacheSeed?: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<FallowFinding[]> {
  const candidates = await possiblyConsumed(input.workspace, input.base)
  if (candidates.length === 0) return []
  const head = await input.analyzer.deadCode({
    root: input.workspace,
    configPath: input.configPath,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    cacheSeed: input.cacheSeed,
    cachePublish: input.cacheSeed,
  })
  const at = new Set(candidates.map((c) => `${c.path}\0${c.line}`))
  return staleItems(head)
    .filter((item) => at.has(`${item.path}\0${item.line}`))
    .map(staleFinding)
}

/** Adds findings to a package, skipping any already there (same rule, file and line). */
export function withExtraFindings(
  pkg: FallowPackage,
  extra: readonly FallowFinding[],
): FallowPackage {
  const seen = new Set(pkg.findings.map((f) => `${f.rule}\0${f.file}\0${f.line}`))
  // Two comments of one kind and reason in one file share a base id; number the later ones, as the
  // package's own findings are, so a disposition can tell which one was fixed.
  const counts = new Map<string, number>()
  for (const f of pkg.findings) counts.set(f.id, 1)
  const fresh = extra
    .filter((f) => !seen.has(`${f.rule}\0${f.file}\0${f.line}`))
    .map((f) => {
      const count = (counts.get(f.id) ?? 0) + 1
      counts.set(f.id, count)
      return count === 1 ? f : { ...f, id: `${f.id}#${count}` }
    })
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
