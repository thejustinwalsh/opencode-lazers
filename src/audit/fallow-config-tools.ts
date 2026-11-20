import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { z } from "zod"
import type { FallowAnalyzer } from "./analyzer.ts"
import { DEAD_CODE_CLASSES } from "./audit-findings.ts"
import { DEAD_CODE_LISTS } from "./engine-audit.ts"
import type { FallowConfigSuggestOutput, FallowDryRunOutput } from "./contract.ts"
import { thresholdsFrom } from "./config.ts"
import { detectEntryPoints } from "./fallow-tools-support.ts"

type Evidence = z.infer<typeof FallowConfigSuggestOutput>["evidence"][number]

/** Directories that are build output, caches, generated or vendored code in most projects. */
const IGNORE_CANDIDATES = [
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "generated",
  "__generated__",
  "vendor",
  "storybook-static",
]

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(exportTargets)
  if (value && typeof value === "object") return Object.values(value).flatMap(exportTargets)
  return []
}

/** package.json `main`, `module`, `bin` and `exports` targets that are source files. */
function manifestEntries(manifest: Record<string, unknown>): { file: string; from: string }[] {
  const found: { file: string; from: string }[] = []
  for (const key of ["main", "module", "types", "bin", "exports"])
    for (const file of exportTargets(manifest[key]))
      if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(file))
        found.push({ file: file.replace(/^\.\//, ""), from: `package.json ${key}` })
  return found
}

type ProjectInfo = {
  plugins?: string[]
  entry_points?: { path: string; source?: string }[]
}

/**
 * A proposed Fallow config for the project, with the evidence for each part. The engine reports
 * the plugins and entry points it detects without any config; this adds what it cannot see:
 * package.json targets and scripts, worker and CLI files, build and vendor directories,
 * workspaces. Nothing is stored.
 */
export async function suggestFallowConfig(
  workspace: string,
  project: string,
  analyzer: FallowAnalyzer,
): Promise<z.infer<typeof FallowConfigSuggestOutput>> {
  const info = (await analyzer.projectInfo({ root: workspace })) as ProjectInfo
  const evidence: Evidence[] = []
  const entry = new Set<string>()
  const add = (file: string, source: string, detail: string) => {
    if (entry.has(file)) return
    entry.add(file)
    evidence.push({ part: "entry", value: file, source, detail })
  }
  const sources: Record<string, number> = {}
  for (const point of info.entry_points ?? []) {
    const source = point.source ?? "engine"
    sources[source] = (sources[source] ?? 0) + 1
  }
  const manifest = await readJson(join(workspace, "package.json"))
  for (const target of manifest ? manifestEntries(manifest) : [])
    add(
      target.file,
      target.from,
      "published or run by package.json, never imported inside the project",
    )
  for (const file of await detectEntryPoints(workspace))
    add(
      file,
      "scan",
      "loaded by path (worker, CLI, fixture or package script); no import reaches it",
    )
  const names = await readdir(workspace).catch(() => [] as string[])
  const ignorePatterns = IGNORE_CANDIDATES.filter((name) => names.includes(name)).map(
    (name) => `${name}/**`,
  )
  for (const pattern of ignorePatterns)
    evidence.push({
      part: "ignorePatterns",
      value: pattern,
      source: "directory",
      detail: "build output, cache, generated or vendored code present in the project root",
    })
  const tsconfig = await readJson(join(workspace, "tsconfig.json"))
  const paths = (tsconfig?.compilerOptions as { paths?: object } | undefined)?.paths
  if (paths)
    evidence.push({
      part: "resolution",
      value: Object.keys(paths),
      source: "tsconfig.json paths",
      detail: "aliases the engine resolves itself; no config needed",
    })
  const workspaces = Array.isArray(manifest?.workspaces)
    ? (manifest.workspaces as string[])
    : ((manifest?.workspaces as { packages?: string[] } | undefined)?.packages ?? [])
  if (workspaces.length)
    evidence.push({
      part: "workspaces",
      value: workspaces,
      source: "package.json workspaces",
      detail: "each package is analysed with its own entry points",
    })
  const config: Record<string, unknown> = {
    entry: [...entry].sort(),
    ...(ignorePatterns.length ? { ignorePatterns } : {}),
    rules: { "unused-class-members": "off" },
  }
  evidence.push({
    part: "rules.unused-class-members",
    value: "off",
    source: "default policy",
    detail:
      "class-member findings were wrong 46 of 50 sampled times in this product's own repository; sample before turning it on",
  })
  return {
    project,
    config,
    evidence,
    detected: { plugins: info.plugins ?? [], entryPointSources: sources, workspaces },
    next: "Run lz-fallow-config with mode dry-run and this config (adjust it first), then lz-fallow-config-set with a one-line reason.",
  }
}

const SAMPLE = 15

/** Evenly spaced, so a sample of a ranked list is not only its head. */
function sampleOf<T>(items: readonly T[]): T[] {
  if (items.length <= SAMPLE) return [...items]
  return Array.from({ length: SAMPLE }, (_, i) => items[Math.floor((i * items.length) / SAMPLE)]!)
}

type Row = { file: string; line: number; subject: string }
const classOf = (name: string, rows: Row[]) => ({
  class: name,
  total: rows.length,
  sample: sampleOf(rows),
  sampledFrom: rows.length,
})

/**
 * The audit's classes run over the whole repository with an unsaved candidate: how many findings
 * each class would report, and an evenly spaced sample, so false positives show before the config
 * is saved.
 */
export async function dryRunFallowConfig(
  workspace: string,
  project: string,
  candidate: object,
  analyzer: FallowAnalyzer,
): Promise<z.infer<typeof FallowDryRunOutput>> {
  const directory = await mkdtemp(join(tmpdir(), "lz-fallow-dry-"))
  try {
    const configPath = join(directory, ".fallowrc.json")
    await writeFile(configPath, JSON.stringify(candidate), "utf8")
    const scope = { root: workspace, configPath }
    // One engine run when the analyzer has one (it shares the duplication report and is a single
    // queue entry); else the three separate calls. The engine's health report also lists
    // CRAP-only findings, which the complexity analysis does not, so they are left out here.
    const { dead, health, dupes } = analyzer.combined
      ? await analyzer.combined(scope).then((all) => ({
          dead: all.deadCode,
          health: {
            ...all.health,
            findings: all.health.findings.filter((f) => f.exceeded !== "crap"),
          },
          dupes: all.duplication,
        }))
      : await Promise.all([
          analyzer.deadCode(scope),
          analyzer.complexity(scope),
          analyzer.duplication(scope),
        ]).then(([dead, health, dupes]) => ({ dead, health, dupes }))
    const classes: z.infer<typeof FallowDryRunOutput>["classes"] = []
    const deadRecord = dead as unknown as Record<string, unknown[]>
    for (const list of DEAD_CODE_LISTS) {
      const descriptor = DEAD_CODE_CLASSES[list]
      const items = deadRecord[list]
      if (!descriptor || !Array.isArray(items) || items.length === 0) continue
      classes.push(
        classOf(
          `${descriptor.check}:${descriptor.kind}`,
          items.map((item) => descriptor.where(item as Record<string, unknown>)),
        ),
      )
    }
    // Ranked the same whichever analysis produced them, so the sample does not depend on the
    // order the engine happened to list them in.
    const ranked = [...health.findings].sort(
      (a, b) =>
        b.cognitive - a.cognitive ||
        b.cyclomatic - a.cyclomatic ||
        a.path.localeCompare(b.path) ||
        a.line - b.line,
    )
    const complexity = ranked.map((f) => ({
      file: f.path,
      line: f.line,
      subject: `${f.name} cyclomatic ${f.cyclomatic} cognitive ${f.cognitive}`,
    }))
    if (complexity.length) classes.push(classOf("complexity", complexity))
    const clones = dupes.clone_groups.map((g) => ({
      file: g.instances[0]!.file,
      line: g.instances[0]!.start_line,
      subject: `${g.line_count} lines in ${g.instances.length} places`,
    }))
    if (clones.length) classes.push(classOf("duplication", clones))
    return {
      project,
      classes: classes.sort((a, b) => b.total - a.total),
      thresholds: thresholdsFrom(candidate),
      next: "Open a few findings per class. If most are wrong, fix entry, ignorePatterns, ignoreExports or the rule, and dry-run again. When mostly true, lz-fallow-config-set with a reason.",
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}
