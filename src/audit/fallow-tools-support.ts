import type {
  DeadCodeReport,
  DuplicationReport,
  HealthFinding,
  HealthReport,
} from "@fallow-cli/fallow-node"
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { classMembersRuleEnabled } from "./config.ts"

export type Paging = { limit: number; offset: number }

export function page<T>(
  items: readonly T[],
  paging: Paging,
): { items: T[]; total: number; nextOffset: number | null } {
  const total = items.length
  const items_ = items.slice(paging.offset, paging.offset + paging.limit)
  return {
    items: items_,
    total,
    nextOffset: paging.offset + paging.limit < total ? paging.offset + paging.limit : null,
  }
}

export function dupesGroups(report: DuplicationReport) {
  return report.clone_groups
    .slice()
    .sort((a, b) => b.token_count - a.token_count)
    .map((group, index) => {
      const first = group.instances[0]!
      return {
        id: `${first.file}:${first.start_line}:${index}`,
        lines: group.line_count,
        tokens: group.token_count,
        instances: group.instances
          .slice(0, 5)
          .map((i) => ({ file: i.file, startLine: i.start_line, endLine: i.end_line })),
        moreInstances: Math.max(0, group.instances.length - 5),
      }
    })
}

export type HealthSort = "cognitive" | "cyclomatic" | "lines"

function healthSortKey(finding: HealthFinding, sort: HealthSort): number {
  return sort === "lines" ? finding.line_count : finding[sort]
}

export function healthFunctions(report: HealthReport, sort: HealthSort) {
  return report.findings
    .slice()
    .sort((a, b) => healthSortKey(b, sort) - healthSortKey(a, sort))
    .map((f) => ({
      file: f.path,
      line: f.line,
      name: f.name,
      cyclomatic: f.cyclomatic,
      cognitive: f.cognitive,
      lines: f.line_count,
      exceeded: Boolean(f.exceeded),
    }))
}

export type DeadCodeFindingKind = "file" | "export" | "type" | "dependency" | "member"

type DeadCodeOut = { kind: DeadCodeFindingKind; file: string; line: number; name: string }

/** Unused class members are left out unless the effective config explicitly turns the rule on. */
export function deadCodeFindings(
  report: DeadCodeReport,
  config: object | null,
  kinds?: readonly DeadCodeFindingKind[],
) {
  const memberEnabled = classMembersRuleEnabled(config)
  const groups: DeadCodeOut[] = [
    ...report.unused_files.map((f) => ({
      kind: "file" as const,
      file: f.path,
      line: 1,
      name: f.path,
    })),
    ...report.unused_exports.map((f) => ({
      kind: "export" as const,
      file: f.path,
      line: f.line,
      name: f.export_name,
    })),
    ...report.unused_types.map((f) => ({
      kind: "type" as const,
      file: f.path,
      line: f.line,
      name: f.export_name,
    })),
    ...report.unused_dependencies.map((f) => ({
      kind: "dependency" as const,
      file: f.path,
      line: f.line,
      name: f.package_name,
    })),
    ...(memberEnabled
      ? report.unused_class_members.map((f) => ({
          kind: "member" as const,
          file: f.path,
          line: f.line,
          name: `${f.parent_name}.${f.member_name}`,
        }))
      : []),
  ]
  const filtered = kinds ? groups.filter((g) => kinds.includes(g.kind)) : groups
  return filtered.map((g, index) => ({ id: `${g.kind}:${g.file}:${g.name}:${index}`, ...g }))
}

export function draftFallowConfig(entryPoints: readonly string[]): object {
  return { entry: [...entryPoints].sort(), rules: { "unused-class-members": "off" } }
}

const ENTRY_POINT_SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  ".cache",
  ".worktrees",
  ".claude",
])
const WORKER_PATTERN = /new\s+Worker\(|workerURL/

async function walk(directory: string, root: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".fallowrc.json") continue
    if (entry.isDirectory()) {
      if (ENTRY_POINT_SKIP_DIRECTORIES.has(entry.name)) continue
      files.push(...(await walk(join(directory, entry.name), root)))
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      files.push(relative(root, join(directory, entry.name)))
    }
  }
  return files
}

/**
 * Best-effort entry points the runtime can see: fixtures, CLIs, files referenced by
 * `new Worker(...)`/`workerURL`, and `package.json` scripts that run a `.ts` file directly.
 */
export async function detectEntryPoints(workspace: string): Promise<string[]> {
  const files = await walk(workspace, workspace)
  const found = new Set<string>()
  for (const file of files) {
    if (file.endsWith(".fixture.ts") || file.endsWith("/cli.ts") || file === "cli.ts")
      found.add(file)
  }
  for (const file of files) {
    const text = await readFile(join(workspace, file), "utf8").catch(() => "")
    if (WORKER_PATTERN.test(text)) found.add(file)
  }
  const manifest = await readFile(join(workspace, "package.json"), "utf8")
    .then((text) => JSON.parse(text) as { scripts?: Record<string, string> })
    .catch(() => undefined)
  for (const command of Object.values(manifest?.scripts ?? {})) {
    const match = /\b([\w./-]+\.ts)\b/.exec(command)
    if (match && files.includes(match[1]!)) found.add(match[1]!)
  }
  return [...found].sort()
}
