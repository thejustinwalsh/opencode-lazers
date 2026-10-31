import type { Link, LinkHandler, SessionRef } from "@opencode/plugin/gui"
import { TaskReferenceSchema } from "../task.ts"

const projectIDIsValid = (projectID: string) =>
  projectID.length >= 1 &&
  projectID.length <= 200 &&
  /\S/.test(projectID) &&
  // oxlint-disable-next-line no-control-regex -- Reject controls in encoded project identities.
  !/[\u0000-\u001f\u007f-\u009f]/u.test(projectID)

export type TaskLinkTarget = {
  session: SessionRef
  sessionDirectory: string
  projectDirectory: string
  taskID: string
}

type TaskLinkTask = {
  id: string
  provenance: { projectID: string; projectDirectory: string }
}

type TaskLinkDetail =
  | { status: "found"; reference: string; task: TaskLinkTask }
  | { status: "not_found" | "revision_unavailable" }

export type ParsedTaskLink = { reference: string; projectID: string }

export function taskMarkdownLink(reference: string, projectID: string): string {
  const parsedReference = TaskReferenceSchema.parse(reference)
  if (!projectIDIsValid(projectID)) throw new Error("Invalid task-link project identity")
  const url = new URL(`lazers://task/${parsedReference}`)
  url.searchParams.set("project", projectID)
  return `[${parsedReference}](${url.href})`
}

export function parseTaskLink(href: string): ParsedTaskLink | undefined {
  try {
    const url = new URL(href)
    if (
      url.protocol !== "lazers:" ||
      url.hostname !== "task" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash
    )
      return undefined
    const reference = decodeURIComponent(url.pathname.slice(1))
    const projects = url.searchParams.getAll("project")
    if (
      url.pathname !== `/${reference}` ||
      !TaskReferenceSchema.safeParse(reference).success ||
      projects.length !== 1 ||
      [...url.searchParams.keys()].length !== 1 ||
      !projectIDIsValid(projects[0] ?? "")
    )
      return undefined
    return { reference, projectID: projects[0]! }
  } catch {
    return undefined
  }
}

function ownsTaskLink(href: string) {
  try {
    return new URL(href).protocol === "lazers:"
  } catch {
    return /^lazers:/iu.test(href)
  }
}

export interface TaskLinkServices {
  /** Find the currently open session for this exact link origin. */
  session(source: SessionRef): SessionRef | undefined
  /** Resolve only the project location belonging to that live session. */
  project(session: SessionRef, signal: AbortSignal): Promise<{ id: string; canonical: string }>
  /** Resolve a project-local reference through the same task read boundary as the panel/tools. */
  get(session: SessionRef, reference: string, signal: AbortSignal): Promise<TaskLinkDetail>
  signal(): AbortSignal
  open(target: TaskLinkTarget): void
}

export function createTaskLinkHandler(services: TaskLinkServices): LinkHandler {
  async function resolve(link: Link): Promise<TaskLinkTarget | undefined> {
    const parsed = parseTaskLink(link.href)
    const source = link.session
    if (!parsed || !source) return undefined
    try {
      const session = services.session(source)
      if (!session?.location) return undefined
      const signal = services.signal()
      if (signal.aborted) return undefined
      const project = await services.project(session, signal)
      if (signal.aborted || project.id !== parsed.projectID) return undefined
      const detail = await services.get(session, parsed.reference, signal)
      if (
        signal.aborted ||
        detail.status !== "found" ||
        detail.reference !== parsed.reference ||
        detail.task.provenance.projectID !== project.id ||
        detail.task.provenance.projectDirectory !== project.canonical
      )
        return undefined
      return {
        session,
        sessionDirectory: session.location.directory,
        projectDirectory: project.canonical,
        taskID: detail.task.id,
      }
    } catch {
      return undefined
    }
  }

  return {
    // Own even malformed LAZERS URLs so the host never hands them to an OS URL handler.
    match: (link) => ownsTaskLink(link.href),
    exists: async (link) => Boolean(await resolve(link)),
    open: (link) => {
      void resolve(link).then((target) => {
        if (target) services.open(target)
      })
    },
  }
}
