import { sameProject } from "../project-key.ts"
import type { Link, LinkHandler, SessionRef } from "@opencode/plugin/gui"
import { decodeProjectID, encodeProjectID, resolveLinkProject } from "../tasks/links.ts"

const PLAN_LINK_PREFIX = ".lazers/plans/"

/** `[Full plan](.lazers/plans/<hex(projectID)>/<planningID>)`, distinct per plan and project. */
export function planMarkdownLink(planningID: string, projectID: string): string {
  return `[Full plan](${PLAN_LINK_PREFIX}${encodeProjectID(projectID)}/${planningID})`
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type ParsedPlanLink = { planningID: string; projectID: string }

export function parsePlanLink(href: string): ParsedPlanLink | undefined {
  if (!href.startsWith(PLAN_LINK_PREFIX)) return undefined
  const parts = href.slice(PLAN_LINK_PREFIX.length).split("/")
  if (parts.length !== 2) return undefined
  const projectID = decodeProjectID(parts[0]!)
  if (!projectID || !UUID.test(parts[1]!)) return undefined
  return { planningID: parts[1]!, projectID }
}

export type PlanLinkTarget = {
  session: SessionRef
  sessionDirectory: string
  projectDirectory: string
  planningID: string
}

export type PlanLinkDetail =
  | { status: "found"; planningID: string; projectKey: string; projectDirectory: string }
  | { status: "not_found" }

export interface PlanLinkServices {
  session(source: SessionRef): SessionRef | undefined
  project(session: SessionRef, signal: AbortSignal): Promise<{ id: string; canonical: string }>
  get(session: SessionRef, planningID: string, signal: AbortSignal): Promise<PlanLinkDetail>
  signal(): AbortSignal
  open(target: PlanLinkTarget): void
}

/**
 * Opens a stored plan from a chat link, in the plan's own project only. Like task links it owns
 * every `.lazers/plans/` path, malformed ones included, so the generic file handler never sees
 * them, and a plan of another project resolves to nothing.
 */
export function createPlanLinkHandler(services: PlanLinkServices): LinkHandler {
  async function resolve(link: Link): Promise<PlanLinkTarget | undefined> {
    const parsed = parsePlanLink(link.href)
    const source = link.session
    if (!parsed || !source) return undefined
    try {
      const found = await resolveLinkProject(services, source, parsed.projectID)
      if (!found) return undefined
      const { session, location, signal, project } = found
      const detail = await services.get(session, parsed.planningID, signal)
      if (
        signal.aborted ||
        detail.status !== "found" ||
        detail.planningID !== parsed.planningID ||
        !sameProject(detail.projectKey, project.id) ||
        detail.projectDirectory !== project.canonical
      )
        return undefined
      return {
        session,
        sessionDirectory: location.directory,
        projectDirectory: project.canonical,
        planningID: detail.planningID,
      }
    } catch {
      return undefined
    }
  }
  return {
    priority: 100,
    match: (link) => link.href.startsWith(PLAN_LINK_PREFIX),
    exists: async (link) => Boolean(await resolve(link)),
    open: (link) => {
      void resolve(link).then((target) => {
        if (target) services.open(target)
      })
    },
  }
}
