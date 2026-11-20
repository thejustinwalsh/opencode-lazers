import type { PlanningAgentId, PlanningFinding } from "./contract.ts"
import type { PlanningBody } from "./draft.ts"

const GLOB = /[*?[\]{}]/

type Scope = { writeScope: string[]; createScope: string[] }

function scopeOf(proposal: unknown): Scope {
  const value = (proposal && typeof proposal === "object" ? proposal : {}) as Record<
    string,
    unknown
  >
  const strings = (input: unknown) =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : []
  const create = Array.isArray(value.createScope)
    ? value.createScope.flatMap((entry) =>
        entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string"
          ? [(entry as { path: string }).path]
          : [],
      )
    : []
  return { writeScope: strings(value.writeScope), createScope: create }
}

/**
 * Files a draft may write that the repository map does not list, as findings with no model. A
 * path is fine when it is in the map, or is created by the draft (a `createScope` file, or under a
 * `createScope` folder). A glob must match a map path or sit under a created folder.
 */
export function pathCheck(
  body: PlanningBody,
  mapPaths: ReadonlySet<string>,
  mapHash = "unknown",
): PlanningFinding[] {
  const findings: PlanningFinding[] = []
  let n = 0
  for (const task of body.tasks) {
    const { writeScope, createScope } = scopeOf(task.proposal)
    const created = (path: string) =>
      createScope.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry))
    for (const path of writeScope) {
      const glob = GLOB.test(path)
      const literal = glob ? path.slice(0, path.search(GLOB)) : path
      const ok = glob
        ? created(literal) || [...mapPaths].some((known) => new Bun.Glob(path).match(known))
        : mapPaths.has(path) || created(path)
      if (ok) continue
      findings.push({
        id: `P${++n}`,
        severity: "major",
        confidence: "confirmed",
        target: { unit: task.draftID, field: "write-scope" },
        what: `${path} is in the write scope but not in the repository map.`,
        failureScenario: `A worker cannot edit ${path} because no such file exists, so the task cannot be completed as written.`,
        evidence: [`${path} is not in the repository map (hash ${mapHash})`],
        suggestion: `Correct the path, or list it under createScope if the task creates it.`,
      })
    }
  }
  return findings
}

/** One deterministic rule that adds an agent to the review. Data, so a rule is a line to add. */
export const AGENT_RULES = [
  {
    id: "stored-data",
    agent: "critic" as PlanningAgentId,
    test: /(^|\/)(migrations?|schema)(\/|\.|$)|database-schema\.ts$|\.sql$/,
  },
] as const

/** The agents a plan's written paths add, with the rule that added each. */
export function rulesAdd(body: PlanningBody): { agent: PlanningAgentId; ruleID: string }[] {
  const out: { agent: PlanningAgentId; ruleID: string }[] = []
  for (const rule of AGENT_RULES) {
    const hit = body.tasks.some((task) => {
      const { writeScope, createScope } = scopeOf(task.proposal)
      return [...writeScope, ...createScope].some((path) => rule.test.test(path))
    })
    if (hit) out.push({ agent: rule.agent, ruleID: rule.id })
  }
  return out
}

/** The paths a repository map lists: the lines under its "Source files:" heading, `path: names`. */
export function mapPathsOf(mapText: string): Set<string> {
  const paths = new Set<string>()
  let inFiles = false
  for (const line of mapText.split("\n")) {
    if (line.startsWith("Source files:")) {
      inFiles = true
      continue
    }
    if (!inFiles) continue
    const colon = line.indexOf(": ")
    if (colon > 0 && !line.startsWith(" ")) paths.add(line.slice(0, colon))
  }
  return paths
}
