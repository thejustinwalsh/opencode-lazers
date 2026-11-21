import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { skipString, walk } from "../../scripts/check-unbounded-reads.ts"

/**
 * Source check for the integer-key migration (`src/runner/identity-migration.ts`): once a history
 * table is keyed its text-id indexes are dropped, so a statement that filters or joins
 * `runner_transitions` or `runner_progress` on `plan_id` or `attempt_id` would scan the table.
 * Such predicates go through `planIs`, `planIn`, `attemptIs` or `attemptIn`
 * (`src/runner/identity-read.ts`), which keep the text form until the table is keyed.
 *
 * The check reads every SQL string literal in `src/` (tests and fixtures excluded) that names one
 * of the two tables and reports a predicate on a text id of that table: qualified by the table's
 * alias, or unqualified in a statement that reads no other table.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const HISTORY = /\b(runner_transitions|runner_progress)\b(?!_)/
const KEYWORDS = new Set(
  "WHERE JOIN ON ORDER GROUP LEFT INNER CROSS SET VALUES LIMIT NOT INDEXED AND OR USING AS WITH UNION SELECT FROM".split(
    " ",
  ),
)

/** Literal texts outside comments, each with its line. */
function literals(text: string): Array<{ line: number; sql: string }> {
  const found: Array<{ line: number; sql: string }> = []
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i)
      i = end < 0 ? text.length : end
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i) + 2
    } else if (c === '"' || c === "'" || c === "`") {
      const end = skipString(text, i)
      found.push({ line: text.slice(0, i).split("\n").length, sql: text.slice(i + 1, end - 1) })
      i = end
    } else i++
  }
  return found
}

export function textIDPredicates(sql: string): string[] {
  if (!HISTORY.test(sql)) return []
  if (/\b(CREATE|DROP)\s+(TABLE|INDEX|TRIGGER)\b/i.test(sql)) return []
  if (/^\s*INSERT\b[^]*\bVALUES\s*\(/i.test(sql)) return []
  const aliases = new Set<string>()
  for (const m of sql.matchAll(
    /\b(?:runner_transitions|runner_progress)\b(?!_)(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi,
  )) {
    const alias = m[1]
    if (alias && !KEYWORDS.has(alias.toUpperCase())) aliases.add(alias)
    aliases.add(m[0].split(/\s/)[0]!)
  }
  const froms = [...sql.matchAll(/\bFROM\s+([A-Za-z_]\w*)/gi)].map((m) => ({
    at: m.index!,
    table: m[1]!,
  }))
  // An unqualified column belongs to the nearest table read before it (its own SELECT's FROM).
  const nearestIsHistory = (at: number) => {
    const from = froms.filter((f) => f.at < at).at(-1)
    return from?.table === "runner_transitions" || from?.table === "runner_progress"
  }
  const hits: string[] = []
  const column = /(?:\b([A-Za-z_]\w*)\.)?\b(plan_id|attempt_id)\b/g
  for (const m of sql.matchAll(column)) {
    const before = sql.slice(Math.max(0, m.index! - 12), m.index!)
    const after = sql.slice(m.index! + m[0].length, m.index! + m[0].length + 8)
    const predicate = /^\s*(=|IN\b|IS\b|<>|!=)/i.test(after) || /(=|\bIS)\s*$/i.test(before)
    if (!predicate) continue
    const qualifier = m[1]
    if (qualifier ? aliases.has(qualifier) : nearestIsHistory(m.index!)) hits.push(m[0])
  }
  return hits
}

test("no statement filters or joins a history table on a text id", () => {
  const found: string[] = []
  for (const path of walk(join(ROOT, "src")).sort()) {
    const file = relative(ROOT, path)
    for (const { line, sql } of literals(readFileSync(path, "utf8"))) {
      const hits = textIDPredicates(sql)
      if (hits.length)
        found.push(`${file}:${line} ${hits.join(",")} :: ${sql.replace(/\s+/g, " ").slice(0, 120)}`)
    }
  }
  expect(found).toEqual([])
})

test("the check sees the shapes it is meant to", () => {
  expect(textIDPredicates("SELECT id FROM runner_transitions WHERE plan_id=? ORDER BY id")).toEqual(
    ["plan_id"],
  )
  expect(
    textIDPredicates(
      "SELECT t.payload FROM runner_transitions t JOIN runner_plans p ON p.id=t.plan_id WHERE p.x=?",
    ),
  ).toEqual(["t.plan_id"])
  expect(
    textIDPredicates(
      "SELECT seq FROM runner_progress WHERE project_directory=? AND attempt_id IN (?,?)",
    ),
  ).toEqual(["attempt_id"])
  // Not a predicate on the history table: another table's column, a result column, a key read.
  expect(
    textIDPredicates(
      "SELECT a.id FROM runner_attempts a JOIN runner_progress g ON g.seq=a.seq WHERE a.plan_id=?",
    ),
  ).toEqual([])
  expect(textIDPredicates("SELECT plan_id,attempt_id FROM runner_progress WHERE seq=?")).toEqual([])
  expect(
    textIDPredicates(
      'SELECT id FROM runner_transitions WHERE ${planIs(db, "runner_transitions")} AND task_id=?',
    ),
  ).toEqual([])
})
