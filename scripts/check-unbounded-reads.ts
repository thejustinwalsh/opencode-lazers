import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { schemaModules } from "../src/database-schema.ts"

/**
 * Source check for design/data-handling.md principles 1 and 8: no new `SELECT *` and no new
 * `.all()` without `LIMIT` against a history table, outside migrations and tests.
 *
 * A history table grows with use. The list is every table in `src/database-schema.ts` minus
 * `BOUNDED_TABLES`, which holds the tables whose row count is set by configuration, by the
 * number of projects, or by a fixed vocabulary, never by how long LAZERS has run. A table that is
 * queried but absent from the schema inventory counts as history until it is added to one list.
 *
 * Sites that exist today are listed in `scripts/unbounded-reads.allowlist`, one line each:
 * `file:line | kind | table | reason | statement`. A reason is why the read is bounded, or the
 * word `todo`. The check fails when a listed site disappears (delete its line, so the list
 * shrinks) and when a site that is not listed appears. Sites match on file, kind and statement
 * text, so a line number that drifts does not fail the check; `--update` rewrites the line numbers.
 */

/** Tables whose size does not grow with use. Each carries the reason. */
export const BOUNDED_TABLES: Record<string, string> = {
  schema_modules: "one row per schema module",
  lazers_settings: "one row per setting key",
  lazers_dispatch_pause: "one row per project",
  lazers_projects: "one row per project",
  lazers_project_aliases: "one row per project alias",
  lazers_project_paths: "one row per project path",
  retention_settings: "one row per setting key",
  runner_dispatch_controls: "one row per project",
  runner_architect_contact: "one row per project",
  runner_priority_migration: "one row, a migration marker",
  observation_revisions: "one row per project and source",
  host_message_cursors: "one row per live session",
  model_mappings: "one row per model, set by configuration",
  owned_resource_meta: "one row",
  probe_definition_heads: "one row per probe definition",
  lazers_profile_pins: "one row per project",
}

/** `star` is `SELECT *`; `all` is `.all()` with no LIMIT; `star+all` is both in one statement. */
export type SiteKind = "star" | "all" | "star+all"
export type Site = {
  file: string
  line: number
  kind: SiteKind
  table: string
  /** Normalized statement head, the identity of the site across line drift. */
  statement: string
  /** The whole normalized statement, for tooling; not stored in the allowlist. */
  sql?: string
}
export type AllowEntry = Site & { reason: string }

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const ALLOWLIST = join(ROOT, "scripts/unbounded-reads.allowlist")

export const historyTables = (): Set<string> => {
  const all = new Set<string>()
  for (const module of Object.values(schemaModules))
    for (const table of module.tables) all.add(table)
  for (const bounded of Object.keys(BOUNDED_TABLES)) all.delete(bounded)
  return all
}

export const isSourceFile = (path: string) =>
  /\.tsx?$/.test(path) &&
  !/\.test\.tsx?$/.test(path) &&
  !/\.fixture\.tsx?$/.test(path) &&
  !/(^|\/)test-[^/]*$/.test(path) &&
  !/(^|\/)migrat[^/]*$/.test(path)

export function walk(directory: string, found: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) walk(path, found)
    else if (isSourceFile(path)) found.push(path)
  }
  return found
}

/** Index just past the string literal that starts at `start` (a quote or backtick). */
export function skipString(text: string, start: number): number {
  const quote = text[start]!
  let i = start + 1
  while (i < text.length) {
    const c = text[i]!
    if (c === "\\") i += 2
    else if (c === quote) return i + 1
    else if (quote === "`" && c === "$" && text[i + 1] === "{") i = skipBraces(text, i + 1)
    else i++
  }
  return i
}

/** Index just past the `{...}` that starts at `start`. */
function skipBraces(text: string, start: number): number {
  let depth = 0
  let i = start
  while (i < text.length) {
    const c = text[i]!
    if (c === '"' || c === "'" || c === "`") i = skipString(text, i)
    else if (c === "{") (depth++, i++)
    else if (c === "}") {
      depth--
      i++
      if (depth === 0) return i
    } else i++
  }
  return i
}

/** Index just past the `)` that closes the `(` at `start`. */
function skipParens(text: string, start: number): number {
  let depth = 0
  let i = start
  while (i < text.length) {
    const c = text[i]!
    if (c === '"' || c === "'" || c === "`") i = skipString(text, i)
    else if (c === "/" && text[i + 1] === "/")
      i = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i)
    else if (c === "/" && text[i + 1] === "*") i = text.indexOf("*/", i) + 2
    else if (c === "(") (depth++, i++)
    else if (c === ")") {
      depth--
      i++
      if (depth === 0) return i
    } else i++
  }
  return i
}

const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim()
const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length

type Call = { start: number; end: number; sql: string; target: string | undefined }

/** Every `.query(...)` / `.prepare(...)` call, with its statement text and the name it is bound to. */
function statementCalls(text: string): Call[] {
  const calls: Call[] = []
  const constants = new Map<string, string>()
  for (const m of text.matchAll(/\bconst\s+(\w+)\s*=\s*(["'`])/g)) {
    const open = m.index! + m[0].length - 1
    constants.set(m[1]!, text.slice(open, skipString(text, open)))
  }
  for (const m of text.matchAll(/\.(?:query|prepare)\s*(<)?/g)) {
    let open = m.index! + m[0].length
    if (m[1]) {
      let depth = 1
      while (open < text.length && depth > 0) {
        if (text[open] === "<") depth++
        else if (text[open] === ">" && text[open - 1] !== "=") depth--
        open++
      }
      while (/\s/.test(text[open] ?? "")) open++
    }
    if (text[open] !== "(") continue
    const end = skipParens(text, open)
    let sql = text.slice(open + 1, end - 1)
    const identifier = /^\s*([A-Za-z_]\w*)\s*,?\s*$/.exec(sql)
    if (identifier && constants.has(identifier[1]!)) sql = constants.get(identifier[1]!)!
    const before = text.slice(Math.max(0, m.index! - 120), m.index!)
    const bound =
      /(?:const|let|var)\s+([\w#]+)\s*=\s*[\w#.]*\s*$/.exec(before) ??
      /([\w#.]+)\s*=\s*[\w#.]*\s*$/.exec(before)
    calls.push({ start: m.index!, end, sql, target: bound?.[1] })
  }
  return calls
}

const TABLE_REFERENCE = /\b(?:FROM|JOIN)\s+([A-Za-z_]\w*)/gi
const tablesOf = (sql: string) => [...sql.matchAll(TABLE_REFERENCE)].map((m) => m[1]!)

/** Where an enclosing function with a migration-ish name begins, so its statements are skipped. */
function migrationRanges(text: string): [number, number][] {
  const ranges: [number, number][] = []
  for (const m of text.matchAll(
    /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+(\w*(?:migrat|backfill)\w*)\b[^{]*\{/gim,
  )) {
    const open = m.index! + m[0].length - 1
    ranges.push([open, skipBraces(text, open)])
  }
  return ranges
}

export function scanFile(path: string, text: string, history: Set<string>, file = path): Site[] {
  const sites: Site[] = []
  const skip = migrationRanges(text)
  const inMigration = (index: number) => skip.some(([from, to]) => index >= from && index < to)
  const isHistory = (tables: string[]) =>
    tables.some(
      (t) =>
        history.has(t) ||
        (!BOUNDED_TABLES[t] && !/^(sqlite_|pragma_)/.test(t) && !allKnown.has(t) && !cte(t)),
    )
  const allKnown = new Set<string>(Object.values(schemaModules).flatMap((m) => m.tables))
  const cte = (name: string) =>
    new RegExp(`\\b${name}\\s+AS\\s*(?:NOT\\s+MATERIALIZED\\s*)?\\(`, "i").test(text)

  // Stars: textual, so statements held in constants and fragments count too.
  for (const m of text.matchAll(
    /SELECT\s+(?:DISTINCT\s+)?(?:[\w.,\s]*?\b\w+\.\*|\*)\s+FROM\s+([A-Za-z_]\w*)/gi,
  )) {
    if (inMigration(m.index!)) continue
    if (
      /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s*(?:\([^)]*\))?\s*$/i.test(
        text.slice(Math.max(0, m.index! - 200), m.index!),
      )
    )
      continue
    const tail = text.slice(m.index!, m.index! + 600).split(/[`"']/)[0]!
    const tables = tablesOf(tail)
    if (!isHistory(tables) || /\b(?:DROP|CREATE|ALTER)\s+(?:TABLE|INDEX|TRIGGER)\b/i.test(tail))
      continue
    sites.push({
      file,
      line: lineOf(text, m.index!),
      kind: "star",
      table: m[1]!,
      statement: normalize(tail).slice(0, 90).trimEnd(),
      sql: normalize(tail),
    })
  }

  // Unbounded `.all()`.
  const calls = statementCalls(text)
  for (const m of text.matchAll(/\.all\s*\(/g)) {
    const index = m.index!
    if (inMigration(index)) continue
    let k = index - 1
    while (k >= 0 && /\s/.test(text[k]!)) k--
    let call: Call | undefined
    if (text[k] === ")") call = calls.find((c) => c.end === k + 1)
    else {
      const name = /([\w#]+)$/.exec(text.slice(Math.max(0, k - 60), k + 1))?.[1]
      if (name) call = [...calls].reverse().find((c) => c.target === name && c.start < index)
    }
    if (!call) continue
    const sql = call.sql
    if (/\bLIMIT\b/i.test(sql)) continue
    if (/^\s*["'`]\s*PRAGMA/i.test(sql)) continue
    const tables = tablesOf(sql)
    if (tables.length === 0 || !isHistory(tables)) continue
    sites.push({
      file,
      line: lineOf(text, index),
      kind: "all",
      table: tables[0]!,
      statement: normalize(sql.replace(/^\s*["'`]/, "").replace(/["'`]\s*,?\s*$/, ""))
        .slice(0, 90)
        .trimEnd(),
      sql: normalize(sql),
    })
  }
  return mergeStatements(sites)
}

/** One statement that is both `SELECT *` and an unbounded `.all()` is one site, not two. */
function mergeStatements(sites: Site[]): Site[] {
  const merged: Site[] = []
  for (const site of sites) {
    const twin = merged.find(
      (other) =>
        other.file === site.file &&
        other.kind !== site.kind &&
        other.statement === site.statement &&
        Math.abs(other.line - site.line) <= 12,
    )
    if (twin) twin.kind = "star+all"
    else merged.push({ ...site })
  }
  return merged
}

export function scanSources(root = ROOT): Site[] {
  const history = historyTables()
  const sites: Site[] = []
  for (const path of walk(join(root, "src")).sort()) {
    const file = relative(root, path)
    sites.push(...scanFile(path, readFileSync(path, "utf8"), history, file))
  }
  return sites.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
}

const identity = (site: Pick<Site, "file" | "kind" | "statement">) =>
  `${site.file}\u0000${site.kind}\u0000${site.statement}`

export const formatEntry = (site: Site, reason: string) =>
  `${site.file}:${site.line} | ${site.kind} | ${site.table} | ${reason} | ${site.statement}`

export function parseAllowlist(text: string): AllowEntry[] {
  const entries: AllowEntry[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const [location, kind, table, reason, ...rest] = line.split(" | ")
    const at = location!.lastIndexOf(":")
    if (!kind || !table || !reason || (kind !== "star" && kind !== "all" && kind !== "star+all"))
      throw new Error(`Malformed allowlist line: ${line}`)
    entries.push({
      file: location!.slice(0, at),
      line: Number(location!.slice(at + 1)),
      kind,
      table,
      reason,
      statement: rest.join(" | "),
    })
  }
  return entries
}

export type Comparison = { unlisted: Site[]; stale: AllowEntry[]; matched: [Site, AllowEntry][] }

/** Match sites to allowlist entries one to one by file, kind and statement. */
export function compare(sites: Site[], entries: AllowEntry[]): Comparison {
  const pool = new Map<string, AllowEntry[]>()
  for (const entry of entries)
    pool.set(identity(entry), [...(pool.get(identity(entry)) ?? []), entry])
  const unlisted: Site[] = []
  const matched: [Site, AllowEntry][] = []
  for (const site of sites) {
    const list = pool.get(identity(site))
    const entry = list?.shift()
    if (entry) matched.push([site, entry])
    else unlisted.push(site)
  }
  return { unlisted, stale: [...pool.values()].flat(), matched }
}

export function renderAllowlist(sites: Site[], entries: AllowEntry[]): string {
  const { matched, unlisted } = compare(sites, entries)
  const reasons = new Map(matched.map(([site, entry]) => [site, entry.reason]))
  const header = [
    "# Reads that predate the source check (scripts/check-unbounded-reads.ts).",
    "# file:line | kind | table | reason | statement",
    "# kind: star = SELECT * on a history table, all = .all() with no LIMIT on one, star+all = both.",
    "# reason: why the read is bounded, or the word todo. Delete a line when its site is fixed.",
    "",
  ]
  return (
    [
      ...header,
      ...sites.map((site) =>
        formatEntry(site, reasons.get(site) ?? (unlisted.includes(site) ? "todo" : "todo")),
      ),
    ].join("\n") + "\n"
  )
}

export function report(result: Comparison): string[] {
  const problems: string[] = []
  for (const site of result.unlisted)
    problems.push(
      `new ${site.kind === "star" ? "SELECT *" : site.kind === "all" ? "unbounded .all()" : "SELECT * with unbounded .all()"} on ${site.table}: ${site.file}:${site.line}\n    ${site.statement}\n    Select the columns it needs and add LIMIT with a cursor, or use an aggregate or EXISTS (design/data-handling.md, principle 1).`,
    )
  for (const entry of result.stale)
    problems.push(
      `allowlist entry has no site any more, delete it: ${entry.file}:${entry.line} | ${entry.kind} | ${entry.table}`,
    )
  return problems
}

if (import.meta.main) {
  const sites = scanSources()
  const entries = parseAllowlist(readFileSync(ALLOWLIST, "utf8"))
  if (process.argv.includes("--update")) {
    writeFileSync(ALLOWLIST, renderAllowlist(sites, entries))
    const todo = sites.length
    console.log(`allowlist rewritten: ${todo} sites`)
  } else {
    const problems = report(compare(sites, entries))
    if (problems.length > 0) {
      console.error(problems.join("\n"))
      console.error(
        `\n${problems.length} problem(s). New sites are fixed, not listed; \`--update\` only refreshes line numbers.`,
      )
      process.exit(1)
    }
    const todo = entries.filter((entry) => entry.reason.startsWith("todo")).length
    console.log(`unbounded reads: ${entries.length} listed (${todo} todo)`)
  }
}
