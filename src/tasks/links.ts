import { sameProject } from "../project-key.ts"
import type { Link, LinkHandler, SessionRef } from "@opencode/plugin/gui"
import { TaskReferenceSchema } from "../task.ts"

const taskLinkPrefix = ".lazers/tasks/"

const projectIDIsValid = (projectID: string) =>
  projectID.length >= 1 &&
  projectID.length <= 200 &&
  /\S/.test(projectID) &&
  // oxlint-disable-next-line no-control-regex -- Reject controls in encoded project identities.
  !/[\u0000-\u001f\u007f-\u009f]/u.test(projectID)

export function encodeProjectID(projectID: string): string {
  return Array.from(new TextEncoder().encode(projectID), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
}

function decodeProjectID(value: string): string | undefined {
  if (!/^(?:[0-9a-f]{2})+$/u.test(value)) return undefined
  try {
    const bytes = Uint8Array.from(value.match(/.{2}/gu)!, (byte) => Number.parseInt(byte, 16))
    const projectID = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return projectIDIsValid(projectID) && encodeProjectID(projectID) === value
      ? projectID
      : undefined
  } catch {
    return undefined
  }
}

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
  return `[${parsedReference}](${taskLinkPrefix}${encodeProjectID(projectID)}/${parsedReference})`
}

export function parseTaskLink(href: string): ParsedTaskLink | undefined {
  if (!href.startsWith(taskLinkPrefix)) return undefined
  const parts = href.slice(taskLinkPrefix.length).split("/")
  if (parts.length !== 2) return undefined
  const [encodedProjectID, reference] = parts
  const projectID = decodeProjectID(encodedProjectID!)
  if (!projectID || !TaskReferenceSchema.safeParse(reference).success) return undefined
  return { reference: reference!, projectID }
}

function ownsTaskLink(href: string) {
  return href.startsWith(taskLinkPrefix)
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
        !sameProject(detail.task.provenance.projectID, project.id) ||
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
    // Own even malformed LAZERS paths so the generic file handler cannot open them.
    priority: 100,
    match: (link) => ownsTaskLink(link.href),
    exists: async (link) => Boolean(await resolve(link)),
    open: (link) => {
      void resolve(link).then((target) => {
        if (target) services.open(target)
      })
    },
  }
}
