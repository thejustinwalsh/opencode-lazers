import { isAbsolute } from "node:path"
import { z } from "zod"

/**
 * The task's scope model. `edit` is `writeScope`: existing files the worker may modify. `create`
 * is the Architect's intended structure: where new code belongs. `protected` is the one hard
 * boundary. An amendment adds edit patterns (`amended`, a subset of `edit`) and may release an
 * exact protected path (`released`).
 */
export type ScopeModel = {
  edit: readonly string[]
  amended?: readonly string[]
  create: readonly { path: string; purpose: string }[]
  protected: readonly string[]
  released?: readonly string[]
}

export type ChangeStatus = "added" | "modified" | "deleted"
export type ScopeChange = { path: string; status: ChangeStatus; added?: number; removed?: number }

export type ScopeClass = "in-scope" | "expected-new" | "allowed-new" | "divergence" | "protected"

export type ClassifiedChange = ScopeChange & {
  class: ScopeClass
  /** In scope only because the Architect amended the scope for it. */
  viaAmendment?: true
}

const globs = new Map<string, Bun.Glob>()
function matches(pattern: string, path: string): boolean {
  let glob = globs.get(pattern)
  if (!glob) {
    glob = new Bun.Glob(pattern)
    globs.set(pattern, glob)
  }
  return glob.match(path)
}

const normalize = (pattern: string) => pattern.replaceAll("\\", "/").replace(/^\.\//, "")
const WILDCARD = /[*?{}[\]!]/

/** Every path the worker may not touch regardless of scope: outside the repository. */
function escapesRepository(path: string): boolean {
  return isAbsolute(path) || path.split("/").includes("..")
}

/**
 * The directory a scope pattern locates: an exact file's folder, or the literal folder prefix of
 * a glob. The empty string is the repository root, which allows only root-level files.
 */
export function patternDirectory(pattern: string): string {
  const normalized = normalize(pattern)
  const wildcard = normalized.search(WILDCARD)
  const prefix = wildcard < 0 ? normalized : normalized.slice(0, wildcard)
  if (wildcard < 0 && normalized.endsWith("/")) return normalized.replace(/\/+$/, "")
  const slash = prefix.lastIndexOf("/")
  return slash < 0 ? "" : prefix.slice(0, slash)
}

function inDirectory(path: string, directory: string): boolean {
  return directory === "" ? !path.includes("/") : path.startsWith(`${directory}/`)
}

/** An exact path, a glob, or a folder (`dir/`, or `dir` that contains the path). */
function matchesCreate(entry: string, path: string): boolean {
  const pattern = normalize(entry)
  if (pattern.endsWith("/")) return path.startsWith(pattern)
  return matches(pattern, path) || (!WILDCARD.test(pattern) && path.startsWith(`${pattern}/`))
}

const SOURCE_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "mts", "cts"]
export const TEST_PATH = /\.(test|spec)\.[a-z]+$/
const FIXTURE_SEGMENTS = new Set(["fixtures", "__fixtures__", "__snapshots__", "testdata"])

/** Source files a test path conventionally covers: beside it, or mirrored under src/. */
function sourceCandidates(path: string): string[] {
  if (!TEST_PATH.test(path)) return []
  const stem = path.replace(TEST_PATH, "")
  const candidates = SOURCE_EXTENSIONS.map((extension) => `${stem}.${extension}`)
  const segments = stem.split("/")
  const tests = segments.indexOf("__tests__")
  if (tests >= 0) {
    const parent = [...segments.slice(0, tests), ...segments.slice(tests + 1)].join("/")
    candidates.push(...SOURCE_EXTENSIONS.map((extension) => `${parent}.${extension}`))
  }
  if (segments[0] === "test" || segments[0] === "tests") {
    const mirrored = segments.slice(1).join("/")
    for (const extension of SOURCE_EXTENSIONS)
      candidates.push(`src/${mirrored}.${extension}`, `${mirrored}.${extension}`)
  }
  return candidates
}

/**
 * A test or fixture that sits beside or mirrors a scoped source file by this repository's
 * conventions (`x.test.ts` beside `x.ts`, `test/a/x.test.ts` for `src/a/x.ts`, `fixtures/` in a
 * scoped folder).
 */
function isCompanion(path: string, scoped: readonly string[], directories: readonly string[]) {
  if (sourceCandidates(path).some((source) => scoped.some((pattern) => matches(pattern, source))))
    return true
  const segments = path.split("/")
  const fixture = segments.findIndex((segment) => FIXTURE_SEGMENTS.has(segment))
  if (fixture < 0) return false
  const base = segments.slice(0, fixture).join("/")
  const mirrored = /^tests?(\/|$)/.test(base) ? base.replace(/^tests?/, "src") : undefined
  return directories.some(
    (directory) =>
      directory === base ||
      directory === mirrored ||
      (directory !== "" && base.startsWith(`${directory}/`)),
  )
}

/** The pure rule for one changed path. Protected wins over everything. */
export function classifyChange(change: ScopeChange, model: ScopeModel): ClassifiedChange {
  const { path } = change
  const result = (value: ScopeClass, viaAmendment?: true): ClassifiedChange => ({
    ...change,
    class: value,
    ...(viaAmendment ? { viaAmendment } : {}),
  })
  if (escapesRepository(path)) return result("protected")
  if (
    model.protected.some((pattern) => matches(normalize(pattern), path)) &&
    !model.released?.includes(path)
  )
    return result("protected")
  const amended = new Set(model.amended ?? [])
  const original = model.edit.filter((pattern) => !amended.has(pattern))
  const added = change.status === "added"
  if (added && model.create.some((entry) => matchesCreate(entry.path, path)))
    return result("expected-new")
  if (original.some((pattern) => matches(normalize(pattern), path))) return result("in-scope")
  if (model.edit.some((pattern) => matches(normalize(pattern), path)))
    return result("in-scope", true)
  const scoped = [...model.edit, ...model.create.map((entry) => entry.path)].map(normalize)
  const directories = [
    ...model.edit.map(patternDirectory),
    ...model.create.map((entry) => patternDirectory(entry.path)),
  ]
  const companion = isCompanion(path, scoped, directories)
  if (added)
    return directories.some((directory) => inDirectory(path, directory)) || companion
      ? result("allowed-new")
      : result("divergence")
  return companion ? result("in-scope") : result("divergence")
}

export function classifyChanges(changes: readonly ScopeChange[], model: ScopeModel) {
  return changes.map((change) => classifyChange(change, model))
}

/** The hard boundary alone: paths no scope decision other than an exact amendment can admit. */
export function protectedPaths(
  paths: readonly string[],
  guard: Pick<ScopeModel, "protected" | "released">,
): string[] {
  return paths.filter(
    (path) =>
      escapesRepository(path) ||
      (guard.protected.some((pattern) => matches(normalize(pattern), path)) &&
        !guard.released?.includes(path)),
  )
}

export type ScopeGuard = Pick<ScopeModel, "protected" | "released">

/** What reserving the task's scope means: it may edit these and expects to create these. */
export function reservationPatterns(
  edit: readonly string[],
  create: readonly { path: string }[],
): string[] {
  return [
    ...new Set([
      ...edit,
      ...create.map((entry) => {
        const path = normalize(entry.path)
        return path.endsWith("/") ? `${path}**` : path
      }),
    ]),
  ]
}

/** Another task whose scope covers a path, so a change there risks an overlap. */
export type ScopeOwner = { taskID: string; patterns: readonly string[] }

export function scopedBy(path: string, owners: readonly ScopeOwner[]): string[] {
  return owners
    .filter((owner) => owner.patterns.some((pattern) => matchesCreate(pattern, path)))
    .map((owner) => owner.taskID)
}

// ---- The recorded report -------------------------------------------------------------------

/** Source files over this many lines are what the size signal reports on. */
export const FILE_SIZE_WARNING_LINES = 1_000
/** Net lines added to a file already over the limit that count as substantial. */
const LARGE_FILE_GROWTH_LINES = 40
export const SIZED_SOURCE = /\.(ts|tsx|js|jsx|mjs|mts|cts)$/

const PathText = z.string().min(1)
export const ScopeReport = z.strictObject({
  attemptID: z.string(),
  created: z.array(
    z.strictObject({
      path: PathText,
      class: z.enum(["expected-new", "allowed-new"]),
      purpose: z.string().optional(),
      /** Other tasks whose edit or create scope also covers this new file. */
      scopedBy: z.array(z.string()).optional(),
    }),
  ),
  missingExpected: z.array(z.strictObject({ path: PathText, purpose: z.string() })),
  divergences: z.array(
    z.strictObject({
      path: PathText,
      status: z.enum(["added", "modified", "deleted"]),
      added: z.number().optional(),
      removed: z.number().optional(),
      scopedBy: z.array(z.string()),
    }),
  ),
  /** Divergences the Architect already accepted by amending the scope. */
  accepted: z.array(z.strictObject({ path: PathText, reason: z.string() })),
  warnings: z.array(
    z.strictObject({
      path: PathText,
      lines: z.number(),
      baseLines: z.number(),
      added: z.number(),
      kind: z.enum(["crossed", "grew"]),
    }),
  ),
})
export type ScopeReport = z.infer<typeof ScopeReport>

/** Nothing to tell the Architect or the worker. */
export function scopeReportEmpty(report: ScopeReport): boolean {
  return (
    !report.created.length &&
    !report.missingExpected.length &&
    !report.divergences.length &&
    !report.accepted.length &&
    !report.warnings.length
  )
}

export function sizeWarning(input: {
  path: string
  lines: number
  baseLines: number
  added: number
  removed: number
}): ScopeReport["warnings"][number] | undefined {
  if (!SIZED_SOURCE.test(input.path) || TEST_PATH.test(input.path)) return undefined
  if (input.lines <= FILE_SIZE_WARNING_LINES) return undefined
  const base = {
    path: input.path,
    lines: input.lines,
    baseLines: input.baseLines,
    added: input.added,
  }
  if (input.baseLines <= FILE_SIZE_WARNING_LINES) return { ...base, kind: "crossed" }
  return input.added - input.removed >= LARGE_FILE_GROWTH_LINES
    ? { ...base, kind: "grew" }
    : undefined
}

/** The report of one candidate from its classified changes. */
export function buildScopeReport(input: {
  attemptID: string
  model: ScopeModel
  classified: readonly ClassifiedChange[]
  owners: readonly ScopeOwner[]
  amendmentReasons: readonly string[]
  warnings: ScopeReport["warnings"]
}): ScopeReport {
  const purpose = (path: string) =>
    input.model.create.find((entry) => matchesCreate(entry.path, path))?.purpose
  const created = input.classified
    .filter((change) => change.class === "expected-new" || change.class === "allowed-new")
    .map((change) => ({
      path: change.path,
      class: change.class as "expected-new" | "allowed-new",
      ...(purpose(change.path) ? { purpose: purpose(change.path)! } : {}),
      ...(scopedBy(change.path, input.owners).length
        ? { scopedBy: scopedBy(change.path, input.owners) }
        : {}),
    }))
  const addedPaths = input.classified.filter((c) => c.status === "added").map((c) => c.path)
  const missingExpected = input.model.create
    .filter((entry) => !addedPaths.some((path) => matchesCreate(entry.path, path)))
    .map((entry) => ({ path: entry.path, purpose: entry.purpose }))
  const divergences = input.classified
    .filter((change) => change.class === "divergence")
    .map((change) => ({
      path: change.path,
      status: change.status,
      ...(change.added !== undefined ? { added: change.added } : {}),
      ...(change.removed !== undefined ? { removed: change.removed } : {}),
      scopedBy: scopedBy(change.path, input.owners),
    }))
  const reason = input.amendmentReasons.join(" | ")
  const accepted = input.classified
    .filter((change) => change.viaAmendment)
    .map((change) => ({ path: change.path, reason }))
  return {
    attemptID: input.attemptID,
    created,
    missingExpected,
    divergences,
    accepted,
    warnings: [...input.warnings],
  }
}

// ---- Text ----------------------------------------------------------------------------------

const PATH_LIMIT = 20
const REASON_PATH_LIMIT = 6

function divergenceLine(item: ScopeReport["divergences"][number]): string {
  const counts = item.added !== undefined ? ` +${item.added} -${item.removed ?? 0}` : ""
  const owner = item.scopedBy.length
    ? `; also in the scope of task ${item.scopedBy.join(", ")} (overlap risk)`
    : ""
  return `${item.path} (${item.status === "added" ? "new file" : `existing file, ${item.status}`}${counts}${owner})`
}

function warningLine(item: ScopeReport["warnings"][number]): string {
  return item.kind === "crossed"
    ? `${item.path} is now ${item.lines} lines (was ${item.baseLines}), over ${FILE_SIZE_WARNING_LINES}`
    : `${item.path} is ${item.lines} lines and grew by ${item.added}`
}

/** The worker's final message, quoted and bounded; the Architect judges from its own words. */
function workerReason(message: string | undefined): string {
  const text = message?.replace(/\s+/g, " ").trim()
  if (!text) return "no reason given"
  return `"${text.length > 400 ? `${text.slice(0, 400)}…` : text}" (final message)`
}

/** How the hold reason of a divergence begins; the notice that carries it adds the runbook. */
export const DIVERGENCE_REASON_PREFIX = "Scope divergence needs a decision"

/** The one-line hold reason for a divergence nobody decided. */
export function divergenceReason(report: ScopeReport, workerMessage?: string): string {
  const shown = report.divergences.slice(0, REASON_PATH_LIMIT).map(divergenceLine)
  const more = report.divergences.length - shown.length
  return `${DIVERGENCE_REASON_PREFIX}: ${report.divergences.length} change(s) outside the task's scope: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}. Worker's reason: ${workerReason(workerMessage)}. Accept with amend-scope and a reason, send it back with retained-repair, or cancel.`
}

/** What the one repair tells the worker about scope and size. Empty when nothing applies. */
export function scopeRepairText(report: ScopeReport): string {
  const parts: string[] = []
  if (report.divergences.length)
    parts.push(
      `These changes are outside the task's scope: move/remove them or say why they are needed.\n${report.divergences
        .slice(0, PATH_LIMIT)
        .map((item) => `- ${divergenceLine(item)}`)
        .join("\n")}`,
    )
  if (report.warnings.length)
    parts.push(
      `Consider splitting these files; put the new code in a separate, well-named file or folder:\n${report.warnings
        .map((item) => `- ${warningLine(item)}`)
        .join("\n")}`,
    )
  return parts.join("\n\n")
}

/** What an accepted task tells the Architect about the structure the worker built. */
export function scopeNotice(report: ScopeReport | undefined): string {
  if (!report || scopeReportEmpty(report)) return ""
  const lines: string[] = []
  if (report.created.length)
    lines.push(
      `New files (no decision needed):\n${report.created
        .slice(0, PATH_LIMIT)
        .map(
          (item) =>
            `- ${item.path} (${item.class === "expected-new" ? `expected${item.purpose ? `: ${item.purpose}` : ""}` : "beside scoped files"}${item.scopedBy?.length ? `; also in the scope of task ${item.scopedBy.join(", ")} (overlap risk)` : ""})`,
        )
        .join("\n")}`,
    )
  if (report.missingExpected.length)
    lines.push(
      `Expected but not created:\n${report.missingExpected.map((item) => `- ${item.path} — ${item.purpose}`).join("\n")}`,
    )
  if (report.accepted.length)
    lines.push(
      `Divergences accepted by scope amendment (${report.accepted[0]!.reason}):\n${report.accepted
        .slice(0, PATH_LIMIT)
        .map((item) => `- ${item.path}`)
        .join("\n")}`,
    )
  if (report.warnings.length)
    lines.push(
      `Size warnings (consider splitting):\n${report.warnings.map((item) => `- ${warningLine(item)}`).join("\n")}`,
    )
  return `\nScope review of the accepted change:\n${lines.join("\n")}`
}
